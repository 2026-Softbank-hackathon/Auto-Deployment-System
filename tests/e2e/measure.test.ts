/**
 * tests/e2e/measure.test.ts
 *
 * 실제 Anthropic API 호출을 포함한 IR 도출 end-to-end 측정.
 * 4개 fixture를 순차로 실행 (병렬 시 pg-boss 경합) 하고
 * 측정값을 docs/measurement-2026-09-30.md 에 기록한다.
 *
 * 실행:
 *   set -a && source credentials/credentials.env && set +a
 *   export DATABASE_URL=postgres://camellia:camellia@localhost:5433/camellia
 *   pnpm test:e2e --run tests/e2e/measure.test.ts
 */

import { describe, it, expect, afterAll } from "vitest";
import FormData from "form-data";
import pg from "pg";
import PgBoss from "pg-boss";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { createPool } from "@camellia/db";
import { LocalStorage } from "@camellia/storage";
import { IrSchema } from "@camellia/ir-schema";
import { buildServer } from "../../apps/api/src/server.js";
import { registerAll } from "../../apps/worker/src/register.js";
import { createPgNotifier } from "../../apps/worker/src/notifier.js";
import {
  createSampleExpressZipBuffer,
  createSamplePythonFastapiZipBuffer,
  createSampleNodePostgresZipBuffer,
  createSampleMsaZipBuffer,
} from "./fixtures/create-sample-zip.js";
import type { FastifyInstance } from "fastify";
import type { Pool } from "@camellia/db";

// ── Types ─────────────────────────────────────────────────────────────────────

interface AnalysisReportRow {
  id: number;
  deployment_id: number;
  services_json: unknown;
  resources_json: unknown;
  warnings_json: unknown;
  unresolved_json: unknown;
  ir_valid: boolean;
}

interface IrVersionRow {
  id: number;
  deployment_id: number;
  ir_json: unknown;
  source: string;
}

interface AiUsageRow {
  id: number;
  deployment_id: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  estimated_cost_usd: string;
}

interface MeasurementRecord {
  fixtureName: string;
  zipBytes: number;
  deploymentId: string | null;
  elapsedSec: number | null;
  finalStatus: string;
  analysisReport: AnalysisReportRow | null;
  irVersion: IrVersionRow | null;
  aiUsage: AiUsageRow | null;
  irValid: boolean;
  irParseError: string | null;
  error: string | null;
}

// ── Config ────────────────────────────────────────────────────────────────────

const skipE2e = process.env["SKIP_E2E"] === "true";

const E2E_DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgres://camellia:camellia@localhost:5433/camellia";

const ANTHROPIC_KEY = process.env["ANTHROPIC_API_KEY"] ?? "";
const ANTHROPIC_MODEL = process.env["ANTHROPIC_MODEL"] ?? "(env not set)";

// 키 마스킹 (앞 8자만 + ***)
function maskKey(key: string): string {
  if (!key) return "(not set)";
  return key.slice(0, 8) + "***";
}

// ── Fixture definitions ───────────────────────────────────────────────────────

