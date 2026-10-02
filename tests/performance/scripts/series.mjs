import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { buildPhaseStats, csvCell, durationMs, percentile } from "../lib/metrics.mjs";

const [outputDir, ...runDirs] = process.argv.slice(2);
if (!outputDir || runDirs.length < 2) {
  throw new Error("usage: node series.mjs <output-dir> <run-dir> <run-dir> [...]");
}

const runs = await Promise.all(runDirs.map(loadRun));
const phases = [...new Set(runs.flatMap((run) => Object.keys(run.phases)))].sort();
const totals = runs.map((run) => run.totalMs).filter(Number.isFinite);
const summary = {
  runCount: runs.length,
  successCount: runs.filter((run) => run.status === "succeeded").length,
  totalMedianMs: percentile(totals, 0.5),
  totalMinMs: totals.length ? Math.min(...totals) : null,
  totalMaxMs: totals.length ? Math.max(...totals) : null,
  phaseStats: phases.map((name) => aggregatePhase(name, runs)),
};

await mkdir(outputDir, { recursive: true });
await writeFile(`${outputDir}/series.json`, `${JSON.stringify({ summary, runs }, null, 2)}\n`);
await writeFile(`${outputDir}/series.csv`, renderCsv(runs, phases));
await writeFile(`${outputDir}/report.md`, renderMarkdown(summary, runs));
await writeFile(`${outputDir}/report.html`, renderHtml(summary, runs));
process.stdout.write(`[series] ${outputDir}/report.html\n`);

async function loadRun(directory) {
  const metadata = await json(`${directory}/metadata.json`, {});
  const deployments = await json(`${directory}/deployments.json`, []);
  const db = await json(`${directory}/db-metrics.json`, {});
  const k6 = await json(`${directory}/k6-summary.json`, {});
  const deployment = deployments[0] ?? {};
  const final = deployment.final ?? {};
  const jobs = (db.jobs ?? []).map((job) => ({
    name: job.name,
    queueWaitMs: durationMs(job.created_on, job.started_on),
    executionMs: durationMs(job.started_on, job.completed_on),
  }));
  for (const agent of db.agentJobs ?? []) {
    if (!agent.result?.startedAt) continue;
    jobs.push({
      name: "agent",
      queueWaitMs: durationMs(agent.created_at, agent.result.startedAt),
      executionMs: durationMs(agent.result.startedAt, agent.result.finishedAt),
    });
  }
  const phaseRows = buildPhaseStats(jobs);
  return {
    runId: metadata.runId ?? basename(directory),
    directory,
    deploymentId: deployment.deploymentId ?? final.id ?? null,
    status: final.status ?? "unknown",
    totalMs: durationMs(final.createdAt ?? deployment.acceptedAt, final.succeededAt ?? final.failedAt ?? final.updatedAt),
    apiMs: metric(k6, "http_req_duration", "avg"),
    pollErrors: deployment.pollErrors ?? 0,
    phases: Object.fromEntries(phaseRows.map((row) => [row.name, {
      waitMs: row.queueWaitMedianMs,
      runMs: row.executionMedianMs,
    }])),
    condition: {
      requestKind: metadata.requestKind,
      sourceDeploymentIds: metadata.sourceDeploymentIds,
      projectIds: metadata.projectIds,
      environmentIds: metadata.environmentIds,
      cacheCondition: metadata.cacheCondition,
      gitCommit: metadata.git?.commit,
    },
  };
}

function aggregatePhase(name, rows) {
  const waits = rows.map((run) => run.phases[name]?.waitMs).filter(Number.isFinite);
  const executions = rows.map((run) => run.phases[name]?.runMs).filter(Number.isFinite);
  return {
    name,
    count: Math.max(waits.length, executions.length),
    waitMedianMs: percentile(waits, 0.5),
    waitMinMs: waits.length ? Math.min(...waits) : null,
    waitMaxMs: waits.length ? Math.max(...waits) : null,
    runMedianMs: percentile(executions, 0.5),
    runMinMs: executions.length ? Math.min(...executions) : null,
    runMaxMs: executions.length ? Math.max(...executions) : null,
  };
}

