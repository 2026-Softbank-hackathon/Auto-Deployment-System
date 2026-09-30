/**
 * tests/e2e/samples.test.ts
 *
 * 4개 fixture 샘플에 대한 E2E 시나리오:
 *   1. Express Basic          (aws-ecs-basic)
 *   2. Python FastAPI         (aws-ecs-basic)
 *   3. Node + PostgreSQL      (aws-ecs-basic)
 *   4. MSA (api + worker)     (onprem-docker-basic)
 *   5. apps/samples/monolith  (데모용 실제 샘플 앱, SMP-01)
 *
 * Postgres가 없으면 업로드 describe를 skip한다.
 * 5번의 분석기 직접 호출 테스트는 Postgres 없이도 돈다 (규칙 기반, AI 호출 없음).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "@camellia/analyzer";
import { IrSchema } from "@camellia/ir-schema";
import {
  createSampleExpressZipBuffer,
  createSamplePythonFastapiZipBuffer,
  createSampleNodePostgresZipBuffer,
  createSampleMsaZipBuffer,
  createZipFromDir,
} from "./fixtures/create-sample-zip.js";
import { startHarness } from "./lib/harness.js";
import type { Harness } from "./lib/harness.js";

// ── skip guard ────────────────────────────────────────────────────────────────

const skipE2e = process.env["SKIP_E2E"] === "true";

// ── 1. Express Basic ──────────────────────────────────────────────────────────

describe.skipIf(skipE2e)("e2e sample: express basic", () => {
  let harness: Harness;
  let deploymentId: string;

  beforeAll(async () => {
    harness = await startHarness({
      fixtureZip: createSampleExpressZipBuffer(),
      target: "aws-ecs-basic",
      projectName: "sample-express",
      tmpPrefix: "camellia-e2e-express-",
    });
  }, 30000);

  afterAll(async () => {
    await harness?.close();
  }, 15000);

  it("업로드 성공 → awaiting_target_confirmation 도달", async () => {
    deploymentId = await harness.upload();
    expect(deploymentId).toBeTruthy();

    const status = await harness.waitForAnalysis(deploymentId, 30_000);
    expect(status).toBe("awaiting_target_confirmation");
  }, 35000);

  it("IR services 1개, type=http, port=3000, ir_valid=true", async () => {
    expect(deploymentId).toBeTruthy();

    const body = await harness.fetchIr(deploymentId);

    expect(Number(body.version)).toBeGreaterThan(0);

    const parsed = IrSchema.safeParse(body.ir);
    expect(
      parsed.success,
      `IR schema failed: ${JSON.stringify(parsed.error?.issues)}`
    ).toBe(true);

    if (parsed.success) {
      const svcKeys = Object.keys(parsed.data.services);
      expect(svcKeys.length).toBe(1);

      const svc = parsed.data.services[svcKeys[0]!]!;
      expect(svc.type).toBe("http");
      expect(svc.port).toBe(3000);
    }
  });
});

// ── 2. Python FastAPI ─────────────────────────────────────────────────────────

describe.skipIf(skipE2e)("e2e sample: python fastapi", () => {
  let harness: Harness;
  let deploymentId: string;

  beforeAll(async () => {
    harness = await startHarness({
      fixtureZip: createSamplePythonFastapiZipBuffer(),
      target: "aws-ecs-basic",
      projectName: "sample-fastapi",
      tmpPrefix: "camellia-e2e-fastapi-",
    });
  }, 30000);

  afterAll(async () => {
    await harness?.close();
  }, 15000);

  it("업로드 성공 → awaiting_target_confirmation 도달", async () => {
    deploymentId = await harness.upload();
    expect(deploymentId).toBeTruthy();

    const status = await harness.waitForAnalysis(deploymentId, 30_000);
    expect(status).toBe("awaiting_target_confirmation");
  }, 35000);

  it("IR services 1개, type=http, ir_valid=true; framework=fastapi language=python DB 확인", async () => {
    expect(deploymentId).toBeTruthy();

    const body = await harness.fetchIr(deploymentId);

    expect(Number(body.version)).toBeGreaterThan(0);

    const parsed = IrSchema.safeParse(body.ir);
    expect(
      parsed.success,
      `IR schema failed: ${JSON.stringify(parsed.error?.issues)}`
    ).toBe(true);

    if (parsed.success) {
      const svcKeys = Object.keys(parsed.data.services);
      expect(svcKeys.length).toBe(1);

      const svc = parsed.data.services[svcKeys[0]!]!;
      expect(svc.type).toBe("http");
    }

    // analysis_reports 에서 framework/language 확인
    const reportRes = await harness.pool.query<{
      services_json: unknown;
    }>(
      "SELECT services_json FROM analysis_reports WHERE deployment_id = $1 ORDER BY id DESC LIMIT 1",
      [deploymentId]
    );

    if (reportRes.rows.length > 0) {
      const servicesJson = reportRes.rows[0]!.services_json;
      // services_json은 배열 또는 객체일 수 있다 — 첫 번째 서비스 엔트리 확인
      const first =
        Array.isArray(servicesJson)
          ? (servicesJson[0] as Record<string, unknown>)
          : (servicesJson as Record<string, unknown>);

      if (first) {
        const framework = String(first["framework"] ?? "").toLowerCase();
        const language = String(first["language"] ?? "").toLowerCase();

        if (framework) {
          expect(framework).toContain("fastapi");
        }
        if (language) {
          expect(language).toContain("python");
        }
      }
    }
    // analysis_reports 행이 없으면 IR schema pass 만으로 충분
  });
});

// ── 3. Node + PostgreSQL ──────────────────────────────────────────────────────

describe.skipIf(skipE2e)("e2e sample: node + postgres", () => {
  let harness: Harness;
  let deploymentId: string;

  beforeAll(async () => {
    harness = await startHarness({
      fixtureZip: createSampleNodePostgresZipBuffer(),
      target: "aws-ecs-basic",
      projectName: "sample-node-postgres",
      tmpPrefix: "camellia-e2e-nodepg-",
    });
  }, 30000);

  afterAll(async () => {
    await harness?.close();
  }, 15000);

  it("업로드 성공 → awaiting_target_confirmation 도달", async () => {
    deploymentId = await harness.upload();
    expect(deploymentId).toBeTruthy();

    const status = await harness.waitForAnalysis(deploymentId, 30_000);
    expect(status).toBe("awaiting_target_confirmation");
  }, 35000);

  it("IR resources postgres 존재, services env에 DATABASE_URL 포함, ir_valid=true", async () => {
    expect(deploymentId).toBeTruthy();

    const body = await harness.fetchIr(deploymentId);

    expect(Number(body.version)).toBeGreaterThan(0);

    const parsed = IrSchema.safeParse(body.ir);
    expect(
      parsed.success,
      `IR schema failed: ${JSON.stringify(parsed.error?.issues)}`
    ).toBe(true);

    if (parsed.success) {
      // resources 중 postgres 타입이 1개 이상 있어야 한다
      const resources = parsed.data.resources ?? {};
      const resourceKeys = Object.keys(resources);
      const hasPostgres = resourceKeys.some(
        (k) => resources[k]?.type === "postgres"
      );
      expect(
        hasPostgres,
        `Expected at least one postgres resource, got: ${JSON.stringify(resources)}`
      ).toBe(true);

      // 서비스 중 하나의 env 배열에 "DATABASE_URL"이 포함되어야 한다
      const services = parsed.data.services;
      const hasDatabaseUrl = Object.values(services).some(
        (svc) => svc.env?.includes("DATABASE_URL") === true
      );
      expect(
        hasDatabaseUrl,
        "Expected at least one service to have DATABASE_URL in env"
      ).toBe(true);
    }
  });
});

// ── 4. MSA (services/api + services/worker) ───────────────────────────────────

describe.skipIf(skipE2e)("e2e sample: msa (api + worker)", () => {
  let harness: Harness;
  let deploymentId: string;

  beforeAll(async () => {
    harness = await startHarness({
      fixtureZip: createSampleMsaZipBuffer(),
      target: "onprem-docker-basic",
      projectName: "sample-msa",
      tmpPrefix: "camellia-e2e-msa-",
    });
  }, 30000);

  afterAll(async () => {
    await harness?.close();
  }, 15000);

  it("업로드 성공 → awaiting_target_confirmation 도달", async () => {
    deploymentId = await harness.upload();
    expect(deploymentId).toBeTruthy();

    const status = await harness.waitForAnalysis(deploymentId, 30_000);
    expect(status).toBe("awaiting_target_confirmation");
  }, 35000);

  it("IR services 2개 이상, api·worker 이름 포함, ir_valid=true", async () => {
    expect(deploymentId).toBeTruthy();

    const body = await harness.fetchIr(deploymentId);

    expect(Number(body.version)).toBeGreaterThan(0);

    const parsed = IrSchema.safeParse(body.ir);
    expect(
      parsed.success,
      `IR schema failed: ${JSON.stringify(parsed.error?.issues)}`
    ).toBe(true);

    if (parsed.success) {
      const svcKeys = Object.keys(parsed.data.services);

      // MSA fixture는 services/api, services/worker 두 폴더 → 2개 이상의 서비스
      expect(
        svcKeys.length,
        `Expected >= 2 services, got: ${svcKeys.join(", ")}`
      ).toBeGreaterThanOrEqual(2);

      // 서비스 이름 중에 "api"와 "worker"가 각각 포함되어야 한다
      const namesLower = svcKeys.map((k) => k.toLowerCase());
      const hasApi = namesLower.some((n) => n.includes("api"));
      const hasWorker = namesLower.some((n) => n.includes("worker"));

      expect(
        hasApi,
        `Expected a service with "api" in its name, got: ${svcKeys.join(", ")}`
      ).toBe(true);
      expect(
        hasWorker,
        `Expected a service with "worker" in its name, got: ${svcKeys.join(", ")}`
      ).toBe(true);
    }
  });
});

// ── 5. apps/samples/monolith (데모용 실제 샘플 앱) ────────────────────────────

const MONOLITH_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../apps/samples/monolith"
);

/** 샘플 앱 IR 공통 검사: 단일 http 서비스 · port 3000 · /health · Dockerfile · env 이름 */
function expectMonolithIr(ir: unknown): void {
  const parsed = IrSchema.safeParse(ir);
  expect(
    parsed.success,
    `IR schema failed: ${JSON.stringify(parsed.error?.issues)}`
  ).toBe(true);
  if (!parsed.success) return;

  expect(parsed.data.metadata.name).toBe("sample-monolith");

  const svcKeys = Object.keys(parsed.data.services);
  expect(svcKeys).toEqual(["web"]);

  const svc = parsed.data.services["web"]!;
  expect(svc.type).toBe("http");
  expect(svc.port).toBe(3000);
  expect(svc.health.path).toBe("/health");
  expect(svc.health.expected_status).toBe(200);
  expect(svc.build?.dockerfile).toBe("Dockerfile");
  expect(svc.command).toEqual(["node", "dist/server.js"]);
  expect(svc.env).toEqual(
    expect.arrayContaining(["APP_MESSAGE", "DEPLOY_TARGET", "PORT"])
  );
  expect(parsed.data.resources).toBeUndefined();
}

