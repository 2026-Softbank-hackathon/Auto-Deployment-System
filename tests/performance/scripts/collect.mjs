import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extractDeploymentEvents } from "../lib/metrics.mjs";

const runDir = process.argv[2];
if (!runDir) throw new Error("usage: node collect.mjs <run-dir>");

const k6Raw = await readFile(`${runDir}/k6-points.json`, "utf8").catch(() => "");
const submissions = extractDeploymentEvents(k6Raw);
await writeJson(`${runDir}/submissions.json`, submissions);

if (submissions.length === 0) {
  await writeJson(`${runDir}/deployments.json`, []);
  await writeJson(`${runDir}/db-metrics.json`, { available: false, reason: "no deployments" });
  process.stdout.write("[collect] deployment points 없음 — health-only 실행으로 기록합니다.\n");
  process.exit(0);
}

const apiBaseUrl = required("API_BASE_URL").replace(/\/$/, "");
const apiToken = required("API_TOKEN");
const pollIntervalMs = positiveNumber("POLL_INTERVAL_MS", 2_000);
const timeoutMs = positiveNumber("COLLECT_TIMEOUT_MS", 20 * 60_000);
const captureLogs = process.env.CAPTURE_LOGS !== "false";
const autoApproveGates = process.env.AUTO_APPROVE_GATES === "true";

const deployments = await Promise.all(submissions.map((submission) =>
  observeDeployment(submission, {
    apiBaseUrl,
    apiToken,
    pollIntervalMs,
    timeoutMs,
    captureLogs,
    autoApproveGates,
  })
));
await writeJson(`${runDir}/deployments.json`, deployments);
await writeJson(`${runDir}/db-metrics.json`, await collectDatabaseMetrics(submissions));

async function observeDeployment(submission, options) {
  const started = Date.now();
  const observations = [];
  let lastSignature = "";
  let pollErrors = 0;
  let snapshot = null;
  const approvedGates = new Set();

  while (Date.now() - started < options.timeoutMs) {
    try {
      snapshot = await getJson(`${options.apiBaseUrl}/deployments/${submission.deploymentId}`, options.apiToken);
      const signature = JSON.stringify({ status: snapshot.status, currentStep: snapshot.currentStep });
      if (signature !== lastSignature) {
        observations.push({
          observedAt: new Date().toISOString(),
          status: snapshot.status ?? null,
          updatedAt: snapshot.updatedAt ?? null,
          currentStep: snapshot.currentStep ?? null,
        });
        lastSignature = signature;
      }
      const pendingGate = snapshot.approvalPending?.gate
        ?? (snapshot.status === "awaiting_target_confirmation" ? "target" : null)
        ?? (snapshot.status === "awaiting_plan_approval" ? "plan" : null);
      if (
        options.autoApproveGates
        && (pendingGate === "target" || pendingGate === "plan")
        && !approvedGates.has(pendingGate)
      ) {
        await submitApproval(
          `${options.apiBaseUrl}/deployments/${submission.deploymentId}/approvals`,
          options.apiToken,
          pendingGate,
        );
        approvedGates.add(pendingGate);
        observations.push({
          observedAt: new Date().toISOString(),
          autoApprovedGate: pendingGate,
        });
      }
      if (isTerminal(snapshot.status)) break;
    } catch (error) {
      pollErrors += 1;
      observations.push({ observedAt: new Date().toISOString(), pollError: safeMessage(error) });
    }
    await delay(options.pollIntervalMs);
  }

  const timedOut = !snapshot || !isTerminal(snapshot.status);
  const health = await optionalJson(
    `${options.apiBaseUrl}/deployments/${submission.deploymentId}/health`,
    options.apiToken,
  );
  if (options.captureLogs) await captureStepLogs(submission.deploymentId, options);

  return {
    ...submission,
    pollIntervalMs: options.pollIntervalMs,
    pollErrors,
    timedOut,
    observations,
    final: snapshot,
    health,
    collectedAt: new Date().toISOString(),
  };
}

async function submitApproval(url, token, gate) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      gate,
      decision: "approve",
      note: "performance harness auto approval",
    }),
  });
  if (!response.ok) {
    throw new Error(`POST ${new URL(url).pathname}: HTTP ${response.status}`);
  }
}