function renderCsv(runs, phases) {
  const header = ["run_id", "deployment_id", "status", "total_ms", "api_ms", "poll_errors", ...phases.flatMap((name) => [`${name}_wait_ms`, `${name}_run_ms`])];
  const rows = runs.map((run) => [run.runId, run.deploymentId, run.status, run.totalMs, run.apiMs, run.pollErrors, ...phases.flatMap((name) => [run.phases[name]?.waitMs, run.phases[name]?.runMs])]);
  return `${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function renderMarkdown(summary, runs) {
  const condition = runs[0]?.condition ?? {};
  return `# On-Prem Warm 재배포 기준선\n\n## 고정 조건\n\n- 요청: ${condition.requestKind}\n- 원본 배포: ${(condition.sourceDeploymentIds ?? []).join(", ")}\n- 프로젝트: ${(condition.projectIds ?? []).join(", ")}\n- 환경: ${(condition.environmentIds ?? []).join(", ")}\n- 캐시: ${condition.cacheCondition}\n- Git: ${condition.gitCommit}\n\n## 요약\n\n- 성공: ${summary.successCount}/${summary.runCount}\n- 전체 중앙값: ${fmt(summary.totalMedianMs)}\n- 전체 범위: ${fmt(summary.totalMinMs)} ~ ${fmt(summary.totalMaxMs)}\n\n## 실행별 결과\n\n| Run | Deployment | Status | Total | API | Poll 502/오류 |\n|---|---:|---|---:|---:|---:|\n${runs.map((run) => `| ${run.runId} | ${run.deploymentId} | ${run.status} | ${fmt(run.totalMs)} | ${fmt(run.apiMs)} | ${run.pollErrors} |`).join("\n")}\n\n## 단계별 중앙값과 범위\n\n| 단계 | Wait 중앙값 | Wait 범위 | Run 중앙값 | Run 범위 |\n|---|---:|---:|---:|---:|\n${summary.phaseStats.map((row) => `| ${row.name} | ${fmt(row.waitMedianMs)} | ${fmt(row.waitMinMs)} ~ ${fmt(row.waitMaxMs)} | ${fmt(row.runMedianMs)} | ${fmt(row.runMinMs)} ~ ${fmt(row.runMaxMs)} |`).join("\n")}\n\n> 3회 모두 성공했지만 큐·Agent polling 시점에 따라 완료시간 변동이 크다. 평균 하나가 아니라 개별값과 범위를 함께 본다.\n`;
}

function renderHtml(summary, runs) {
  const max = Math.max(1, ...runs.map((run) => run.totalMs ?? 0));
  const runBars = runs.map((run) => `<div class="row"><span>#${escape(run.deploymentId)}<small>${escape(run.runId)}</small></span><div class="track"><i style="width:${Math.max(2, (run.totalMs ?? 0) / max * 100)}%"></i></div><b>${escape(fmt(run.totalMs))}</b></div>`).join("");
  const phaseRows = summary.phaseStats.map((row) => `<tr><td>${escape(row.name)}</td><td>${escape(fmt(row.waitMedianMs))}</td><td>${escape(fmt(row.waitMinMs))} ~ ${escape(fmt(row.waitMaxMs))}</td><td>${escape(fmt(row.runMedianMs))}</td><td>${escape(fmt(row.runMinMs))} ~ ${escape(fmt(row.runMaxMs))}</td></tr>`).join("");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Camellia On-Prem Warm Baseline</title><style>body{margin:0;background:#111418;color:#f5f7fa;font:15px system-ui}.wrap{max-width:1050px;margin:auto;padding:40px 24px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.card,.panel{background:#1a1f26;border:1px solid #303743;border-radius:12px;padding:17px}.card b{display:block;font-size:25px;margin-top:6px}.muted,small{color:#9aa7b7}.row{display:grid;grid-template-columns:230px 1fr 80px;gap:12px;align-items:center;margin:14px 0}.row small{display:block;font-size:11px}.track{height:19px;background:#29313a;border-radius:6px;overflow:hidden}.track i{display:block;height:100%;background:linear-gradient(90deg,#44a4ff,#67e8a5);border-radius:6px}table{width:100%;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid #303743;text-align:left}@media(max-width:700px){.cards{grid-template-columns:1fr}.row{grid-template-columns:1fr}}</style></head><body><main class="wrap"><h1>On-Prem Warm 재배포 기준선</h1><p class="muted">동일 digest · 프로젝트 · 환경, ${summary.runCount}회 반복</p><section class="cards"><div class="card"><span class="muted">성공률</span><b>${summary.successCount}/${summary.runCount}</b></div><div class="card"><span class="muted">전체 중앙값</span><b>${escape(fmt(summary.totalMedianMs))}</b></div><div class="card"><span class="muted">전체 범위</span><b>${escape(fmt(summary.totalMinMs))}–${escape(fmt(summary.totalMaxMs))}</b></div></section><h2>실행별 전체 시간</h2><section class="panel">${runBars}</section><h2>단계별 중앙값과 변동</h2><section class="panel"><table><thead><tr><th>단계</th><th>Wait 중앙값</th><th>Wait 범위</th><th>Run 중앙값</th><th>Run 범위</th></tr></thead><tbody>${phaseRows}</tbody></table></section><p class="muted">큐·Agent polling 변동을 평균으로 숨기지 않고 개별 실행값과 범위를 함께 표시합니다.</p></main></body></html>`;
}

function metric(summary, name, key) {
  const row = summary.metrics?.[name] ?? {};
  const values = row.values ?? row;
  const value = Number(values[key]);
  return Number.isFinite(value) ? value : null;
}
async function json(path, fallback) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; } }
function fmt(value) { return Number.isFinite(value) ? value >= 60_000 ? `${(value / 60_000).toFixed(2)}m` : value >= 1_000 ? `${(value / 1_000).toFixed(2)}s` : `${Math.round(value)}ms` : "-"; }
function escape(value) { return String(value).replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]); }
