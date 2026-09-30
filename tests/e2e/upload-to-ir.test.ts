/**
 * tests/e2e/upload-to-ir.test.ts
 *
 * End-to-end 통합 테스트:
 *   1. 업로드 성공 (202 + deployment_id)
 *   2. analyze 완료 대기 (status = "awaiting_target_confirmation", 최대 30s)
 *   3. IR 조회 (200, IrSchema.parse 통과, services.api.type = "http", Dockerfile 감지)
 *   4. target approve (200, newStatus = "queued")
 *
 * Postgres가 없으면 전체 describe를 skip한다.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import FormData from "form-data";
import pg from "pg";
import PgBoss from "pg-boss";
import { createPool } from "@camellia/db";
import { LocalStorage } from "@camellia/storage";
import { IrSchema } from "@camellia/ir-schema";
import { buildServer } from "../../apps/api/src/server.js";
import { registerAll } from "../../apps/worker/src/register.js";
import { createPgNotifier } from "../../apps/worker/src/notifier.js";
import { createSampleZipBuffer } from "./fixtures/create-sample-zip.js";
import type { FastifyInstance } from "fastify";
import type { Pool } from "@camellia/db";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

// ── skip guard ────────────────────────────────────────────────────────────────

const skipE2e = process.env["SKIP_E2E"] === "true";

// setup.ts에서 이미 process.env.DATABASE_URL을 e2e DB로 오버라이드했음. env 우선.
const E2E_DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgres://camellia:camellia@localhost:5432/camellia_e2e";

// ── describe block ────────────────────────────────────────────────────────────

describe.skipIf(skipE2e)("e2e: upload → analyze → IR → approve", () => {
  let server: FastifyInstance;
  let pool: Pool;
  let boss: PgBoss;
  let storageTmp: string;
  let deploymentId: string;

  // ── setup ──────────────────────────────────────────────────────────────────

  beforeAll(async () => {
    // Temporary storage directory
    storageTmp = await fs.mkdtemp(path.join(os.tmpdir(), "camellia-e2e-"));

    pool = createPool(E2E_DATABASE_URL);
    boss = new PgBoss({ connectionString: E2E_DATABASE_URL });

    const storage = new LocalStorage({ rootDir: storageTmp });
    const notifier = createPgNotifier(pool);

    // Build API server (pg-listener disabled — same process, no relay needed)
    server = await buildServer({
      pool,
      boss,
      storage,
      nodeEnv: "development",
      logger: false,
      enablePgListener: false,
    });

    await boss.start();

    // Register worker handlers in same process
    await registerAll(boss, {
      pool,
      boss,
      storage,
      notifier,
      // No AI key in e2e — analyzeWithAI will skip AI step gracefully
    });

    await server.ready();
  }, 30000);

  afterAll(async () => {
    await server?.close();
    await boss?.stop({ graceful: false });
    await pool?.end();
    await fs.rm(storageTmp, { recursive: true, force: true });
  }, 15000);

  // ── Test 1: 업로드 성공 ────────────────────────────────────────────────────

  it("POST /api/v1/deployments returns 202 + deployment_id", async () => {
    // First create a project
    const projectRes = await server.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: `e2e-project-${Date.now()}`, description: "e2e test project" },
    });
    expect(projectRes.statusCode).toBe(201);
    const project = projectRes.json<{ id: string }>();

    // Upload zip
    const zipBuffer = createSampleZipBuffer();
    const form = new FormData();
    form.append("project_id", project.id);
    form.append("target", "aws");
    form.append("source", zipBuffer, {
      filename: "sample-express.zip",
      contentType: "application/zip",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/deployments",
      headers: form.getHeaders(),
      payload: form.getBuffer(),
    });

    expect(res.statusCode).toBe(202);
    const body = res.json<{ deploymentId: string; status: string; eventsUrl: string }>();
    expect(body.deploymentId).toBeTruthy();
    expect(body.status).toBe("received");
    expect(body.eventsUrl).toContain(`/api/v1/deployments/${body.deploymentId}/events`);

    deploymentId = body.deploymentId;
  });

  // ── Test 2: analyze 완료 대기 ─────────────────────────────────────────────

  it("deployment reaches awaiting_target_confirmation within 30s", async () => {
    expect(deploymentId).toBeTruthy();

    const deadline = Date.now() + 30_000;
    let status = "";

    while (Date.now() < deadline) {
      const res = await server.inject({
        method: "GET",
        url: `/api/v1/deployments/${deploymentId}`,
      });

      if (res.statusCode === 200) {
        const body = res.json<{ status: string }>();
        status = body.status;
        if (
          status === "awaiting_target_confirmation" ||
          status === "failed"
        ) {
          break;
        }
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    // analyze may skip AI and land on awaiting_target_confirmation
    // If ANTHROPIC_API_KEY is absent analyzeWithAI still produces a draft IR
    expect(status).toBe("awaiting_target_confirmation");
  }, 35000);

  // ── Test 3: IR 조회 ────────────────────────────────────────────────────────

  it("GET /api/v1/deployments/:id/ir returns valid IR with http service", async () => {
    expect(deploymentId).toBeTruthy();

    const res = await server.inject({
      method: "GET",
      url: `/api/v1/deployments/${deploymentId}/ir`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ ir: unknown; version: number; source: string }>();

    // IR must pass schema validation
    const parsed = IrSchema.safeParse(body.ir);
    expect(parsed.success, `IR schema failed: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);

    if (parsed.success) {
      // At least one service should be detected
      const services = parsed.data.services;
      const serviceNames = Object.keys(services);
      expect(serviceNames.length).toBeGreaterThan(0);

      // The service should be detected as http (Node.js express app)
      const firstService = services[serviceNames[0]!]!;
      expect(firstService.type).toBe("http");

      // Dockerfile should be detected → build.dockerfile present
      const hasBuild = serviceNames.some(
        (k) => services[k]?.build?.dockerfile != null
      );
      expect(hasBuild).toBe(true);
    }

    // Postgres BIGINT는 pg 라이브러리가 안전을 위해 string으로 반환 → Number 변환
    expect(Number(body.version)).toBeGreaterThan(0);
  });

  // ── Test 4: target approve → queued ──────────────────────────────────────

  it("POST /api/v1/deployments/:id/approvals approves target gate → queued", async () => {
    expect(deploymentId).toBeTruthy();

    const res = await server.inject({
      method: "POST",
      url: `/api/v1/deployments/${deploymentId}/approvals`,
      payload: { gate: "target", decision: "approve" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      deploymentId: string;
      gate: string;
      decision: string;
      newStatus: string;
      lockAcquired: boolean;
    }>();

    expect(body.deploymentId).toBe(deploymentId);
    expect(body.gate).toBe("target");
    expect(body.decision).toBe("approve");
    expect(body.newStatus).toBe("queued");
    expect(body.lockAcquired).toBe(true);
  });
});
