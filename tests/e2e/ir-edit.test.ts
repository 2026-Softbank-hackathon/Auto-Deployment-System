/**
 * tests/e2e/ir-edit.test.ts
 * IR 편집 (API-09) 낙관적 잠금 — 실제 Postgres.
 * ROW_NUMBER() 는 BIGINT 라 pg 드라이버가 문자열("1")로 돌려준다. mock 으로는 드러나지 않아 실제 DB 로 확인.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type PgBoss from "pg-boss";
import { createPool, type Pool } from "@camellia/db";
import { IrVersionSchema } from "@camellia/contracts";
import type { Storage } from "@camellia/storage";
import { buildServer } from "../../apps/api/src/server.js";
import { MockPgBoss, MockStorage } from "../../apps/api/tests/mocks/db.js";

const describeWithPostgres =
  process.env["SKIP_E2E"] === "true" ? describe.skip : describe;

const IR = {
  $ir_version: "0.1.0",
  metadata: { name: "ir-edit-e2e", version: "1.0.0" },
  services: {
    api: {
      type: "http",
      port: 3000,
      expose: "public",
      size: "small",
      health: { path: "/health", expected_status: 200, timeout_seconds: 3 },
    },
  },
  deploy: { profile: "aws-ecs-basic" },
};

describeWithPostgres("IR 편집 낙관적 잠금 — 실제 Postgres", () => {
  let pool: Pool;
  let server: FastifyInstance;
  let projectId: number | undefined;

  beforeAll(async () => {
    pool = createPool(process.env["DATABASE_URL"]!);
    server = await buildServer({
      pool,
      boss: new MockPgBoss() as unknown as PgBoss,
      storage: new MockStorage() as unknown as Storage,
      nodeEnv: "development",
      logger: false,
      enablePgListener: false,
    });
    await server.ready();
  });

  afterAll(async () => {
    if (projectId) await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
    await server?.close();
    await pool?.end();
  });

  it("GET 으로 받은 version 으로 PATCH 하면 다음 version, 오래된 version 은 409", async () => {
    const project = await pool.query<{ id: string }>(
      `INSERT INTO projects(name) VALUES ($1) RETURNING id`,
      [`ir-edit-e2e-${crypto.randomUUID()}`],
    );
    projectId = Number(project.rows[0]!.id);
    const dep = await pool.query<{ id: string }>(
      `INSERT INTO deployments(project_id, status, target_profile)
       VALUES ($1, 'awaiting_target_confirmation', 'aws-ecs-basic') RETURNING id`,
      [projectId],
    );
    const url = `/api/v1/deployments/${dep.rows[0]!.id}/ir`;
    await pool.query(
      `INSERT INTO ir_versions(deployment_id, ir_json, source) VALUES ($1, $2, 'analyzer')`,
      [dep.rows[0]!.id, JSON.stringify(IR)],
    );

    const first = await server.inject({ method: "GET", url });
    expect(first.statusCode).toBe(200);
    expect(first.json().version).toBe(1);
    expect(IrVersionSchema.safeParse(first.json()).success).toBe(true);

    const patched = await server.inject({
      method: "PATCH",
      url,
      payload: { version: first.json().version, ir: { metadata: { name: "renamed" } } },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().version).toBe(2);
    expect(patched.json().ir.metadata.name).toBe("renamed");
    expect(IrVersionSchema.safeParse(patched.json()).success).toBe(true);

    const second = await server.inject({ method: "GET", url });
    expect(second.json().version).toBe(2);
    expect(second.json().source).toBe("user_edited");

    const stale = await server.inject({
      method: "PATCH",
      url,
      payload: { version: 1, ir: { metadata: { name: "stale" } } },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("IR_VERSION_CONFLICT");
  });
});
