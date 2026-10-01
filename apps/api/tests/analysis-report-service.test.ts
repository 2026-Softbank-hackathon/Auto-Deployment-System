/**
 * apps/api/tests/analysis-report-service.test.ts
 * AnalysisReportService.get — missingEnvNames 계산 로직 유닛 테스트.
 */

import { describe, it, expect, vi } from "vitest";
import type { Pool } from "@camellia/db";
import { AnalysisReportService } from "../src/services/analysis-report-service.js";

const NOW = new Date("2026-09-30T03:00:00.000Z");

type Row = Record<string, unknown>;

/** 순차 호출마다 지정된 rows 배열을 반환하는 mock pool. */
function mockPool(responses: Row[][]): Pool {
  let call = 0;
  const query = vi.fn(async () => {
    const rows = responses[call++] ?? [];
    return { rows, rowCount: rows.length };
  });
  return { query } as unknown as Pool;
}

/** 최소 분석 리포트 DB 행 */
function reportRow(projectId = 1) {
  return {
    services_json: [{ name: "api", language: "node" }],
    resources_json: [],
    warnings_json: [],
    unresolved_json: [],
    ir_valid: true,
    ir_errors_json: null,
    created_at: NOW,
    project_id: projectId,
  };
}

/** IR JSON 헬퍼 */
function irJson(env: string[], envDefaults: Record<string, string> = {}) {
  return {
    $ir_version: "0.1.0",
    metadata: { name: "test-app", version: "1.0.0" },
    services: {
      api: {
        type: "http",
        port: 3000,
        env,
        env_defaults: envDefaults,
      },
    },
    deploy: { profile: "aws-ecs-basic" },
  };
}

describe("AnalysisReportService.get — missingEnvNames", () => {
  it("IR 버전이 없으면 missingEnvNames 가 null 이다", async () => {
    // 응답 순서: [analysis_reports JOIN, ir_versions]
    const pool = mockPool([[reportRow()], [/* ir_versions 없음 */]]);
    const svc = new AnalysisReportService(pool);
    const r = await svc.get(42);
    expect(r.missingEnvNames).toBeNull();
  });

  it("env 선언이 없으면 빈 배열이다", async () => {
    const pool = mockPool([
      [reportRow()],
      [{ ir_json: irJson([]) }],
      [/* env_vars — 호출되지 않아도 됨 */],
    ]);
    const svc = new AnalysisReportService(pool);
    const r = await svc.get(42);
    expect(r.missingEnvNames).toEqual([]);
  });

  it("env 변수가 모두 DB 에 등록돼 있으면 빈 배열이다", async () => {
    const pool = mockPool([
      [reportRow()],
      [{ ir_json: irJson(["DB_URL", "API_KEY"]) }],
      [{ name: "DB_URL" }, { name: "API_KEY" }],
    ]);
    const svc = new AnalysisReportService(pool);
    const r = await svc.get(42);
    expect(r.missingEnvNames).toEqual([]);
  });

  it("env_defaults 에 있는 변수는 missing 에서 제외된다", async () => {
    const pool = mockPool([
      [reportRow()],
      [{ ir_json: irJson(["DB_URL", "LOG_LEVEL"], { LOG_LEVEL: "info" }) }],
      [/* DB 에 아무것도 없음 */],
    ]);
    const svc = new AnalysisReportService(pool);
    const r = await svc.get(42);
    // LOG_LEVEL 은 env_defaults 에 있어서 제외, DB_URL 만 missing
    expect(r.missingEnvNames).toEqual(["DB_URL"]);
  });

  it("플랫폼 자동 주입 변수(PORT, NODE_ENV 등)는 missing 에서 제외된다", async () => {
    const pool = mockPool([
      [reportRow()],
      [{ ir_json: irJson(["PORT", "NODE_ENV", "AWS_REGION", "DEPLOY_TARGET", "DB_URL"]) }],
      [/* DB 에 아무것도 없음 */],
    ]);
    const svc = new AnalysisReportService(pool);
    const r = await svc.get(42);
    // 플랫폼 자동 주입 4개는 제외, DB_URL 만 missing
    expect(r.missingEnvNames).toEqual(["DB_URL"]);
  });

  it("DB 미등록 + env_defaults 없음 + 플랫폼 주입 아님 → missing 에 포함된다", async () => {
    const pool = mockPool([
      [reportRow()],
      [{ ir_json: irJson(["DB_URL", "REDIS_URL", "NODE_ENV"]) }],
      [{ name: "DB_URL" }],
    ]);
    const svc = new AnalysisReportService(pool);
    const r = await svc.get(42);
    // DB_URL 은 등록됨, NODE_ENV 는 플랫폼 주입, REDIS_URL 만 missing
    expect(r.missingEnvNames).toEqual(["REDIS_URL"]);
  });

  it("분석 리포트가 없으면 404 를 던진다", async () => {
    const pool = mockPool([
      [/* analysis_reports 없음 */],
      [/* ir_versions */],
    ]);
    const svc = new AnalysisReportService(pool);
    await expect(svc.get(99)).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    });
  });
});