const FIXTURES = [
  { name: "Express", label: "Express Basic",         createZip: createSampleExpressZipBuffer,       target: "aws" },
  { name: "FastAPI", label: "Python FastAPI",         createZip: createSamplePythonFastapiZipBuffer, target: "aws" },
  { name: "NodePG",  label: "Node + Postgres",        createZip: createSampleNodePostgresZipBuffer,  target: "aws" },
  { name: "MSA",     label: "MSA",                    createZip: createSampleMsaZipBuffer,           target: "aws" },
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function runFixture(
  fixtureName: string,
  zipBuffer: Buffer,
  target: string,
  apiKey: string
): Promise<MeasurementRecord> {
  const record: MeasurementRecord = {
    fixtureName,
    zipBytes: zipBuffer.length,
    deploymentId: null,
    elapsedSec: null,
    finalStatus: "unknown",
    analysisReport: null,
    irVersion: null,
    aiUsage: null,
    irValid: false,
    irParseError: null,
    error: null,
  };

  const storageTmp = await fs.mkdtemp(path.join(os.tmpdir(), `camellia-measure-${fixtureName}-`));
  let server: FastifyInstance | null = null;
  let pool: Pool | null = null;
  let boss: PgBoss | null = null;

  try {
    pool = createPool(E2E_DATABASE_URL);
    boss = new PgBoss({ connectionString: E2E_DATABASE_URL });
    const storage = new LocalStorage({ rootDir: storageTmp });
    const notifier = createPgNotifier(pool);

    // Set the API key in env so analyzeWithAI picks it up
    if (apiKey) {
      process.env["ANTHROPIC_API_KEY"] = apiKey;
    }

    server = await buildServer({
      pool,
      boss,
      storage,
      nodeEnv: "development",
      logger: false,
      enablePgListener: false,
    });

    await boss.start();
    await registerAll(boss, { pool, boss, storage, notifier });
    await server.ready();

    // Create project
    const projectRes = await server.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: {
        name: `measure-${fixtureName}-${Date.now()}`,
        description: `measurement fixture ${fixtureName}`,
      },
    });
    if (projectRes.statusCode !== 201) {
      throw new Error(`project creation failed: ${projectRes.statusCode} ${projectRes.body}`);
    }
    const project = projectRes.json<{ id: string }>();

    // Upload zip
    const form = new FormData();
    form.append("project_id", project.id);
    form.append("target", target);
    form.append("source", zipBuffer, {
      filename: `${fixtureName}.zip`,
      contentType: "application/zip",
    });

    const uploadStart = Date.now();
    const uploadRes = await server.inject({
      method: "POST",
      url: "/api/v1/deployments",
      headers: form.getHeaders(),
      payload: form.getBuffer(),
    });

    if (uploadRes.statusCode !== 202) {
      throw new Error(`upload failed: ${uploadRes.statusCode} ${uploadRes.body}`);
    }

    const { deploymentId } = uploadRes.json<{ deploymentId: string }>();
    record.deploymentId = deploymentId;

    // Wait for analysis (up to 120s for AI calls)
    const deadline = Date.now() + 120_000;
    let status = "";
    while (Date.now() < deadline) {
      const res = await server.inject({
        method: "GET",
        url: `/api/v1/deployments/${deploymentId}`,
      });
      if (res.statusCode === 200) {
        const body = res.json<{ status: string }>();
        status = body.status;
        if (status === "awaiting_target_confirmation" || status === "failed") {
          break;
        }
      }
      await new Promise<void>((r) => setTimeout(r, 500));
    }

    record.elapsedSec = (Date.now() - uploadStart) / 1000;
    record.finalStatus = status;

    // Query analysis_reports
    const reportRes = await pool.query<AnalysisReportRow>(
      `SELECT id, deployment_id, services_json, resources_json, warnings_json, unresolved_json, ir_valid
       FROM analysis_reports WHERE deployment_id = $1 ORDER BY id DESC LIMIT 1`,
      [deploymentId]
    );
    if (reportRes.rows.length > 0) {
      record.analysisReport = reportRes.rows[0]!;
    }

    // Query ir_versions
    const irRes = await pool.query<IrVersionRow>(
      `SELECT id, deployment_id, ir_json, source FROM ir_versions WHERE deployment_id = $1 ORDER BY id DESC LIMIT 1`,
      [deploymentId]
    );
    if (irRes.rows.length > 0) {
      record.irVersion = irRes.rows[0]!;

      // Validate IR
      const parsed = IrSchema.safeParse(irRes.rows[0]!.ir_json);
      record.irValid = parsed.success;
      if (!parsed.success) {
        record.irParseError = JSON.stringify(parsed.error?.issues?.slice(0, 3));
      }
    }

    // Query ai_usage
    const aiRes = await pool.query<AiUsageRow>(
      `SELECT id, deployment_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, estimated_cost_usd
       FROM ai_usage WHERE deployment_id = $1 ORDER BY id DESC LIMIT 1`,
      [deploymentId]
    );
    if (aiRes.rows.length > 0) {
      record.aiUsage = aiRes.rows[0]!;
    }

  } catch (err) {
    record.error = err instanceof Error ? err.message : String(err);
  } finally {
    try { await server?.close(); } catch { /* ignore */ }
    try { await boss?.stop({ graceful: false }); } catch { /* ignore */ }
    try { await pool?.end(); } catch { /* ignore */ }
    try { await fs.rm(storageTmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  return record;
}

// ── State ─────────────────────────────────────────────────────────────────────

const results: MeasurementRecord[] = [];
const measuredAt = new Date().toISOString();

// ── Describe ──────────────────────────────────────────────────────────────────

describe.skipIf(skipE2e)("measure: IR derivation end-to-end (real API)", () => {

  // Run fixtures sequentially to avoid pg-boss contention
  for (const fixture of FIXTURES) {
    it(`fixture: ${fixture.label}`, async () => {
      const zipBuffer = fixture.createZip();
      const rec = await runFixture(
        fixture.name,
        zipBuffer,
        fixture.target,
        ANTHROPIC_KEY
      );
      results.push(rec);

      // Minimal assertion — IR must be valid when status reached
      if (rec.finalStatus === "awaiting_target_confirmation") {
        expect(rec.irValid, `IR invalid for ${fixture.name}: ${rec.irParseError ?? ""}`).toBe(true);
      }

      // Rate-limit buffer between fixtures
      await new Promise<void>((r) => setTimeout(r, 2000));
    }, 150_000); // 2.5 min per fixture
  }

  // ── afterAll: write report ─────────────────────────────────────────────────

  afterAll(async () => {
    const report = buildReport(results, measuredAt, ANTHROPIC_MODEL);
    const docsDir = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../../docs"
    );
    await fs.mkdir(docsDir, { recursive: true });
    const reportPath = path.join(docsDir, "measurement-2026-09-30.md");
    await fs.writeFile(reportPath, report, "utf8");
    process.stdout.write(`[measure] report written to ${reportPath}\n`);
  });
});

// ── Report builder ─────────────────────────────────────────────────────────────

function safeNum(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function fmt2(n: number): string {
  return n.toFixed(2);
}

function fmtCost(v: string | number | undefined | null): string {
  if (v == null) return "-";
  const n = Number(v);
  if (isNaN(n)) return "-";
  return `$${n.toFixed(6)}`;
}

function buildReport(
  records: MeasurementRecord[],
  measuredAt: string,
  model: string
): string {
  const lines: string[] = [];

  lines.push(`# 실제 IR 도출 측정 보고서 (2026-09-30)`);
  lines.push(``);
  lines.push(`## 환경`);
  lines.push(`- Postgres: camellia-postgres:5433`);
  lines.push(`- Model: ${model}`);
  lines.push(`- Anthropic API Key: ${maskKey(ANTHROPIC_KEY)}`);
  lines.push(`- 측정 시각: ${measuredAt}`);
  lines.push(``);

  // ── Summary table
  lines.push(`## 요약`);
  lines.push(``);
  lines.push(`| Fixture | zip 크기 | 총 시간 | AI 호출 | 입력 tokens | 출력 tokens | 비용 USD | IR valid |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);

  let totalInTokens = 0;
  let totalOutTokens = 0;
  let totalCost = 0;
  let aiCalledCount = 0;

  const fixtureLabels: Record<string, string> = {
    Express: "Express",
    FastAPI: "Python FastAPI",
    NodePG:  "Node + Postgres",
    MSA:     "MSA",
  };

  for (const rec of records) {
    const label = fixtureLabels[rec.fixtureName] ?? rec.fixtureName;
    const zipKb = `${(rec.zipBytes / 1024).toFixed(1)} KB`;
    const elapsed = rec.elapsedSec != null ? `${fmt2(rec.elapsedSec)}s` : "-";
    const aiCalled = rec.aiUsage != null ? "Y" : "N";
    const inTok = rec.aiUsage ? safeNum(rec.aiUsage.input_tokens).toLocaleString() : "-";
    const outTok = rec.aiUsage ? safeNum(rec.aiUsage.output_tokens).toLocaleString() : "-";
    const cost = rec.aiUsage ? fmtCost(rec.aiUsage.estimated_cost_usd) : "-";
    const irValidMark = rec.error ? "ERR" : (rec.irValid ? "✓" : "✗");

    if (rec.aiUsage) {
      aiCalledCount++;
      totalInTokens += safeNum(rec.aiUsage.input_tokens);
      totalOutTokens += safeNum(rec.aiUsage.output_tokens);
      totalCost += safeNum(rec.aiUsage.estimated_cost_usd);
    }

    lines.push(`| ${label} | ${zipKb} | ${elapsed} | ${aiCalled} | ${inTok} | ${outTok} | ${cost} | ${irValidMark} |`);
  }

  const totalCostStr = `$${totalCost.toFixed(6)}`;
  lines.push(`| **합계** | | | ${aiCalledCount}/${records.length} | ${totalInTokens.toLocaleString()} | ${totalOutTokens.toLocaleString()} | **${totalCostStr}** | |`);
  lines.push(``);

  // ── Detection detail
  lines.push(`## 감지 결과 상세`);
  lines.push(``);

  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    const label = fixtureLabels[rec.fixtureName] ?? rec.fixtureName;
    lines.push(`### Fixture ${i + 1}: ${label}`);
    lines.push(``);

    if (rec.error) {
      lines.push(`- **오류**: ${rec.error}`);
      lines.push(``);
      continue;
    }

    const report = rec.analysisReport;
    if (!report) {
      lines.push(`- 분석 리포트 없음 (status: ${rec.finalStatus})`);
      lines.push(``);
      continue;
    }

    // Services
    const services = Array.isArray(report.services_json)
      ? (report.services_json as Record<string, unknown>[])
      : Object.entries(report.services_json as Record<string, unknown>).map(([k, v]) => ({ name: k, ...(v as object) }));

    lines.push(`- 감지된 서비스: ${services.length}개`);
    for (const svc of services) {
      const name = String(svc["name"] ?? svc["service_name"] ?? "unknown");
      const lang = String(svc["language"] ?? "-");
      const fw = String(svc["framework"] ?? "-");
      const port = svc["port"] != null ? String(svc["port"]) : "-";
      const envArr = Array.isArray(svc["env_names"]) ? (svc["env_names"] as string[]) : [];
      lines.push(`  - ${name}: language=${lang}, framework=${fw}, port=${port}, env_names=${envArr.length}개 [${envArr.slice(0, 5).join(", ")}${envArr.length > 5 ? ", ..." : ""}]`);
    }

    // Resources
    const resources = Array.isArray(report.resources_json)
      ? (report.resources_json as Record<string, unknown>[])
      : Object.entries(report.resources_json as Record<string, unknown>).map(([k, v]) => ({ name: k, ...(v as object) }));
    const resTypes = resources.map((r) => String(r["type"] ?? "unknown")).join(", ");
    lines.push(`- 리소스: ${resources.length}개${resources.length > 0 ? ` (${resTypes})` : ""}`);

    // Warnings
    const warnings = Array.isArray(report.warnings_json) ? report.warnings_json : [];
    lines.push(`- Warnings: ${warnings.length}개`);

    // Unresolved
    const unresolved = Array.isArray(report.unresolved_json) ? report.unresolved_json : [];
    lines.push(`- Unresolved (규칙 후): ${unresolved.length}개`);
    if (unresolved.length > 0) {
      const snippets = unresolved.slice(0, 5).map((u) => {
        if (typeof u === "string") return u;
        if (u && typeof u === "object") {
          const o = u as Record<string, unknown>;
          return `${o["service"] ?? o["field"] ?? JSON.stringify(u).slice(0, 60)}`;
        }
        return String(u);
      });
      lines.push(`  - ${snippets.join(", ")}${unresolved.length > 5 ? ", ..." : ""}`);
    }

    // IR source
    if (rec.irVersion) {
      lines.push(`- IR source: ${rec.irVersion.source}`);
    }
    lines.push(`- IR valid: ${rec.irValid ? "true" : "false"}${rec.irParseError ? ` (${rec.irParseError})` : ""}`);
    lines.push(``);
  }

  // ── AI usage detail
  lines.push(`## AI 사용 상세`);
  lines.push(``);
  lines.push(`| 배포 ID | fixture | model | in tokens | out tokens | cache creation | cache read | cost USD |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);

  for (const rec of records) {
    if (!rec.aiUsage) continue;
    const label = fixtureLabels[rec.fixtureName] ?? rec.fixtureName;
    const u = rec.aiUsage;
    lines.push(`| ${rec.deploymentId ?? "-"} | ${label} | ${u.model} | ${safeNum(u.input_tokens).toLocaleString()} | ${safeNum(u.output_tokens).toLocaleString()} | ${safeNum(u.cache_creation_tokens).toLocaleString()} | ${safeNum(u.cache_read_tokens).toLocaleString()} | ${fmtCost(u.estimated_cost_usd)} |`);
  }

  if (records.every((r) => !r.aiUsage)) {
    lines.push(`| (AI 호출 없음 — API key 미설정 또는 unresolved 없음) | | | | | | | |`);
  }

  lines.push(``);

  // ── IR JSON appendix
  lines.push(`## 최종 IR JSON (부록)`);
  lines.push(``);

  for (const rec of records) {
    const label = fixtureLabels[rec.fixtureName] ?? rec.fixtureName;
    lines.push(`### ${label}`);
    lines.push(``);

    if (rec.error) {
      lines.push(`오류로 인해 IR 없음: ${rec.error}`);
      lines.push(``);
      continue;
    }

    if (!rec.irVersion) {
      lines.push(`IR 버전 없음 (status: ${rec.finalStatus})`);
      lines.push(``);
      continue;
    }

    lines.push("```json");
    lines.push(JSON.stringify(rec.irVersion.ir_json, null, 2));
    lines.push("```");
    lines.push(``);
  }

  // ── Insights
  lines.push(`## 인사이트`);
  lines.push(``);

  const successCount = records.filter((r) => r.finalStatus === "awaiting_target_confirmation").length;
  const irValidCount = records.filter((r) => r.irValid).length;
  const avgElapsed = records
    .filter((r) => r.elapsedSec != null)
    .reduce((sum, r) => sum + (r.elapsedSec ?? 0), 0) / Math.max(1, records.filter((r) => r.elapsedSec != null).length);

  lines.push(`- 분석 성공: ${successCount}/${records.length} fixture`);
  lines.push(`- IR valid: ${irValidCount}/${records.length} fixture`);
  lines.push(`- AI 호출: ${aiCalledCount}/${records.length} fixture에서 AI가 unresolved 필드 채움`);

  if (aiCalledCount > 0) {
    const avgCost = totalCost / aiCalledCount;
    lines.push(`- 비용 효율: AI 호출 1회당 평균 ${fmtCost(avgCost)} (하루 100회면 $${(avgCost * 100).toFixed(4)} 예상)`);
  } else {
    lines.push(`- 비용 효율: AI 호출 없음 (API key 미설정 또는 unresolved 없음)`);
  }

  lines.push(`- 평균 분석 시간: ${fmt2(avgElapsed)}s`);

  const failedRecords = records.filter((r) => r.error != null);
  if (failedRecords.length > 0) {
    lines.push(`- 실패 시나리오: ${failedRecords.map((r) => `${r.fixtureName}(${r.error})`).join(", ")}`);
  } else {
    lines.push(`- 실패 시나리오: 없음`);
  }

  lines.push(`- 감지 정확도: ${irValidCount}/${records.length} IR valid`);
  lines.push(``);

  return lines.join("\n");
}
