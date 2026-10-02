import { readFile, writeFile } from "node:fs/promises";
import { buildPhaseStats, csvCell, durationMs, percentile } from "../lib/metrics.mjs";

const runDir = process.argv[2];
if (!runDir) throw new Error("usage: node report.mjs <run-dir>");

const metadata = await readJson(`${runDir}/metadata.json`, {});
const deployments = await readJson(`${runDir}/deployments.json`, []);
const db = await readJson(`${runDir}/db-metrics.json`, { available: false });
const k6 = await readJson(`${runDir}/k6-summary.json`, { metrics: {} });
const model = buildReportModel(metadata, deployments, db, k6);

await writeFile(`${runDir}/summary.csv`, renderCsv(model));
await writeFile(`${runDir}/report.md`, renderMarkdown(model));
await writeFile(`${runDir}/report.html`, renderHtml(model));
process.stdout.write(`[report] ${runDir}/report.html\n`);

function buildReportModel(meta, observed, database, summary) {
  const deploymentRows = observed.map((row) => {
    const final = row.final ?? {};
    const terminalAt = final.succeededAt ?? final.failedAt ?? final.updatedAt ?? row.collectedAt;
    return {
      deploymentId: row.deploymentId,
      projectId: row.projectId,
      target: row.target,
      status: final.status ?? (row.timedOut ? "timed_out" : "unknown"),
      createdAt: final.createdAt ?? row.acceptedAt,
      terminalAt,
      totalMs: durationMs(final.createdAt ?? row.acceptedAt, terminalAt),
      pollErrors: row.pollErrors ?? 0,
      healthStatus: row.health?.status ?? null,
      error: final.error ?? null,
    };
  });

  const queueJobs = (database.jobs ?? []).map((job) => ({
    deploymentId: job.deployment_id,
    name: job.name,
    state: job.state,
    queueWaitMs: durationMs(job.created_on, job.started_on),
    executionMs: durationMs(job.started_on, job.completed_on),
    retryCount: Number(job.retry_count ?? 0),
  }));
  const agentJobs = (database.agentJobs ?? []).flatMap((job) => {
    const startedAt = job.result?.startedAt;
    const finishedAt = job.result?.finishedAt;
    if (!startedAt && !finishedAt) return [];
    return [{
      deploymentId: job.deployment_id,
      name: "agent",
      state: job.status,
      queueWaitMs: durationMs(job.created_at, startedAt),
      executionMs: durationMs(startedAt, finishedAt),
      retryCount: Math.max(0, Number(job.attempt ?? 1) - 1),
    }];
  });
  const jobs = [...queueJobs, ...agentJobs];
  const targetByDeployment = new Map(deploymentRows.map((row) => [String(row.deploymentId), row.target]));
  for (const job of jobs) job.target = targetByDeployment.get(String(job.deploymentId)) ?? "unknown";
  const steps = (database.steps ?? []).map((step) => ({
    deploymentId: step.deployment_id,
    name: step.step_name,
    status: step.status,
    durationMs: durationMs(step.started_at, step.finished_at)
      ?? (Number.isFinite(Number(step.duration_ms)) ? Number(step.duration_ms) : null),
  }));

  const totals = deploymentRows.map((row) => row.totalMs).filter(Number.isFinite);
  const statuses = Object.fromEntries([...new Set(deploymentRows.map((row) => row.status))]
    .map((status) => [status, deploymentRows.filter((row) => row.status === status).length]));
  const httpDuration = metricValues(summary.metrics?.http_req_duration);
  const httpFailed = metricValues(summary.metrics?.http_req_failed);
  const acceptedMetric = metricValues(summary.metrics?.camellia_deployment_accepted);
  const rejectedMetric = metricValues(summary.metrics?.camellia_deployment_rejected);

  return {
    metadata: meta,
    kpis: {
      deploymentCount: deploymentRows.length,
      successCount: statuses.succeeded ?? 0,
      successRate: deploymentRows.length ? (statuses.succeeded ?? 0) / deploymentRows.length : null,
      totalMedianMs: percentile(totals, 0.5),
      totalP95Ms: percentile(totals, 0.95),
      httpP95Ms: numberOrNull(httpDuration["p(95)"]),
      httpAverageMs: numberOrNull(httpDuration.avg),
      httpFailureRate: numberOrNull(httpFailed.rate ?? httpFailed.value),
      acceptedRate: numberOrNull(acceptedMetric.rate ?? acceptedMetric.value),
      rejectedCount: numberOrNull(rejectedMetric.count),
    },
    deployments: deploymentRows,
    jobs,
    steps,
    phaseStats: buildPhaseStats(jobs),
    stepStats: buildStepStats(steps),
    dbAvailable: database.available === true,
    dbReason: database.reason ?? null,
    envLockCount: (database.envLocks ?? []).length,
  };
}

