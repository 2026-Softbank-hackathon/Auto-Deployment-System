import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { buildPhaseStats, durationMs, percentile } from "../lib/metrics.mjs";

const [beforeDir, afterDir, outputPath = "performance-comparison.html"] = process.argv.slice(2);
if (!beforeDir || !afterDir) {
  throw new Error("usage: node compare.mjs <before-run-dir> <after-run-dir> [output.html]");
}

const before = await loadRun(resolve(beforeDir));
const after = await loadRun(resolve(afterDir));
const names = [...new Set([...before.phases.keys(), ...after.phases.keys()])].sort();
const comparisons = names.map((name) => compareMetric(name, before.phases.get(name), after.phases.get(name)));
const total = compareMetric("deployment_total", before.totalMedianMs, after.totalMedianMs);
const all = [total, ...comparisons];

await writeFile(outputPath, renderHtml(before, after, all));
await writeFile(outputPath.replace(/\.html?$/i, ".md"), renderMarkdown(before, after, all));
process.stdout.write(`[compare] ${outputPath}\n`);

async function loadRun(directory) {
  const metadata = await json(`${directory}/metadata.json`, {});
  const deployments = await json(`${directory}/deployments.json`, []);
  const db = await json(`${directory}/db-metrics.json`, {});
  const totals = deployments.map((row) => {
    const final = row.final ?? {};
    return durationMs(final.createdAt ?? row.acceptedAt, final.succeededAt ?? final.failedAt ?? final.updatedAt);
  }).filter(Number.isFinite);
  const jobs = (db.jobs ?? []).map((job) => ({
    name: job.name,
    queueWaitMs: durationMs(job.created_on, job.started_on),
    executionMs: durationMs(job.started_on, job.completed_on),
  }));
  const phases = new Map(buildPhaseStats(jobs).map((row) => [row.name, row.executionMedianMs]));
  return {
    directory,
    name: metadata.runId ?? basename(directory),
    metadata,
    totalMedianMs: percentile(totals, 0.5),
    phases,
  };
}

function compareMetric(name, before, after) {
  const deltaMs = Number.isFinite(before) && Number.isFinite(after) ? after - before : null;
  const deltaRatio = Number.isFinite(deltaMs) && before > 0 ? deltaMs / before : null;
  return { name, before, after, deltaMs, deltaRatio };
}

function renderMarkdown(before, after, rows) {
  return `# Camellia 성능 Before / After\n\n- Before: ${before.name}\n- After: ${after.name}\n- 비교 조건이 같지 않으면 수치 차이를 코드 개선 효과로 해석하지 않는다.\n\n| 지표 | Before | After | 변화 |\n|---|---:|---:|---:|\n${rows.map((row) => `| ${row.name} | ${fmt(row.before)} | ${fmt(row.after)} | ${pct(row.deltaRatio)} |`).join("\n")}\n`;
}

function renderHtml(before, after, rows) {
  const max = Math.max(1, ...rows.flatMap((row) => [row.before ?? 0, row.after ?? 0]));
  const chart = rows.map((row) => `<div class="metric"><strong>${escape(row.name)}</strong><div class="bars"><span class="before" style="width:${width(row.before, max)}%">${escape(fmt(row.before))}</span><span class="after" style="width:${width(row.after, max)}%">${escape(fmt(row.after))}</span></div><b class="${row.deltaRatio <= 0 ? "good" : "bad"}">${escape(pct(row.deltaRatio))}</b></div>`).join("");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Camellia Before After</title><style>body{margin:0;background:#111418;color:#f5f7fa;font:15px system-ui}.wrap{max-width:1050px;margin:auto;padding:40px 24px}.muted{color:#9aa7b7}.metric{display:grid;grid-template-columns:170px 1fr 80px;gap:14px;align-items:center;margin:18px 0}.bars{display:grid;gap:5px}.bars span{display:block;min-width:62px;padding:5px 8px;border-radius:5px;white-space:nowrap}.before{background:#566273}.after{background:#39a97a}.good{color:#67e8a5}.bad{color:#ff7474}.legend i{display:inline-block;width:12px;height:12px;margin:0 5px 0 14px}.legend .b{background:#566273}.legend .a{background:#39a97a}@media(max-width:700px){.metric{grid-template-columns:1fr}}</style></head><body><main class="wrap"><h1>Camellia 성능 Before / After</h1><p class="muted">${escape(before.name)} → ${escape(after.name)}</p><p class="legend"><i class="b"></i>Before <i class="a"></i>After</p>${chart}<p class="muted">동일 소스 digest·프로젝트 유형·캐시 상태·인프라 조건인 실행만 비교해야 합니다.</p></main></body></html>`;
}

async function json(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}
function width(value, max) { return Number.isFinite(value) ? Math.max(2, value / max * 100) : 2; }
function fmt(value) { return Number.isFinite(value) ? value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms` : "-"; }
function pct(value) { return Number.isFinite(value) ? `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)}%` : "-"; }
function escape(value) { return String(value).replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]); }
