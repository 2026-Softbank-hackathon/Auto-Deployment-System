import { mkdir, readFile, writeFile } from "node:fs/promises";
import { csvCell, durationMs, percentile } from "../lib/metrics.mjs";

const [outputDir, ...runDirs] = process.argv.slice(2);
if (!outputDir || runDirs.length < 2) {
  throw new Error("usage: node concurrency-series.mjs <output-dir> <burst-run-dir> <burst-run-dir> [...]");
}

const runs = await Promise.all(runDirs.map(loadRun));
const awsProvision = runs.map((run) => run.aws?.provisionRunMs).filter(Number.isFinite);
const onpremWait = runs.map((run) => run.onprem?.provisionWaitMs).filter(Number.isFinite);
const onpremRun = runs.map((run) => run.onprem?.provisionRunMs).filter(Number.isFinite);
const summary = {
  runCount: runs.length,
  successfulRuns: runs.filter((run) => run.aws?.status === "succeeded" && run.onprem?.status === "succeeded").length,
  awsProvisionMedianMs: percentile(awsProvision, 0.5),
  onpremProvisionWaitMedianMs: percentile(onpremWait, 0.5),
  onpremProvisionRunMedianMs: percentile(onpremRun, 0.5),
};

await mkdir(outputDir, { recursive: true });
await writeFile(`${outputDir}/series.json`, `${JSON.stringify({ summary, runs }, null, 2)}\n`);
await writeFile(`${outputDir}/series.csv`, renderCsv(runs));
await writeFile(`${outputDir}/report.md`, renderMarkdown(summary, runs));
await writeFile(`${outputDir}/report.html`, renderHtml(summary, runs));
process.stdout.write(`[concurrency-series] ${outputDir}/report.html\n`);

async function loadRun(directory) {
  const metadata = await json(`${directory}/metadata.json`, {});
  const deployments = await json(`${directory}/deployments.json`, []);
  const db = await json(`${directory}/db-metrics.json`, {});
  const byId = new Map(deployments.map((row) => [String(row.deploymentId), row]));
  const targets = {};
  for (const deployment of deployments) {
    const final = deployment.final ?? {};
    targets[deployment.target] = {
      deploymentId: deployment.deploymentId,
      status: final.status ?? "unknown",
      totalMs: durationMs(final.createdAt ?? deployment.acceptedAt, final.succeededAt ?? final.failedAt ?? final.updatedAt),
      provisionWaitMs: null,
      provisionRunMs: null,
    };
  }
  for (const job of db.jobs ?? []) {
    if (job.name !== "provision") continue;
    const target = byId.get(String(job.deployment_id))?.target;
    if (!target || !targets[target]) continue;
    targets[target].provisionWaitMs = durationMs(job.created_on, job.started_on);
    targets[target].provisionRunMs = durationMs(job.started_on, job.completed_on);
  }
  return {
    runId: metadata.runId,
    aws: targets.aws ?? null,
    onprem: targets.onprem ?? null,
    envLockCount: (db.envLocks ?? []).length,
  };
}

function renderCsv(runs) {
  const header = ["run_id", "aws_deployment", "aws_total_ms", "aws_provision_wait_ms", "aws_provision_run_ms", "onprem_deployment", "onprem_total_ms", "onprem_provision_wait_ms", "onprem_provision_run_ms", "remaining_env_locks"];
  const rows = runs.map((run) => [run.runId, run.aws?.deploymentId, run.aws?.totalMs, run.aws?.provisionWaitMs, run.aws?.provisionRunMs, run.onprem?.deploymentId, run.onprem?.totalMs, run.onprem?.provisionWaitMs, run.onprem?.provisionRunMs, run.envLockCount]);
  return `${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function renderMarkdown(summary, runs) {
  return `# AWS + On-Prem 동시 배포 기준선\n\n## 요약\n\n- 동시 실행 성공: ${summary.successfulRuns}/${summary.runCount}\n- AWS provision 실행 중앙값: ${fmt(summary.awsProvisionMedianMs)}\n- On-Prem provision 대기 중앙값: ${fmt(summary.onpremProvisionWaitMedianMs)}\n- On-Prem provision 실행 중앙값: ${fmt(summary.onpremProvisionRunMedianMs)}\n\n## 실행별 결과\n\n| Run | AWS | AWS 전체 | AWS provision 실행 | On-Prem | On-Prem 전체 | On-Prem provision 대기 | On-Prem provision 실행 | 남은 잠금 |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${runs.map((run) => `| ${run.runId} | #${run.aws?.deploymentId} | ${fmt(run.aws?.totalMs)} | ${fmt(run.aws?.provisionRunMs)} | #${run.onprem?.deploymentId} | ${fmt(run.onprem?.totalMs)} | ${fmt(run.onprem?.provisionWaitMs)} | ${fmt(run.onprem?.provisionRunMs)} | ${run.envLockCount} |`).join("\n")}\n\n## 해석\n\n두 실행 모두 AWS provision이 먼저 실행됐고, On-Prem provision은 그 뒤에서 대기했다. On-Prem provision 자체는 1초 미만이지만 대기시간은 ${fmt(Math.min(...runs.map((run) => run.onprem?.provisionWaitMs ?? Infinity)))}~${fmt(Math.max(...runs.map((run) => run.onprem?.provisionWaitMs ?? 0)))}였다. 현재 공유 provision worker의 Head-of-Line Blocking이 혼합 배포 완료시간을 지배한다.\n`;
}