function buildStepStats(steps) {
  const grouped = new Map();
  for (const step of steps) {
    if (!Number.isFinite(step.durationMs)) continue;
    const values = grouped.get(step.name) ?? [];
    values.push(step.durationMs);
    grouped.set(step.name, values);
  }
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, values]) => ({
    name,
    count: values.length,
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
  }));
}

function renderCsv(model) {
  const header = ["deployment_id", "project_id", "target", "status", "created_at", "terminal_at", "total_ms", "health_status", "poll_errors", "error"];
  const rows = model.deployments.map((row) => [
    row.deploymentId, row.projectId, row.target, row.status, row.createdAt, row.terminalAt,
    row.totalMs, row.healthStatus, row.pollErrors, row.error,
  ]);
  return `${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function renderMarkdown(model) {
  const meta = model.metadata;
  const lines = [
    `# Camellia 성능 테스트 — ${meta.runId ?? "unknown"}`,
    "",
    "## 실행 조건",
    "",
    "| 항목 | 값 |",
    "|---|---|",
    `| 실행 시각 | ${text(meta.startedAt)} |`,
    `| 프로필 | ${text(meta.profile)} |`,
    `| 요청 유형 | ${text(meta.requestKind)} |`,
    `| 목적 | ${text(meta.purpose)} |`,
    `| API | ${text(meta.apiBaseUrl)} |`,
    `| 프로젝트 | ${text((meta.projectIds ?? []).join(", "))} |`,
    `| 원본 배포 | ${text((meta.sourceDeploymentIds ?? []).join(", "))} |`,
    `| 환경 | ${text((meta.environmentIds ?? []).join(", "))} |`,
    `| 대상 | ${text((meta.targets ?? []).join(", "))} |`,
    `| 캐시 조건 | ${text(meta.cacheCondition)} |`,
    `| 소스 SHA-256 | ${text(meta.source?.sha256)} |`,
    `| Git | ${text(meta.git?.commit)} (${text(meta.git?.branch)}) |`,
    `| 메모 | ${text(meta.notes)} |`,
    "",
    "## 핵심 결과",
    "",
    "| 지표 | 값 |",
    "|---|---:|",
    `| 배포 수 | ${model.kpis.deploymentCount} |`,
    `| 성공률 | ${percent(model.kpis.successRate)} |`,
    `| 전체 중앙값 | ${formatMs(model.kpis.totalMedianMs)} |`,
    `| 전체 p95 | ${formatMs(model.kpis.totalP95Ms)} |`,
    `| API 응답 평균 | ${formatMs(model.kpis.httpAverageMs)} |`,
    `| API 응답 p95 | ${formatMs(model.kpis.httpP95Ms)} |`,
    `| HTTP 실패율 | ${percent(model.kpis.httpFailureRate)} |`,
    `| 배포 접수율 | ${percent(model.kpis.acceptedRate)} |`,
    `| 거절 요청 | ${model.kpis.rejectedCount ?? 0} |`,
    `| 종료 후 남은 환경 잠금 | ${model.envLockCount} |`,
    "",
    "## 배포별 결과",
    "",
    "| Deployment | Project | Target | Status | 전체 시간 | Health |",
    "|---:|---:|---|---|---:|---|",
    ...model.deployments.map((row) => `| ${row.deploymentId} | ${row.projectId} | ${text(row.target)} | ${row.status} | ${formatMs(row.totalMs)} | ${text(row.healthStatus)} |`),
    "",
    "## 큐 단계 통계",
    "",
    model.dbAvailable
      ? "| 큐 | 표본 | 대기 중앙값 | 대기 p95 | 실행 중앙값 | 실행 p95 |"
      : `DB 세부 계측 없음: ${text(model.dbReason)}`,
    ...(model.dbAvailable ? [
      "|---|---:|---:|---:|---:|---:|",
      ...model.phaseStats.map((row) => `| ${row.name} | ${row.count} | ${formatMs(row.queueWaitMedianMs)} | ${formatMs(row.queueWaitP95Ms)} | ${formatMs(row.executionMedianMs)} | ${formatMs(row.executionP95Ms)} |`),
    ] : []),
    "",
    "## 배포별 큐·Agent 단계",
    "",
    "| Deployment | Target | 단계 | 대기 | 실행 | 상태 |",
    "|---:|---|---|---:|---:|---|",
    ...model.jobs.map((job) => `| ${job.deploymentId} | ${text(job.target)} | ${job.name} | ${formatMs(job.queueWaitMs)} | ${formatMs(job.executionMs)} | ${text(job.state)} |`),
    "",
    "> p95는 표본이 충분할 때만 해석한다. 비용이 큰 전체 배포의 소표본 비교는 중앙값과 개별 실행값을 우선한다.",
  ];
  return `${lines.join("\n")}\n`;
}

