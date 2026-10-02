import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

const outputPath = process.argv[2];
if (!outputPath) throw new Error("usage: node capture-local-runtime.mjs <output.json>");

const raw = execFileSync("docker", ["ps", "--format", "{{json .}}"], { encoding: "utf8" });
const containers = raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  .filter((row) => /^camellia-d\d+-/.test(row.Names))
  .map((row) => ({
    id: row.ID,
    image: row.Image,
    status: row.Status,
    name: row.Names,
    deploymentId: row.Names.match(/^camellia-d(\d+)-/)?.[1] ?? null,
  }));

const expectedMax = Number(process.env.EXPECTED_RUNTIME_COUNT ?? 2);
const result = {
  collectedAt: new Date().toISOString(),
  expectedMax,
  actualCount: containers.length,
  passed: containers.length <= expectedMax,
  containers,
};
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`[runtime] count=${containers.length} expected<=${expectedMax} passed=${result.passed}\n`);
if (!result.passed) process.exitCode = 1;