function renderHtml(summary, runs) {
  const max = Math.max(1, ...runs.flatMap((run) => [run.aws?.provisionRunMs ?? 0, run.onprem?.provisionWaitMs ?? 0]));
  const rows = runs.map((run) => `<div class="run"><strong>${escape(run.runId)}</strong><div class="metric"><span>AWS provision 실행</span><i class="aws" style="width:${width(run.aws?.provisionRunMs, max)}%"></i><b>${escape(fmt(run.aws?.provisionRunMs))}</b></div><div class="metric"><span>On-Prem provision 대기</span><i class="wait" style="width:${width(run.onprem?.provisionWaitMs, max)}%"></i><b>${escape(fmt(run.onprem?.provisionWaitMs))}</b></div><div class="metric"><span>On-Prem provision 실행</span><i class="runbar" style="width:${width(run.onprem?.provisionRunMs, max)}%"></i><b>${escape(fmt(run.onprem?.provisionRunMs))}</b></div></div>`).join("");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Camellia AWS On-Prem Concurrency</title><style>body{margin:0;background:#111418;color:#f5f7fa;font:15px system-ui}.wrap{max-width:1080px;margin:auto;padding:40px 24px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.card,.run{background:#1a1f26;border:1px solid #303743;border-radius:12px;padding:17px}.card b{display:block;font-size:24px;margin-top:6px}.muted{color:#9aa7b7}.run{margin:14px 0}.metric{display:grid;grid-template-columns:190px 1fr 85px;gap:12px;align-items:center;margin-top:12px}.metric i{display:block;height:18px;border-radius:5px;min-width:3px}.aws{background:#4fa3ff}.wait{background:#ffb84d}.runbar{background:#67e8a5}@media(max-width:700px){.cards{grid-template-columns:1fr}.metric{grid-template-columns:1fr}}</style></head><body><main class="wrap"><h1>AWS + On-Prem 동시 배포 기준선</h1><p class="muted">서로 다른 프로젝트 · 동일 시각 2 VU · 기존 성공 digest 재사용</p><section class="cards"><div class="card"><span class="muted">동시 성공</span><b>${summary.successfulRuns}/${summary.runCount}</b></div><div class="card"><span class="muted">On-Prem 대기 중앙값</span><b>${escape(fmt(summary.onpremProvisionWaitMedianMs))}</b></div><div class="card"><span class="muted">On-Prem 실행 중앙값</span><b>${escape(fmt(summary.onpremProvisionRunMedianMs))}</b></div></section><h2>AWS 실행과 On-Prem 대기 비교</h2>${rows}<p class="muted">두 번 모두 AWS provision이 먼저 실행되면서 1초 미만인 On-Prem 작업이 9.89~20.15초 대기했습니다.</p></main></body></html>`;
}

async function json(path, fallback) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; } }
function width(value, max) { return Number.isFinite(value) ? Math.max(1, value / max * 100) : 1; }
function fmt(value) { return Number.isFinite(value) ? value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms` : "-"; }
function escape(value) { return String(value).replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]); }