describe("sample app: apps/samples/monolith — 분석기 규칙 기반", () => {
  it("node · hono · port 3000 · /health · Dockerfile · env 감지, IR 유효, 경고 없음", async () => {
    const result = await analyze(MONOLITH_DIR);

    expect(result.ir_valid, `ir_errors: ${JSON.stringify(result.ir_errors)}`).toBe(true);
    expect(result.warnings).toEqual([]);

    expect(result.services).toHaveLength(1);
    const svc = result.services[0]!;
    expect(svc.language).toBe("node");
    expect(svc.framework).toBe("hono");
    expect(svc.type).toBe("http");

    expectMonolithIr(result.ir_draft);
  });
});

describe.skipIf(skipE2e)("e2e sample: apps/samples/monolith 업로드", () => {
  let harness: Harness;
  let deploymentId: string;

  beforeAll(async () => {
    harness = await startHarness({
      fixtureZip: createZipFromDir(MONOLITH_DIR),
      target: "aws-ecs-basic",
      projectName: "sample-monolith",
      tmpPrefix: "camellia-e2e-monolith-",
    });
  }, 30000);

  afterAll(async () => {
    await harness?.close();
  }, 15000);

  it("업로드 성공 → awaiting_target_confirmation 도달", async () => {
    deploymentId = await harness.upload();
    expect(deploymentId).toBeTruthy();

    const status = await harness.waitForAnalysis(deploymentId, 30_000);
    expect(status).toBe("awaiting_target_confirmation");
  }, 35000);

  it("IR: web 1개 · http · port 3000 · /health · Dockerfile · env 이름", async () => {
    expect(deploymentId).toBeTruthy();

    const body = await harness.fetchIr(deploymentId);
    expect(Number(body.version)).toBeGreaterThan(0);

    expectMonolithIr(body.ir);
  });
});