async function captureStepLogs(deploymentId, options) {
  const logDir = `${runDir}/logs/${deploymentId}`;
  await mkdir(logDir, { recursive: true });
  for (const step of ["analyze", "build", "provision", "verify"]) {
    const response = await fetch(`${options.apiBaseUrl}/deployments/${deploymentId}/logs?step=${step}`, {
      headers: { Authorization: `Bearer ${options.apiToken}` },
    }).catch(() => null);
    if (!response || response.status === 204 || !response.ok) continue;
    const redacted = redact(await response.text());
    await writeFile(`${logDir}/${step}.log`, redacted.endsWith("\n") ? redacted : `${redacted}\n`);
  }
}

async function collectDatabaseMetrics(submissionRows) {
  if (!process.env.DATABASE_URL) {
    return { available: false, reason: "DATABASE_URL not provided" };
  }

  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5_000 });
  const ids = submissionRows.map((row) => row.deploymentId);
  try {
    const [deployments, steps, jobs, agentJobs, healthAttempts, envLocks] = await Promise.all([
      pool.query(
        `SELECT id::text, project_id::text, status, target_profile, created_at, updated_at,
                succeeded_at, failed_at, error
           FROM deployments WHERE id = ANY($1::bigint[]) ORDER BY id`,
        [ids],
      ),
      pool.query(
        `SELECT deployment_id::text, step_name, status, started_at, finished_at, duration_ms, message
           FROM deployment_steps WHERE deployment_id = ANY($1::bigint[])
          ORDER BY deployment_id, started_at`,
        [ids],
      ),
      pool.query(
        `SELECT COALESCE(data->>'deployment_id', data->>'deploymentId') AS deployment_id,
                name, state::text,
                created_on, started_on, completed_on, retry_count
           FROM pgboss.job
          WHERE COALESCE(data->>'deployment_id', data->>'deploymentId') = ANY($1::text[])
          ORDER BY created_on`,
        [ids],
      ),
      optionalQuery(pool,
        `SELECT deployment_id::text, job_id, status, attempt, created_at, updated_at,
                lease_expires_at, error_code, result
           FROM onprem_agent_jobs WHERE deployment_id = ANY($1::bigint[])
          ORDER BY created_at`,
        [ids],
      ),
      optionalQuery(pool,
        `SELECT deployment_id::text, env_key, lease_expires_at, created_at
           FROM env_locks WHERE deployment_id = ANY($1::bigint[])
          ORDER BY created_at`,
        [ids],
      ),
      optionalQuery(pool,
        `SELECT step.deployment_id::text, attempt.phase, attempt.attempt, attempt.checked_at,
                attempt.status_code, attempt.latency_ms, attempt.passed, attempt.error_code
           FROM health_check_attempts attempt
           JOIN deployment_steps step ON step.id = attempt.deployment_step_id
          WHERE step.deployment_id = ANY($1::bigint[])
          ORDER BY step.deployment_id, attempt.checked_at`,
        [ids],
      ),
    ]);
    return {
      available: true,
      collectedAt: new Date().toISOString(),
      deployments: deployments.rows,
      steps: steps.rows,
      jobs: jobs.rows,
      agentJobs,
      healthAttempts,
      envLocks,
    };
  } catch (error) {
    return { available: false, reason: safeMessage(error) };
  } finally {
    await pool.end();
  }
}

async function optionalQuery(pool, sql, params) {
  try {
    return (await pool.query(sql, params)).rows;
  } catch (error) {
    if (error?.code === "42P01" || error?.code === "42703") return [];
    throw error;
  }
}

async function getJson(url, token) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`GET ${new URL(url).pathname}: HTTP ${response.status}`);
  return response.json();
}

async function optionalJson(url, token) {
  try {
    return await getJson(url, token);
  } catch {
    return null;
  }
}

function isTerminal(status) {
  return ["succeeded", "failed", "cancelled", "rejected"].includes(status);
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveNumber(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function redact(value) {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:api|access|secret|session|registration)[_-]?(?:key|token)\s*[:=]\s*)[^\s,]+/gi, "$1[REDACTED]");
}

function safeMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
