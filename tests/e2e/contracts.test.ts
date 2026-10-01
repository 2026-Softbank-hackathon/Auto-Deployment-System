/**
 * tests/e2e/contracts.test.ts
 * 실제 Postgres 로 API 를 호출해 응답이 @camellia/contracts 스키마를 통과하는지 확인.
 * mock DB 로는 드러나지 않는 pg 드라이버 타입 변환(BIGINT → 문자열 등)까지 계약에 반영됐는지 본다.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type PgBoss from "pg-boss";
import type { ZodTypeAny } from "zod";
import { createPool, type Pool } from "@camellia/db";
import type { Storage } from "@camellia/storage";
import {
  CreateEnvironmentResponseSchema,
  DeploymentSchema,
  EnvironmentListSchema,
  EnvironmentSchema,
  EnvVarListSchema,
  IrVersionSchema,
  ProjectDeploymentListSchema,
  ProjectListSchema,
  ProjectSchema,
  SecretListSchema,
  SecretSchema,
} from "@camellia/contracts";
import { buildServer } from "../../apps/api/src/server.js";
import { MockPgBoss, MockStorage } from "../../apps/api/tests/mocks/db.js";

const describeWithPostgres =
  process.env["SKIP_E2E"] === "true" ? describe.skip : describe;

function expectContract(schema: ZodTypeAny, body: unknown) {
  const result = schema.safeParse(body);
  const issues = result.success
    ? ""
    : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  expect(issues, "계약 불일치").toBe("");
}

describeWithPostgres("API 응답 계약 — 실제 Postgres", () => {
  let pool: Pool;
  let server: FastifyInstance;
  let projectId: number;

  async function call(method: string, url: string, payload?: object) {
    const res = await server.inject({ method: method as "GET", url, payload });
    expect(res.statusCode, `${method} ${url}: ${res.body}`).toBeLessThan(300);
    return res.json();
  }

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

  it("projects · env · secrets · environments · deployments · IR", async () => {
    const project = await call("POST", "/api/v1/projects", { name: `contracts-e2e-${crypto.randomUUID()}` });
    expectContract(ProjectSchema, project);
    projectId = Number(project.id);

    expectContract(ProjectSchema, await call("GET", `/api/v1/projects/${projectId}`));
    expectContract(ProjectListSchema, await call("GET", "/api/v1/projects?limit=100"));

    expectContract(EnvVarListSchema, await call("PATCH", `/api/v1/projects/${projectId}/env`, { vars: { NODE_ENV: "production" } }));
    expectContract(EnvVarListSchema, await call("GET", `/api/v1/projects/${projectId}/env`));

    expectContract(SecretSchema, await call("POST", "/api/v1/secrets", { projectId, name: "aws-key", value: "v" }));
    expectContract(SecretListSchema, await call("GET", `/api/v1/secrets?projectId=${projectId}`));

    const env = await call("POST", "/api/v1/environments", {
      projectId,
      name: "onprem-mac",
      type: "onprem",
      onpremConfig: { agentRegistrationToken: "tok", hostname: "mac.local" },
    });
    // POST 응답만 등록 토큰을 1회 포함한다(#61) — 조회 응답은 아래 EnvironmentSchema 로 토큰 없음까지 확인
    expectContract(CreateEnvironmentResponseSchema, env);
    expectContract(EnvironmentListSchema, await call("GET", `/api/v1/environments?projectId=${projectId}`));
    expectContract(EnvironmentSchema, await call("GET", `/api/v1/environments/${env.id}`));

    const dep = await pool.query<{ id: string }>(
      `INSERT INTO deployments(project_id, status, target_profile)
       VALUES ($1, 'awaiting_target_confirmation', 'aws-ecs-basic') RETURNING id`,
      [projectId],
    );
    const deploymentId = dep.rows[0]!.id;
    await pool.query(
      `INSERT INTO source_versions(deployment_id, sha256, storage_key, size_bytes) VALUES ($1, 'sha', 'sources/sha.zip', 1)`,
      [deploymentId],
    );
    await pool.query(
      `INSERT INTO deployment_steps(deployment_id, step_name, status) VALUES ($1, 'analyze', 'running')`,
      [deploymentId],
    );
    await pool.query(
      `INSERT INTO ir_versions(deployment_id, ir_json, source) VALUES ($1, $2, 'analyzer')`,
      [deploymentId, JSON.stringify({ $ir_version: "0.1.0", metadata: { name: "x", version: "1.0.0" } })],
    );

    expectContract(DeploymentSchema, await call("GET", `/api/v1/deployments/${deploymentId}`));
    expectContract(ProjectDeploymentListSchema, await call("GET", `/api/v1/projects/${projectId}/deployments`));
    expectContract(IrVersionSchema, await call("GET", `/api/v1/deployments/${deploymentId}/ir`));
  });
});
