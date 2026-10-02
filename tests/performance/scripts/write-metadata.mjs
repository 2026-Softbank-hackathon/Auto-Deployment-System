import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { hostname, arch, platform, release } from "node:os";
import { basename, resolve } from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";

const runDir = process.argv[2];
if (!runDir) throw new Error("usage: node write-metadata.mjs <run-dir>");

await mkdir(runDir, { recursive: true });
const sourcePath = process.env.SOURCE_ZIP ? resolve(process.env.SOURCE_ZIP) : null;
const source = sourcePath ? await sourceMetadata(sourcePath) : null;
const metadata = {
  schemaVersion: 1,
  runId: process.env.TEST_RUN_ID ?? basename(runDir),
  startedAt: new Date().toISOString(),
  profile: process.env.PROFILE ?? "health",
  requestKind: process.env.REQUEST_KIND ?? (process.env.PROFILE === "health" ? "health" : "upload"),
  purpose: process.env.TEST_PURPOSE ?? null,
  apiBaseUrl: process.env.API_BASE_URL ?? "https://console.camellia-deploy.app",
  projectIds: csv(process.env.PROJECT_IDS),
  sourceDeploymentIds: csv(process.env.SOURCE_DEPLOYMENT_IDS),
  environmentIds: csv(process.env.ENVIRONMENT_IDS),
  targets: csv(process.env.TARGETS),
  cacheCondition: process.env.CACHE_CONDITION ?? "unspecified",
  expectedAcceptRate: numberOrNull(process.env.EXPECTED_ACCEPT_RATE) ?? 1,
  source,
  git: {
    commit: command("git", ["rev-parse", "HEAD"]),
    branch: command("git", ["branch", "--show-current"]),
    dirty: command("git", ["status", "--porcelain"]).length > 0,
  },
  loadGenerator: {
    hostname: hostname(),
    os: `${platform()} ${release()}`,
    arch: arch(),
    node: process.version,
    k6: command("k6", ["version"]),
  },
  parameters: publicEnvironment(),
  notes: process.env.TEST_NOTES ?? null,
};

await writeFile(`${runDir}/metadata.json`, `${JSON.stringify(metadata, null, 2)}\n`);

async function sourceMetadata(path) {
  const bytes = await readFile(path);
  return {
    filename: basename(path),
    bytes: (await stat(path)).size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function command(executable, args) {
  try {
    return execFileSync(executable, args, { encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
}

function csv(value) {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function publicEnvironment() {
  const allowed = [
    "ITERATIONS",
    "VUS",
    "MAX_DURATION",
    "HEALTH_P95_MS",
    "ACCEPT_P95_MS",
    "ARRIVAL_RATE",
    "ARRIVAL_TIME_UNIT",
    "ARRIVAL_DURATION",
    "PRE_ALLOCATED_VUS",
    "MAX_VUS",
    "POLL_INTERVAL_MS",
    "COLLECT_TIMEOUT_MS",
  ];
  return Object.fromEntries(allowed.flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []));
}
