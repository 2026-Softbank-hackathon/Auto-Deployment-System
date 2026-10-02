import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { writeFile } from "node:fs/promises";

const outputPath = process.argv[2];
if (!outputPath) throw new Error("usage: node agent-restart-check.mjs <output.json>");

const service = process.env.AGENT_SERVICE_PATH
  || `${homedir()}/Library/Application Support/Camellia/onprem-agent/bin/camellia-onprem-agent-service`;
const publicHealthUrl = required("PUBLIC_HEALTH_URL");
const containerPattern = new RegExp(process.env.CONTAINER_NAME_PATTERN || "^camellia-d");
const settleMs = Number(process.env.AGENT_RESTART_SETTLE_MS || 20_000);

const before = snapshot();
run(service, ["stop"]);
const duringStop = snapshot();
const healthWhileStopped = health(publicHealthUrl);
run(service, ["start"]);
await delay(settleMs);
const status = run(service, ["status"]);
const after = snapshot();
const healthAfterRestart = health(publicHealthUrl);

const beforeIds = new Set(before.containers.map((row) => row.id));
const preserved = after.containers.filter((row) => beforeIds.has(row.id));
const result = {
  collectedAt: new Date().toISOString(),
  settleMs,
  publicHealthUrl,
  before,
  duringStop,
  after,
  healthWhileStopped,
  healthAfterRestart,
  serviceRunning: /state = running/.test(status),
  preservedContainerCount: preserved.length,
  passed: before.containers.length > 0
    && preserved.length === before.containers.length
    && healthWhileStopped.status === 200
    && healthAfterRestart.status === 200
    && /state = running/.test(status),
};

await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`[agent-restart] preserved=${preserved.length}/${before.containers.length} stopped_health=${healthWhileStopped.status} restarted_health=${healthAfterRestart.status} passed=${result.passed}\n`);
if (!result.passed) process.exitCode = 1;

function snapshot() {
  const output = run("docker", ["ps", "--format", "{{json .}}"]);
  const containers = output.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    .filter((row) => containerPattern.test(row.Names))
    .map((row) => ({ id: row.ID, image: row.Image, name: row.Names, status: row.Status }));
  return { collectedAt: new Date().toISOString(), containers };
}

function health(url) {
  try {
    const output = run("curl", ["-fsS", "-o", "/dev/null", "-w", "%{http_code}", url]);
    return { checkedAt: new Date().toISOString(), status: Number(output) };
  } catch (error) {
    return { checkedAt: new Date().toISOString(), status: 0, error: String(error.message || error) };
  }
}

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }).trim();
}
function required(name) { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
