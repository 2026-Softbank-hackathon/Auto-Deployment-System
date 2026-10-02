import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const runDir = process.argv[2];
if (!runDir) throw new Error("usage: node collect-ssm-db.mjs <run-dir>");

const instanceId = required("SSM_INSTANCE_ID");
const profile = process.env.AWS_PROFILE || "SB-hackathon";
const region = process.env.AWS_REGION || "ap-northeast-2";
const submissions = JSON.parse(await readFile(`${runDir}/submissions.json`, "utf8"));
const ids = submissions.map((row) => String(row.deploymentId)).filter((id) => /^\d+$/.test(id));
if (ids.length === 0) throw new Error("no numeric deployment IDs in submissions.json");

const numericIds = ids.join(",");
const textIds = ids.map((id) => `'${id}'`).join(",");
const queries = {
  deployments: `SELECT id::text, project_id::text, status, target_profile, created_at, updated_at, succeeded_at, failed_at, error FROM deployments WHERE id IN (${numericIds}) ORDER BY id`,
  buildArtifacts: `SELECT deployment_id::text, image_digest, immutable_ref, platform, strategy FROM build_artifacts WHERE deployment_id IN (${numericIds}) ORDER BY deployment_id`,
  steps: `SELECT deployment_id::text, step_name, status, started_at, finished_at, duration_ms FROM deployment_steps WHERE deployment_id IN (${numericIds}) ORDER BY deployment_id, started_at`,
  jobs: `SELECT COALESCE(data->>'deployment_id', data->>'deploymentId') AS deployment_id, name, state::text, created_on, started_on, completed_on, retry_count FROM pgboss.job WHERE COALESCE(data->>'deployment_id', data->>'deploymentId') IN (${textIds}) ORDER BY created_on`,
  agentJobs: `SELECT deployment_id::text, job_id, status, attempt, created_at, updated_at, lease_expires_at, error_code, jsonb_build_object('startedAt', result->>'startedAt', 'finishedAt', result->>'finishedAt', 'runningDigest', result->>'runningDigest') AS result FROM onprem_agent_jobs WHERE deployment_id IN (${numericIds}) ORDER BY created_at`,
  healthAttempts: `SELECT step.deployment_id::text, attempt.phase, COUNT(*)::int AS attempts, COUNT(*) FILTER (WHERE attempt.passed)::int AS passed, ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY attempt.latency_ms)::numeric, 2) AS latency_p95_ms, array_remove(array_agg(DISTINCT attempt.error_code), NULL) AS error_codes FROM health_check_attempts attempt JOIN deployment_steps step ON step.id = attempt.deployment_step_id WHERE step.deployment_id IN (${numericIds}) GROUP BY step.deployment_id, attempt.phase ORDER BY step.deployment_id, attempt.phase`,
  envLocks: `SELECT deployment_id::text, env_key, lease_expires_at, created_at FROM env_locks WHERE deployment_id IN (${numericIds}) ORDER BY created_at`,
  envLocksGlobal: `SELECT deployment_id::text, env_key, lease_expires_at, created_at FROM env_locks ORDER BY created_at`,
};

const parsed = {};
const commandIds = {};
for (const [name, sql] of Object.entries(queries)) {
  const command = [
    "set -e",
    "cd /opt/camellia/platform/infra/platform",
    `sudo docker compose -f compose.yaml --profile tunnel exec -T postgres psql -U camellia -d camellia -At -c \"SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json) FROM (${sql}) q;\"`,
  ].join("\n");
  const commandId = aws([
    "ssm", "send-command",
    "--instance-ids", instanceId,
    "--document-name", "AWS-RunShellScript",
    "--parameters", JSON.stringify({ commands: [command], executionTimeout: ["120"] }),
    "--query", "Command.CommandId",
    "--output", "text",
  ]);
  commandIds[name] = commandId;
  const invocation = await waitForInvocation(commandId);
  parsed[name] = JSON.parse(invocation.StandardOutputContent.trim() || "[]");
}

await writeFile(`${runDir}/db-metrics.json`, `${JSON.stringify({
  available: true,
  source: "aws-ssm",
  instanceId,
  collectedAt: new Date().toISOString(),
  commandIds,
  ...parsed,
}, null, 2)}\n`);
process.stdout.write(`[collect-ssm-db] deployments=${ids.join(",")} queries=${Object.keys(queries).length}\n`);

async function waitForInvocation(commandId) {
  let invocation;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await delay(2_000);
    try {
      invocation = JSON.parse(aws([
        "ssm", "get-command-invocation",
        "--instance-id", instanceId,
        "--command-id", commandId,
        "--output", "json",
      ]));
    } catch {
      continue;
    }
    if (["Success", "Failed", "Cancelled", "TimedOut"].includes(invocation.Status)) break;
  }
  if (!invocation) throw new Error(`SSM command ${commandId} did not return a result`);
  if (invocation.Status !== "Success") {
    throw new Error(`SSM ${invocation.Status}: ${invocation.StandardErrorContent || "unknown error"}`);
  }
  return invocation;
}

function aws(args) {
  return execFileSync("aws", ["--profile", profile, "--region", region, ...args], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
