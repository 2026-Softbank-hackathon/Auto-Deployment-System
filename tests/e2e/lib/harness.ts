/**
 * tests/e2e/lib/harness.ts
 *
 * E2E 테스트 공통 하네스.
 * createHarness()로 server/boss/pool/storage 세팅과 업로드 + 분석 대기를
 * 한 번에 처리한다.
 */

import FormData from "form-data";
import PgBoss from "pg-boss";
import { createPool } from "@camellia/db";
import { LocalStorage } from "@camellia/storage";
import { buildServer } from "../../../apps/api/src/server.js";
import { registerAll } from "../../../apps/worker/src/register.js";
import { createPgNotifier } from "../../../apps/worker/src/notifier.js";
import type { FastifyInstance } from "fastify";
import type { Pool } from "@camellia/db";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

// setup.ts globalSetup이 이미 process.env.DATABASE_URL을 e2e DB로 교체한다.
export const E2E_DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgres://camellia:camellia@localhost:5433/camellia";

export interface HarnessOptions {
  /** fixture zip 바이트 */
  fixtureZip: Buffer;
  /** 배포 대상 프로필 (예: "aws-ecs-basic") */
  target: string;
  /** 업로드할 프로젝트 이름 접두사 */
  projectName: string;
  /** storageTmp 디렉터리 접두사 (기본값: "camellia-e2e-") */
  tmpPrefix?: string;
}

export interface Harness {
  server: FastifyInstance;
  pool: Pool;
  boss: PgBoss;
  storageTmp: string;
  /** 프로젝트 생성 + zip 업로드. 반환값은 deploymentId. */
  upload(): Promise<string>;
  /** awaiting_target_confirmation 또는 failed 도달까지 최대 timeoutMs 대기. */
  waitForAnalysis(deploymentId: string, timeoutMs?: number): Promise<string>;
  /** GET /api/v1/deployments/:id/ir 응답 body. */
  fetchIr(deploymentId: string): Promise<{ ir: unknown; version: string; source: string }>;
  /** server, boss, pool, storageTmp 정리. */
  close(): Promise<void>;
}

/**
 * beforeAll 안에서 호출. Harness 인스턴스를 반환한다.
 * 실제 start()는 harness 내부에서 호출하지 않으므로
 * beforeAll 콜백에서 직접 startHarness()를 호출해야 한다.
 */
export async function startHarness(opts: HarnessOptions): Promise<Harness> {
  const prefix = opts.tmpPrefix ?? "camellia-e2e-";
  const storageTmp = await fs.mkdtemp(path.join(os.tmpdir(), prefix));

  const pool = createPool(E2E_DATABASE_URL);
  const boss = new PgBoss({ connectionString: E2E_DATABASE_URL });
  const storage = new LocalStorage({ rootDir: storageTmp });
  const notifier = createPgNotifier(pool);

  const server = await buildServer({
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

  async function upload(): Promise<string> {
    const projectRes = await server.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: {
        name: `${opts.projectName}-${Date.now()}`,
        description: "e2e sample test project",
      },
    });
    if (projectRes.statusCode !== 201) {
      throw new Error(`project creation failed: ${projectRes.statusCode} ${projectRes.body}`);
    }
    const project = projectRes.json<{ id: string }>();

    const form = new FormData();
    form.append("project_id", project.id);
    form.append("target", opts.target);
    form.append("source", opts.fixtureZip, {
      filename: `${opts.projectName}.zip`,
      contentType: "application/zip",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/deployments",
      headers: form.getHeaders(),
      payload: form.getBuffer(),
    });

    if (res.statusCode !== 202) {
      throw new Error(`upload failed: ${res.statusCode} ${res.body}`);
    }

    const body = res.json<{ deploymentId: string }>();
    return body.deploymentId;
  }

  async function waitForAnalysis(deploymentId: string, timeoutMs = 30_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
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

    return status;
  }

  async function fetchIr(
    deploymentId: string
  ): Promise<{ ir: unknown; version: string; source: string }> {
    const res = await server.inject({
      method: "GET",
      url: `/api/v1/deployments/${deploymentId}/ir`,
    });

    if (res.statusCode !== 200) {
      throw new Error(`fetchIr failed: ${res.statusCode} ${res.body}`);
    }

    return res.json<{ ir: unknown; version: string; source: string }>();
  }

  async function close(): Promise<void> {
    await server?.close();
    await boss?.stop({ graceful: false });
    await pool?.end();
    await fs.rm(storageTmp, { recursive: true, force: true });
  }

  return { server, pool, boss, storageTmp, upload, waitForAnalysis, fetchIr, close };
}
