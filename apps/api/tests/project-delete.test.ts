/**
 * apps/api/tests/project-delete.test.ts
 * DELETE /api/v1/projects/:id — 앱 삭제 요청 (#247).
 * 프로젝트를 deleting 으로 바꾸고 teardown 잡을 큐에 넣는다. 실제 정리는 워커가 한다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "@camellia/db";
import type PgBoss from "pg-boss";
import type { Storage } from "@camellia/storage";
import {
  DeleteProjectResponseSchema,
  ProjectListSchema,
} from "@camellia/contracts";
import { buildServer } from "../src/server.js";
import { DeploymentService } from "../src/services/deployment-service.js";
import { MockPgBoss, MockPool, MockStorage } from "./mocks/db.js";

let server: FastifyInstance;
let pool: MockPool;
let boss: MockPgBoss;
const queries: Array<{ sql: string; params: unknown[] }> = [];

const REQUESTED_AT = new Date("2026-10-02T03:00:00.000Z");

beforeEach(async () => {
  pool = new MockPool();
  boss = new MockPgBoss();
  queries.length = 0;
  const query = pool.query.bind(pool);
  pool.query = async (sql: string, params: unknown[] = []) => {
    queries.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
    return query(sql, params);
  };
  server = await buildServer({
    pool: pool as unknown as Pool,
    boss: boss as unknown as PgBoss,
    storage: new MockStorage() as unknown as Storage,
    nodeEnv: "development",
    logger: false,
    enablePgListener: false,
  });
  await server.ready();
});

afterEach(async () => {
  await server.close();
  pool.reset();
});

/** 삭제 요청 트랜잭션이 읽는 row 들 */
function givenProject(options: {
  exists?: boolean;
  inProgress?: boolean;
  onprem?: boolean;
} = {}) {
  pool.on(/FROM projects WHERE id = \$1 FOR UPDATE/, () => ({
    rows: options.exists === false ? [] : [{ id: 24 }],
  }));
  pool.on(/FROM deployments WHERE project_id = \$1 AND NOT \(status = ANY/, () => ({
    rows: options.inProgress ? [{ id: 7, status: "building" }] : [],
  }));
  pool.on(/onprem_agent_jobs/, () => ({ rows: [{ onprem: options.onprem === true }] }));
  pool.on(/^UPDATE projects SET deletion_status = 'deleting'/, (params) => ({
    rows: [{
      deletion_status: "deleting",
      deletion_error: null,
      deletion_requested_at: REQUESTED_AT,
      deletion_warnings: params[1],
    }],
  }));
}

describe("DELETE /api/v1/projects/:id", () => {
  it("202 — 프로젝트를 deleting 으로 바꾸고 teardown 잡을 큐에 넣는다", async () => {
    givenProject();
    const send = vi.spyOn(boss, "send");

    const res = await server.inject({ method: "DELETE", url: "/api/v1/projects/24" });

    expect(res.statusCode, res.body).toBe(202);
    // 같은 프로젝트의 teardown 이 겹치지 않도록 singletonKey, destroy 가 길어도 만료되지 않도록 1시간
    expect(send).toHaveBeenCalledWith("teardown", { project_id: 24 }, {
      singletonKey: "project-24",
      expireInSeconds: 3600,
      retryLimit: 0,
    });
    const body = DeleteProjectResponseSchema.parse(res.json());
    expect(body).toEqual({
      projectId: "24",
      deletion: {
        status: "deleting",
        requestedAt: REQUESTED_AT.toISOString(),
        error: null,
        warnings: [],
      },
    });
    expect(boss.sentJobs).toEqual([{ name: "teardown", data: { project_id: 24 } }]);
    expect(queries.some((q) => q.sql === "COMMIT")).toBe(true);
  });

  it("온프레미스에서 돈 적이 있으면 직접 정리해야 한다는 경고를 남긴다", async () => {
    givenProject({ onprem: true });

    const res = await server.inject({ method: "DELETE", url: "/api/v1/projects/24" });

    expect(res.statusCode, res.body).toBe(202);
    expect(res.json().deletion.warnings).toEqual(["ONPREM_MANUAL_CLEANUP"]);
  });

  it("진행 중인 배포가 있으면 409 PROJECT_DEPLOYMENT_IN_PROGRESS — 잡을 넣지 않는다", async () => {
    givenProject({ inProgress: true });

    const res = await server.inject({ method: "DELETE", url: "/api/v1/projects/24" });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("PROJECT_DEPLOYMENT_IN_PROGRESS");
    expect(boss.sentJobs).toEqual([]);
    expect(queries.some((q) => q.sql === "ROLLBACK")).toBe(true);
    expect(queries.some((q) => q.sql.startsWith("UPDATE projects"))).toBe(false);
  });

  it("없는 프로젝트면 404", async () => {
    givenProject({ exists: false });

    const res = await server.inject({ method: "DELETE", url: "/api/v1/projects/99" });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    expect(boss.sentJobs).toEqual([]);
  });

  it("실패했거나 이미 삭제 중인 프로젝트도 다시 요청할 수 있다 (재시도)", async () => {
    givenProject();

    const first = await server.inject({ method: "DELETE", url: "/api/v1/projects/24" });
    const second = await server.inject({ method: "DELETE", url: "/api/v1/projects/24" });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(boss.sentJobs).toHaveLength(2);
    // 실패 이유는 지우고, 진행 중 재요청이면 요청 시각을 유지한다
    const update = queries.find((q) => q.sql.startsWith("UPDATE projects"))!;
    expect(update.sql).toContain("deletion_error = NULL");
    expect(update.sql).toMatch(/deletion_requested_at = CASE WHEN deletion_status = 'deleting'/);
  });

  it("ID 가 양수 정수가 아니면 400", async () => {
    const res = await server.inject({ method: "DELETE", url: "/api/v1/projects/abc" });

    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/v1/projects — deletion", () => {
  function summaryRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 24,
      name: "monolith-seohyeon",
      description: null,
      created_at: new Date("2026-10-01T00:00:00.000Z"),
      updated_at: new Date("2026-10-01T00:00:00.000Z"),
      live_deployment_id: null,
      live_environment_id: null,
      live_environment_type: null,
      live_environment_name: null,
      live_succeeded_at: null,
      latest_deployment_id: null,
      latest_status: null,
      latest_environment_type: null,
      latest_created_at: null,
      deletion_status: null,
      deletion_error: null,
      deletion_requested_at: null,
      deletion_warnings: [],
      ...overrides,
    };
  }

  it("삭제 요청이 없으면 null, 실패하면 이유와 경고를 보여준다", async () => {
    pool.on(/FROM projects p/, () => ({
      rows: [
        summaryRow(),
        summaryRow({
          id: 25,
          name: "failed-app",
          deletion_status: "failed",
          deletion_error: "TERRAFORM_DESTROY_FAILED",
          deletion_requested_at: REQUESTED_AT,
          deletion_warnings: ["ONPREM_MANUAL_CLEANUP"],
        }),
      ],
    }));

    const res = await server.inject({ method: "GET", url: "/api/v1/projects" });

    expect(res.statusCode, res.body).toBe(200);
    const body = ProjectListSchema.parse(res.json());
    expect(body.items[0]!.deletion).toBeNull();
    expect(body.items[1]!.deletion).toEqual({
      status: "failed",
      requestedAt: REQUESTED_AT.toISOString(),
      error: "TERRAFORM_DESTROY_FAILED",
      warnings: ["ONPREM_MANUAL_CLEANUP"],
    });
  });
});

describe("삭제 중인 프로젝트에는 새 배포를 만들지 않는다", () => {
  function service() {
    pool.on(/SELECT deletion_status FROM projects WHERE id = \$1/, () => ({
      rows: [{ deletion_status: "deleting" }],
    }));
    return new DeploymentService(
      pool as unknown as Pool,
      boss as unknown as PgBoss,
      new MockStorage() as unknown as Storage,
    );
  }

  it("POST /deployments — 409 PROJECT_DELETING", async () => {
    await expect(
      service().create({ projectId: 24, targetVendor: "aws", fileBuffer: Buffer.from("zip") }),
    ).rejects.toMatchObject({ statusCode: 409, code: "PROJECT_DELETING" });
    expect(boss.sentJobs).toEqual([]);
  });

  it("POST /deployments/:id/redeploy — 409 PROJECT_DELETING", async () => {
    pool.on(/FROM deployments WHERE id = \$1/, () => ({
      rows: [{
        id: 42,
        status: "succeeded",
        target_profile: "aws-ecs-basic",
        target_environment_id: "5",
        registry_environment_id: "5",
        project_id: "24",
      }],
    }));

    await expect(service().redeploy(42)).rejects.toMatchObject({
      statusCode: 409,
      code: "PROJECT_DELETING",
    });
    expect(boss.sentJobs).toEqual([]);
  });
});
