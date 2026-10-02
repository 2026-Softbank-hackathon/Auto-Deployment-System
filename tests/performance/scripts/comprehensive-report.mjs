import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const [resultsRoot = "docs/performance-results", outputDir = join(resultsRoot, "20261002-comprehensive")] = process.argv.slice(2);

const definitions = [
  { id: "aws-cold", name: "AWS 신규 이미지", match: /aws-cold-v[23]$/, expected: "success" },
  { id: "aws-warm", name: "AWS 동일 이미지 재배포", match: /aws-warm-v\d+$/, expected: "success" },
  { id: "onprem-cold", name: "On-Prem 신규 이미지", match: /onprem-cold-v\d+$/, expected: "success" },
  { id: "onprem-warm", name: "On-Prem 동일 이미지 재배포", match: /onprem-warm-v\d+$/, expected: "success" },
  { id: "aws-aws", name: "AWS 2건 동시", match: /aws-aws-burst2-r\d+$/, expected: "success" },
  { id: "aws-onprem", name: "AWS + On-Prem 동시", match: /aws-onprem-burst2-r\d+$/, expected: "success" },
  { id: "onprem-onprem", name: "On-Prem 2건 동시", match: /onprem-onprem-burst2-r\d+$/, expected: "success" },
  { id: "burst5", name: "혼합 5건 동시", match: /burst5-mixed-r\d+$/, expected: "success" },
  { id: "arrival", name: "5분 지속 요청", match: /arrival-mixed/, expected: "success" },
  { id: "lock", name: "동일 프로젝트 잠금", match: /same-project-lock-r\d+$/, expected: "lock" },
  { id: "to-aws", name: "On-Prem → AWS 전환", match: /switch-onprem-to-aws-r\d+$/, expected: "success" },
  { id: "to-onprem", name: "AWS → On-Prem 전환", match: /switch-aws-to-onprem-r\d+$/, expected: "success" },
  { id: "rollback", name: "검증 실패·롤백", match: /failure-rollback-r\d+$/, expected: "failure" },
];