function renderHtml(model) {
  const rows = model.deployments;
  const maxTotal = Math.max(1, ...rows.map((row) => row.totalMs ?? 0));
  const gantt = rows.length
    ? rows.map((row) => `<div class="gantt-row"><span>#${html(row.deploymentId)} · ${html(row.target)}</span><div class="track"><i class="bar ${html(row.status)}" style="width:${Math.max(1, ((row.totalMs ?? 0) / maxTotal) * 100)}%"></i></div><b>${html(formatMs(row.totalMs))}</b></div>`).join("")
    : '<p class="muted">배포를 생성하지 않은 health-only 실행입니다.</p>';
  const phaseRows = model.phaseStats.map((row) => `<tr><td>${html(row.name)}</td><td>${row.count}</td><td>${html(formatMs(row.queueWaitMedianMs))}</td><td>${html(formatMs(row.queueWaitP95Ms))}</td><td>${html(formatMs(row.executionMedianMs))}</td><td>${html(formatMs(row.executionP95Ms))}</td></tr>`).join("");
  const jobRows = model.jobs.map((job) => `<tr><td>#${html(job.deploymentId)}</td><td>${html(job.target)}</td><td>${html(job.name)}</td><td>${html(formatMs(job.queueWaitMs))}</td><td>${html(formatMs(job.executionMs))}</td><td>${html(job.state)}</td></tr>`).join("");
  const deploymentRows = rows.map((row) => `<tr><td>#${html(row.deploymentId)}</td><td>${html(row.projectId)}</td><td>${html(row.target)}</td><td><span class="pill ${html(row.status)}">${html(row.status)}</span></td><td>${html(formatMs(row.totalMs))}</td><td>${html(row.healthStatus ?? "-")}</td></tr>`).join("");

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Camellia Performance ${html(model.metadata.runId)}</title><style>
  :root{color-scheme:dark;--bg:#111418;--panel:#1a1f26;--line:#303743;--text:#f4f7fb;--muted:#9aa7b7;--accent:#67e8a5;--bad:#ff7474;--warn:#ffc857}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,sans-serif}.wrap{max-width:1180px;margin:auto;padding:36px 24px 72px}h1{font-size:28px;margin:0 0 6px}h2{font-size:19px;margin:34px 0 14px}.muted{color:var(--muted)}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}.card,.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px}.card{padding:16px}.card b{display:block;font-size:24px;margin-top:5px}.panel{padding:18px;overflow:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--muted);font-weight:600}.gantt-row{display:grid;grid-template-columns:170px 1fr 90px;gap:12px;align-items:center;margin:12px 0}.track{height:18px;background:#272d36;border-radius:6px;overflow:hidden}.bar{display:block;height:100%;background:linear-gradient(90deg,#45a3ff,var(--accent));border-radius:6px}.bar.failed,.bar.timed_out{background:var(--bad)}.pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#29313b}.pill.succeeded{color:var(--accent)}.pill.failed,.pill.timed_out{color:var(--bad)}code{word-break:break-all}@media(max-width:700px){.gantt-row{grid-template-columns:1fr}.gantt-row b{text-align:right}}
  </style></head><body><main class="wrap"><h1>Camellia 성능 테스트</h1><p class="muted">${html(model.metadata.runId)} · ${html(model.metadata.startedAt)} · ${html(model.metadata.profile)}</p>
  <section class="cards"><div class="card"><span class="muted">배포 성공률</span><b>${html(percent(model.kpis.successRate))}</b></div><div class="card"><span class="muted">배포 접수율</span><b>${html(percent(model.kpis.acceptedRate))}</b></div><div class="card"><span class="muted">전체 중앙값</span><b>${html(formatMs(model.kpis.totalMedianMs))}</b></div><div class="card"><span class="muted">API p95</span><b>${html(formatMs(model.kpis.httpP95Ms))}</b></div></section>
  <h2>실행 조건</h2><div class="panel"><table><tbody><tr><th>목적</th><td>${html(model.metadata.purpose ?? "-")}</td></tr><tr><th>요청 유형</th><td>${html(model.metadata.requestKind ?? "-")}</td></tr><tr><th>API</th><td>${html(model.metadata.apiBaseUrl)}</td></tr><tr><th>프로젝트</th><td>${html((model.metadata.projectIds ?? []).join(", ") || "-")}</td></tr><tr><th>원본 배포</th><td>${html((model.metadata.sourceDeploymentIds ?? []).join(", ") || "-")}</td></tr><tr><th>환경</th><td>${html((model.metadata.environmentIds ?? []).join(", ") || "-")}</td></tr><tr><th>캐시</th><td>${html(model.metadata.cacheCondition)}</td></tr><tr><th>소스 digest</th><td><code>${html(model.metadata.source?.sha256 ?? "-")}</code></td></tr><tr><th>Git</th><td><code>${html(model.metadata.git?.commit ?? "-")}</code></td></tr><tr><th>메모</th><td>${html(model.metadata.notes ?? "-")}</td></tr></tbody></table></div>
  <h2>동시 배포 완료 시간</h2><div class="panel">${gantt}</div>
  <h2>배포 결과</h2><div class="panel"><table><thead><tr><th>Deployment</th><th>Project</th><th>Target</th><th>Status</th><th>Total</th><th>Health</th></tr></thead><tbody>${deploymentRows || '<tr><td colspan="6">없음</td></tr>'}</tbody></table></div>
  <h2>큐 대기·실행</h2><div class="panel">${model.dbAvailable ? `<table><thead><tr><th>Queue</th><th>N</th><th>Wait median</th><th>Wait p95</th><th>Run median</th><th>Run p95</th></tr></thead><tbody>${phaseRows}</tbody></table>` : `<p class="muted">DB 세부 계측 없음: ${html(model.dbReason ?? "-")}</p>`}</div>
  <h2>배포별 큐·Agent 단계</h2><div class="panel"><table><thead><tr><th>Deployment</th><th>Target</th><th>Phase</th><th>Wait</th><th>Run</th><th>State</th></tr></thead><tbody>${jobRows || '<tr><td colspan="6">없음</td></tr>'}</tbody></table></div>
  <p class="muted">p95는 표본이 충분할 때만 해석합니다. 원시값은 같은 실행 폴더의 JSON·CSV에 보존됩니다.</p></main></body></html>`;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function metricValues(metric) {
  if (!metric || typeof metric !== "object") return {};
  return metric.values && typeof metric.values === "object" ? metric.values : metric;
}

function formatMs(value) {
  if (!Number.isFinite(value)) return "-";
  if (value >= 60_000) return `${(value / 60_000).toFixed(2)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}s`;
  return `${Math.round(value)}ms`;
}

function percent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "-";
}

function text(value) {
  return value === null || value === undefined || value === "" ? "-" : String(value).replaceAll("|", "\\|");
}

function html(value) {
  return String(value ?? "-").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