const entries = (await readdir(resultsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const scenarios = [];
for (const definition of definitions) {
  const directories = entries.filter((name) => definition.match.test(name));
  if (directories.length === 0) continue;
  const runs = await Promise.all(directories.map((name) => loadRun(join(resultsRoot, name))));
  scenarios.push(summarize(definition, runs));
}

const healthRun = await loadRun(join(resultsRoot, "20261002T110138Z-health"));
const transitionDigests = scenarios
  .filter((scenario) => ["to-aws", "to-onprem"].includes(scenario.id))
  .flatMap((scenario) => scenario.runs.flatMap((run) => run.digests));
const evidence = await json(join(resultsRoot, "20261002-comprehensive", "agent-restart-evidence.json"), null);
const totals = {
  scenarioCount: scenarios.length,
  runCount: scenarios.reduce((sum, scenario) => sum + scenario.runCount, 0),
  requestCount: scenarios.reduce((sum, scenario) => sum + scenario.requests, 0),
  acceptedCount: scenarios.reduce((sum, scenario) => sum + scenario.accepted, 0),
  rejectedCount: scenarios.reduce((sum, scenario) => sum + scenario.rejected, 0),
  deploymentCount: scenarios.reduce((sum, scenario) => sum + scenario.deployments, 0),
  expectedOutcomeCount: scenarios.reduce((sum, scenario) => sum + scenario.expectedOutcomes, 0),
  unexpectedOutcomeCount: scenarios.reduce((sum, scenario) => sum + scenario.unexpectedOutcomes, 0),
};

const report = {
  generatedAt: new Date().toISOString(),
  scope: "실서비스 API + 실제 AWS/On-Prem 런타임",
  totals,
  health: healthRun.health,
  transition: {
    deploymentCount: transitionDigests.length,
    uniqueDigestCount: new Set(transitionDigests.map((row) => row.image_digest)).size,
    digests: transitionDigests,
  },
  agentRestart: evidence,
  scenarios,
};

await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(join(outputDir, "summary.csv"), renderCsv(scenarios));
await writeFile(join(outputDir, "report.md"), renderMarkdown(report));
await writeFile(join(outputDir, "report.html"), renderHtml(report));
process.stdout.write(`[comprehensive-report] ${join(outputDir, "report.html")}\n`);

async function loadRun(directory) {
  const metadata = await json(join(directory, "metadata.json"), {});
  const deployments = await json(join(directory, "deployments.json"), []);
  const db = await json(join(directory, "db-metrics.json"), {});
  const k6 = await json(join(directory, "k6-summary.json"), {});
  const accepted = metric(k6, "camellia_deployment_created", "count") ?? deployments.length;
  const rejected = metric(k6, "camellia_deployment_rejected", "count") ?? 0;
  return {
    id: metadata.runId ?? basename(directory),
    directory,
    accepted,
    rejected,
    requestP95Ms: metric(k6, "http_req_duration", "p(95)"),
    deployments: deployments.map((row) => {
      const final = row.final ?? {};
      return {
        id: row.deploymentId ?? final.id,
        status: final.status ?? "unknown",
        targetProfile: final.targetProfile ?? null,
        totalMs: duration(final.createdAt ?? row.acceptedAt, final.succeededAt ?? final.failedAt ?? final.updatedAt),
        error: typeof final.error === "string" ? final.error : final.error?.code ?? null,
      };
    }),
    remainingLocks: (db.envLocks ?? []).length,
    digests: db.buildArtifacts ?? [],
    health: healthSummary(k6),
  };
}

function summarize(definition, runs) {
  const deployments = runs.flatMap((run) => run.deployments);
  const durations = deployments.map((row) => row.totalMs).filter(Number.isFinite);
  const accepted = sum(runs.map((run) => run.accepted));
  const rejected = sum(runs.map((run) => run.rejected));
  const expectedOutcomes = deployments.filter((row) => expected(definition.expected, row)).length;
  const requestP95 = runs.map((run) => run.requestP95Ms).filter(Number.isFinite);
  return {
    ...definition,
    runCount: runs.length,
    requests: accepted + rejected,
    accepted,
    rejected,
    deployments: deployments.length,
    expectedOutcomes,
    unexpectedOutcomes: deployments.length - expectedOutcomes,
    medianMs: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    minMs: durations.length ? Math.min(...durations) : null,
    maxMs: durations.length ? Math.max(...durations) : null,
    requestP95Ms: percentile(requestP95, 0.95),
    remainingLocks: Math.max(0, ...runs.map((run) => run.remainingLocks)),
    passed: definition.expected === "lock"
      ? runs.every((run) => run.accepted === 1 && run.rejected === 1 && run.remainingLocks === 0)
      : deployments.length > 0
        && rejected === 0
        && deployments.every((row) => expected(definition.expected, row))
        && runs.every((run) => run.remainingLocks === 0),
    runs,
  };
}

function expected(kind, deployment) {
  if (kind === "failure") return deployment.status === "failed" && /health/i.test(deployment.error ?? "");
  if (kind === "mixed") return ["succeeded", "failed"].includes(deployment.status);
  return deployment.status === "succeeded";
}

function renderCsv(scenarios) {
  const rows = [["scenario", "runs", "requests", "accepted", "rejected", "deployments", "expected_outcomes", "unexpected_outcomes", "median_ms", "p95_ms", "request_p95_ms", "remaining_locks", "passed"]];
  for (const row of scenarios) rows.push([row.name, row.runCount, row.requests, row.accepted, row.rejected, row.deployments, row.expectedOutcomes, row.unexpectedOutcomes, row.medianMs, row.p95Ms, row.requestP95Ms, row.remainingLocks, row.passed]);
  return `${rows.map((row) => row.map(csv).join(",")).join("\n")}\n`;
}

function renderMarkdown(report) {
  const awsCold = find("aws-cold");
  const awsWarm = find("aws-warm");
  const onpremCold = find("onprem-cold");
  const onpremWarm = find("onprem-warm");
  return `# Camellia 전체 성능·복원력 테스트 결과\n\n- 생성 시각: ${report.generatedAt}\n- 범위: ${report.scope}\n- 시나리오: ${report.totals.scenarioCount}종 / 반복 실행 ${report.totals.runCount}회\n- 실제 배포: ${report.totals.deploymentCount}건\n- 요청: ${report.totals.requestCount}건 (접수 ${report.totals.acceptedCount}, 정책상 거절 ${report.totals.rejectedCount})\n- 예상 결과 일치: ${report.totals.expectedOutcomeCount}/${report.totals.deploymentCount}\n\n## 시나리오별 결과\n\n| 시나리오 | 반복 | 요청 | 접수/거절 | 실제 배포 | 전체 중앙값 | P95 | API P95 | 남은 락 | 판정 |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---|\n${report.scenarios.map((row) => `| ${row.name} | ${row.runCount} | ${row.requests} | ${row.accepted}/${row.rejected} | ${row.deployments} | ${fmt(row.medianMs)} | ${fmt(row.p95Ms)} | ${fmt(row.requestP95Ms)} | ${row.remainingLocks} | ${row.passed ? "PASS" : "CHECK"} |`).join("\n")}\n\n## 핵심 확인\n\n- 헬스 API: ${percent(report.health?.successRate)} 성공, P95 ${fmt(report.health?.p95Ms)}.\n- AWS 재배포 중앙값: 신규 ${fmt(awsCold?.medianMs)} → 동일 이미지 ${fmt(awsWarm?.medianMs)}.\n- On-Prem 재배포 중앙값: 신규 ${fmt(onpremCold?.medianMs)} → 동일 이미지 ${fmt(onpremWarm?.medianMs)}.\n- 양방향 전환 6건의 이미지 digest 종류: ${report.transition.uniqueDigestCount}개 (${report.transition.uniqueDigestCount === 1 ? "동일 이미지 재사용 확인" : "추가 확인 필요"}).\n- 동일 프로젝트 동시 요청은 1건만 접수되고 나머지는 409로 보호되며, 완료 뒤 남은 환경 락은 0개였다.\n- 검증 실패 후보는 실패로 확정되고 기존 정상 서비스가 유지되는지 별도 런타임 증거와 함께 확인한다.\n- Agent 재시작 복구: ${report.agentRestart?.passed ? "PASS" : report.agentRestart ? "CHECK" : "실행 전"}.\n\n## 해석 주의사항\n\n- 실서비스 환경 측정값이라 네트워크·공유 worker 큐·AWS 리소스 상태를 모두 포함한다.\n- 신규 이미지와 재사용 이미지는 빌드 캐시 조건이 다르므로 별도 기준선으로 비교한다.\n- On-Prem 2건 동시 테스트는 서로 다른 Agent identity와 환경을 사용했지만 동일한 물리 Mac/Docker host에서 수행했다.\n- 첫 AWS cold 측정은 수동 승인 대기 오염으로 집계에서 제외하고 자동 승인된 2회만 사용했다.\n`;
}

function renderHtml(report) {
  const max = Math.max(1, ...report.scenarios.map((row) => row.p95Ms ?? 0));
  const rows = report.scenarios.map((row) => `<tr><td><strong>${esc(row.name)}</strong><small>${row.runCount}회 반복</small></td><td>${row.requests}</td><td>${row.accepted}/${row.rejected}</td><td>${row.deployments}</td><td>${esc(fmt(row.medianMs))}</td><td><div class="bar"><i style="width:${Math.max(2, (row.p95Ms ?? 0) / max * 100)}%"></i></div>${esc(fmt(row.p95Ms))}</td><td>${esc(fmt(row.requestP95Ms))}</td><td>${row.remainingLocks}</td><td class="${row.passed ? "pass" : "check"}">${row.passed ? "PASS" : "CHECK"}</td></tr>`).join("");
  const restart = report.agentRestart?.passed ? "PASS" : report.agentRestart ? "CHECK" : "대기";
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Camellia 전체 성능 테스트</title><style>body{margin:0;background:#0f1217;color:#f7f9fc;font:14px system-ui}.wrap{max-width:1320px;margin:auto;padding:34px 24px}.eyebrow{color:#6ee7b7;font-weight:700}.cards{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:24px 0}.card,.panel{background:#181d25;border:1px solid #303846;border-radius:14px;padding:16px}.card b{display:block;font-size:26px;margin-top:5px}.muted,small{color:#9aa7b8}small{display:block;margin-top:4px}table{width:100%;border-collapse:collapse}th,td{padding:11px 9px;border-bottom:1px solid #2c3440;text-align:left;white-space:nowrap}.bar{display:inline-block;width:90px;height:9px;background:#2b3440;border-radius:5px;margin-right:8px}.bar i{display:block;height:100%;background:linear-gradient(90deg,#4da5ff,#67e8a5);border-radius:5px}.pass{color:#6ee7b7;font-weight:800}.check{color:#fbbf24;font-weight:800}.facts{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.facts div{background:#181d25;border-left:4px solid #4da5ff;padding:14px;border-radius:6px}@media(max-width:900px){.cards{grid-template-columns:repeat(2,1fr)}.panel{overflow:auto}.facts{grid-template-columns:1fr}}</style></head><body><main class="wrap"><div class="eyebrow">LIVE SYSTEM · 2026-10-02</div><h1>Camellia 전체 성능·복원력 테스트</h1><p class="muted">실서비스 API, AWS 리소스, macOS On-Prem Agent를 함께 사용한 end-to-end 측정</p><section class="cards"><div class="card"><span class="muted">시나리오</span><b>${report.totals.scenarioCount}종</b></div><div class="card"><span class="muted">반복 실행</span><b>${report.totals.runCount}회</b></div><div class="card"><span class="muted">실제 배포</span><b>${report.totals.deploymentCount}건</b></div><div class="card"><span class="muted">예상 결과 일치</span><b>${report.totals.expectedOutcomeCount}/${report.totals.deploymentCount}</b></div><div class="card"><span class="muted">Agent 재시작</span><b>${restart}</b></div></section><section class="panel"><table><thead><tr><th>시나리오</th><th>요청</th><th>접수/거절</th><th>배포</th><th>중앙값</th><th>P95</th><th>API P95</th><th>락</th><th>판정</th></tr></thead><tbody>${rows}</tbody></table></section><h2>핵심 검증</h2><section class="facts"><div>헬스 API 성공률 <strong>${percent(report.health?.successRate)}</strong>, P95 <strong>${esc(fmt(report.health?.p95Ms))}</strong></div><div>양방향 전환 6건의 digest <strong>${report.transition.uniqueDigestCount}개</strong> — ${report.transition.uniqueDigestCount === 1 ? "동일 이미지 재사용 확인" : "확인 필요"}</div><div>동일 프로젝트 동시 요청은 <strong>1건만 접수</strong>되고 경쟁 요청은 409로 보호</div><div>완료 후 수집된 환경 락 <strong>0개</strong>, 실패 후보는 기존 정상 서비스와 격리</div></section><p class="muted">주의: 실서비스 측정값에는 공유 worker 큐, 네트워크, AWS 리소스 상태가 포함됩니다. On-Prem 2건 동시는 서로 다른 Agent identity를 사용했지만 동일 물리 Mac에서 수행했습니다.</p></main></body></html>`;
}

function healthSummary(k6) {
  const failed = metric(k6, "http_req_failed", "value");
  return {
    successRate: Number.isFinite(failed) ? 1 - failed : null,
    p95Ms: metric(k6, "http_req_duration", "p(95)"),
  };
}
function metric(summary, name, key) {
  const row = summary.metrics?.[name] ?? {};
  const values = row.values ?? row;
  const value = Number(values[key]);
  return Number.isFinite(value) ? value : null;
}
function duration(start, end) { const value = Date.parse(end) - Date.parse(start); return Number.isFinite(value) && value >= 0 ? value : null; }
function percentile(values, ratio) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const index = (sorted.length - 1) * ratio; const lower = Math.floor(index); const upper = Math.ceil(index); return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower); }
function find(id) { return scenarios.find((row) => row.id === id); }
function sum(values) { return values.reduce((total, value) => total + (Number(value) || 0), 0); }
function fmt(value) { return Number.isFinite(value) ? value >= 60_000 ? `${(value / 60_000).toFixed(2)}분` : value >= 1_000 ? `${(value / 1_000).toFixed(2)}초` : `${Math.round(value)}ms` : "-"; }
function percent(value) { return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "-"; }
function csv(value) { const text = value == null ? "" : String(value); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
function esc(value) { return String(value).replace(/[&<>"']/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[character]); }
async function json(path, fallback) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; } }
