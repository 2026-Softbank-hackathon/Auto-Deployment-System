/**
 * apps/api/tests/deployment-redeploy.test.ts
 * POST /deployments/:id/redeploy — 라우트 + DeploymentService.redeploy 단위 테스트.
 *
 * - 정상 흐름: 202 + { deploymentId, status: "queued", eventsUrl }
 * - 소스 없음: 404
 * - 소스 진행 중: 409
 * - IR 없음: 400
 * - env_lock 충돌: 409
 * - targetEnvironmentId override
 * - contracts schema 일치
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import errorHandlerPlugin, { ApiError } from "../src/plugins/error-handler.js";
import swaggerPlugin from "../src/plugins/swagger.js";
import deploymentsRoutes from "../src/routes/deployments.js";
import type { DeploymentService } from "../src/services/deployment-service.js";
import { RedeployResponseSchema } from "@camellia/contracts";

// ── 라우트 단위 테스트 (DeploymentService 모킹) ────────────────────────────────

describe("POST /deployments/:id/redeploy — 라우트", () => {
  let server: FastifyInstance;
  const redeployMock = vi.fn();

  beforeEach(async () => {
    redeployMock.mockReset();
    server = Fastify({ logger: false });
    await server.register(errorHandlerPlugin);
    await server.register(swaggerPlugin);
    await server.register(deploymentsRoutes, {
      prefix: "/api/v1/deployments",
      deploymentService: { redeploy: redeployMock } as unknown as DeploymentService,
    });
    await server.ready();
  });

  afterEach(async () => server.close());

  it("정상 흐름 — 202 + queued 응답", async () => {
    redeployMock.mockResolvedValueOnce({
      deploymentId: "99",
      status: "queued",
      eventsUrl: "/api/v1/deployments/99/events",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/deployments/42/redeploy",
      payload: {},
    });

    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toMatchObject({ deploymentId: "99", status: "queued" });
    expect(redeployMock).toHaveBeenCalledWith(42, { targetEnvironmentId: undefined });

    // contracts schema 일치
    const result = RedeployResponseSchema.safeParse(res.json());
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it("targetEnvironmentId override 전달", async () => {
    redeployMock.mockResolvedValueOnce({
      deploymentId: "100",
      status: "queued",
      eventsUrl: "/api/v1/deployments/100/events",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/deployments/42/redeploy",
      payload: { targetEnvironmentId: "5" },
    });

    expect(res.statusCode, res.body).toBe(202);
    expect(redeployMock).toHaveBeenCalledWith(42, { targetEnvironmentId: 5 });
  });

  it("빈 바디도 허용 (body 없이 호출)", async () => {
    redeployMock.mockResolvedValueOnce({
      deploymentId: "99",
      status: "queued",
      eventsUrl: "/api/v1/deployments/99/events",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/deployments/42/redeploy",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });

    expect(res.statusCode, res.body).toBe(202);
  });

  it("배포 ID 0은 400", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/deployments/0/redeploy",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(redeployMock).not.toHaveBeenCalled();
  });

  it("서비스가 404 던지면 그대로 전달", async () => {
    redeployMock.mockRejectedValueOnce(new ApiError(404, "NOT_FOUND", "배포를 찾을 수 없습니다."));

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/deployments/999/redeploy",
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it("서비스가 409 던지면 그대로 전달", async () => {
    redeployMock.mockRejectedValueOnce(new ApiError(409, "CONFLICT", "소스 배포가 아직 진행 중입니다."));

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/deployments/42/redeploy",
      payload: {},
    });
    expect(res.statusCode).toBe(409);
  });
});

// ── DeploymentService.redeploy 단위 테스트 (MockPool 사용) ──────────────────────

import { DeploymentService } from "../src/services/deployment-service.js";
import { MockPool, MockPgBoss, MockStorage } from "./mocks/db.js";

function makeService(pool: MockPool, boss: MockPgBoss) {
  return new DeploymentService(
    pool as unknown as import("@camellia/db").Pool,
    boss as unknown as import("pg-boss").default,
    new MockStorage() as unknown as import("@camellia/storage").Storage,
  );
}

type QueryCall = { sql: string; params: unknown[] };

describe("DeploymentService.redeploy", () => {
  let pool: MockPool;
  let calls: QueryCall[];
  let boss: MockPgBoss;
  let svc: DeploymentService;

  beforeEach(() => {
    pool = new MockPool();
    calls = [];
    const query = pool.query.bind(pool);
    pool.query = async (sql: string, params: unknown[] = []) => {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      return query(sql, params);
    };
    boss = new MockPgBoss();
    svc = makeService(pool, boss);
  });

  function setupSucceededDeployment() {
    pool.on(/SELECT id, status, target_profile, target_environment_id/, () => ({
      rows: [{
        id: 42,
        status: "succeeded",
        target_profile: "aws-ecs-basic",
        target_environment_id: 10,
        registry_environment_id: 10,
        project_id: 1,
      }],
    }));
  }

  function setupSource(row: {
    target_profile: string;
    target_environment_id: string | null;
    registry_environment_id: string | null;
  }) {
    pool.on(/SELECT id, status, target_profile, target_environment_id/, () => ({
      rows: [{ id: "42", status: "succeeded", project_id: "1", ...row }],
    }));
  }

  type Env = { id: number; type: "aws" | "onprem"; project_id: number | null; is_default?: boolean };

  function setupEnvironments(envs: Env[]) {
    // 대상 환경 단건 조회
    pool.on(/SELECT id, type, project_id FROM environments WHERE id = \$1$/, (params) => ({
      rows: envs
        .filter((env) => String(env.id) === String(params[0]))
        .map(({ id, type, project_id }) => ({
          id: String(id),
          type,
          project_id: project_id == null ? null : String(project_id),
        })),
    }));
    // 온프레미스 대상의 Registry(AWS) 환경 — 원본 Registry > 프로젝트 기본 > 공용 기본
    pool.on(/FROM environments WHERE type = 'aws'/, (params) => {
      const [projectId, keepId] = params as [unknown, unknown];
      const keep = (env: Env) => (keepId != null && String(env.id) === String(keepId) ? 0 : 1);
      const shared = (env: Env) => (env.project_id === null ? 1 : 0);
      const candidates = envs
        .filter((env) => env.type === "aws")
        .filter((env) => env.project_id === null || String(env.project_id) === String(projectId))
        .filter((env) => keep(env) === 0 || env.is_default)
        .sort((a, b) => keep(a) - keep(b) || shared(a) - shared(b) || a.id - b.id);
      return { rows: candidates.slice(0, 1).map((env) => ({ id: String(env.id) })) };
    });
  }

  function insertedDeploymentParams() {
    return calls.find((c) => /INSERT INTO deployments/.test(c.sql))?.params;
  }

  function setupIr() {
    pool.on(/FROM ir_versions/, () => ({
      rows: [{
        id: 1,
        ir_json: { "$ir_version": "0.1.0", metadata: { name: "app" } },
        source: "analyzer",
      }],
    }));
  }

  function setupSourceVersion() {
    pool.on(/FROM source_versions/, () => ({
      rows: [{
        id: 1,
        sha256: "abc123",
        storage_key: "sources/abc123.zip",
        size_bytes: 1024,
      }],
    }));
  }

  function setupNoLock() {
    pool.on(/SELECT d\.id\s*FROM deployments d/, () => ({ rows: [] }));
  }

  function setupTransaction() {
    pool.on(/INSERT INTO deployments/, () => ({ rows: [{ id: 99 }] }));
    pool.on(/INSERT INTO source_versions/, () => ({ rows: [] }));
    pool.on(/INSERT INTO ir_versions/, () => ({ rows: [] }));
  }

  it("정상 흐름 — queued 응답 반환", async () => {
    setupSucceededDeployment();
    setupIr();
    setupSourceVersion();
    setupNoLock();
    setupTransaction();

    const result = await svc.redeploy(42);

    expect(result.status).toBe("queued");
    expect(result.deploymentId).toMatch(/^\d+$/);
    expect(result.eventsUrl).toContain(result.deploymentId);

    const parsed = RedeployResponseSchema.safeParse(result);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
  });

  it("존재하지 않는 배포 — 404", async () => {
    pool.on(/SELECT id, status, target_profile, target_environment_id/, () => ({ rows: [] }));

    await expect(svc.redeploy(999)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("진행 중인 배포 — 409", async () => {
    pool.on(/SELECT id, status, target_profile, target_environment_id/, () => ({
      rows: [{
        id: 42,
        status: "building",
        target_profile: "aws-ecs-basic",
        target_environment_id: 10,
        registry_environment_id: 10,
      }],
    }));

    await expect(svc.redeploy(42)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("'received' 상태도 진행 중으로 간주 — 409", async () => {
    pool.on(/SELECT id, status, target_profile, target_environment_id/, () => ({
      rows: [{
        id: 42,
        status: "received",
        target_profile: "aws-ecs-basic",
        target_environment_id: 10,
        registry_environment_id: 10,
      }],
    }));

    await expect(svc.redeploy(42)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("'failed' 상태는 재배포 가능 — 정상 흐름", async () => {
    pool.on(/SELECT id, status, target_profile, target_environment_id/, () => ({
      rows: [{
        id: 42,
        status: "failed",
        target_profile: "aws-ecs-basic",
        target_environment_id: 10,
        registry_environment_id: 10,
      }],
    }));
    setupIr();
    setupSourceVersion();
    setupNoLock();
    setupTransaction();

    const result = await svc.redeploy(42);
    expect(result.status).toBe("queued");
  });

  it("IR 없음 — 400", async () => {
    setupSucceededDeployment();
    pool.on(/FROM ir_versions/, () => ({ rows: [] }));

    await expect(svc.redeploy(42)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("env_lock 충돌 — 409", async () => {
    setupSucceededDeployment();
    setupIr();
    setupSourceVersion();
    // 잠긴 배포 있음
    pool.on(/SELECT d\.id\s*FROM deployments d/, () => ({ rows: [{ id: 55 }] }));

    await expect(svc.redeploy(42)).rejects.toMatchObject({ statusCode: 409, code: "DEPLOYMENT_LOCKED" });
  });

  it("같은 환경 재배포 — 원본 프로필 · Registry 그대로, build job 에 원본 ID 전달", async () => {
    setupSucceededDeployment();
    setupIr();
    setupSourceVersion();
    setupNoLock();
    setupTransaction();

    await svc.redeploy(42);

    expect(insertedDeploymentParams()).toEqual([42, "aws-ecs-basic", 10, 10]);
    expect(boss.sentJobs).toEqual([
      { name: "build", data: { deployment_id: 99, redeployed_from: 42 } },
    ]);
  });

  it("AWS → 온프레미스 전환 — 프로필 onprem-docker-basic 재선정, Registry 는 원본 AWS 환경 유지", async () => {
    setupSucceededDeployment();
    setupIr();
    setupSourceVersion();
    setupNoLock();
    setupTransaction();
    setupEnvironments([
      { id: 10, type: "aws", project_id: 1, is_default: true },
      { id: 20, type: "onprem", project_id: 1, is_default: true },
    ]);

    const result = await svc.redeploy(42, { targetEnvironmentId: 20 });

    expect(result.status).toBe("queued");
    expect(insertedDeploymentParams()).toEqual([42, "onprem-docker-basic", "20", "10"]);
  });

  it("온프레미스 → AWS 전환 — 프로필 aws-ecs-basic 재선정, Registry 는 대상 AWS 환경", async () => {
    setupSource({
      target_profile: "onprem-docker-basic",
      target_environment_id: "20",
      registry_environment_id: "10",
    });
    setupIr();
    setupSourceVersion();
    setupNoLock();
    setupTransaction();
    setupEnvironments([
      { id: 10, type: "aws", project_id: 1, is_default: true },
      { id: 11, type: "aws", project_id: 1 },
      { id: 20, type: "onprem", project_id: 1, is_default: true },
    ]);

    await svc.redeploy(42, { targetEnvironmentId: 11 });

    expect(insertedDeploymentParams()).toEqual([42, "aws-ecs-basic", "11", "11"]);
  });

  it("온프레미스 전환 시 원본 Registry 가 없으면 프로젝트 기본 AWS 환경 사용", async () => {
    setupSource({
      target_profile: "onprem-docker-basic",
      target_environment_id: "20",
      registry_environment_id: null,
    });
    setupIr();
    setupSourceVersion();
    setupNoLock();
    setupTransaction();
    setupEnvironments([
      { id: 5, type: "aws", project_id: null, is_default: true },
      { id: 11, type: "aws", project_id: 1, is_default: true },
      { id: 21, type: "onprem", project_id: 1 },
    ]);

    await svc.redeploy(42, { targetEnvironmentId: 21 });

    expect(insertedDeploymentParams()).toEqual([42, "onprem-docker-basic", "21", "11"]);
  });

  it("프로젝트 AWS 환경이 없으면 공용 기본 AWS 환경(project_id NULL)을 Registry 로 사용", async () => {
    setupSource({
      target_profile: "onprem-docker-basic",
      target_environment_id: "20",
      registry_environment_id: null,
    });
    setupIr();
    setupSourceVersion();
    setupNoLock();
    setupTransaction();
    setupEnvironments([
      { id: 5, type: "aws", project_id: null, is_default: true },
      { id: 30, type: "onprem", project_id: null },
    ]);

    await svc.redeploy(42, { targetEnvironmentId: 30 });

    expect(insertedDeploymentParams()).toEqual([42, "onprem-docker-basic", "30", "5"]);
  });

  it("온프레미스 전환인데 쓸 수 있는 AWS 환경이 없으면 409 AWS_REGISTRY_ENVIRONMENT_REQUIRED", async () => {
    setupSource({
      target_profile: "onprem-docker-basic",
      target_environment_id: "20",
      registry_environment_id: null,
    });
    setupIr();
    setupSourceVersion();
    setupEnvironments([{ id: 21, type: "onprem", project_id: 1 }]);

    await expect(svc.redeploy(42, { targetEnvironmentId: 21 })).rejects.toMatchObject({
      statusCode: 409,
      code: "AWS_REGISTRY_ENVIRONMENT_REQUIRED",
    });
  });

  it("없는 대상 환경 — 404", async () => {
    setupSucceededDeployment();
    setupIr();
    setupSourceVersion();
    setupEnvironments([]);

    await expect(svc.redeploy(42, { targetEnvironmentId: 77 })).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    });
  });

  it("다른 프로젝트의 대상 환경 — 400", async () => {
    setupSucceededDeployment();
    setupIr();
    setupSourceVersion();
    setupEnvironments([{ id: 20, type: "onprem", project_id: 2 }]);

    await expect(svc.redeploy(42, { targetEnvironmentId: 20 })).rejects.toMatchObject({
      statusCode: 400,
      code: "VALIDATION_ERROR",
    });
  });

  it("잠금 확인은 같은 프로젝트의 진행 중 배포만 본다", async () => {
    setupSucceededDeployment();
    setupIr();
    setupSourceVersion();
    setupNoLock();
    setupTransaction();

    await svc.redeploy(42);

    const lockQuery = calls.find((c) => /SELECT d\.id FROM deployments d/.test(c.sql));
    expect(lockQuery?.sql).toContain("d.project_id = $4");
    expect(lockQuery?.params[3]).toBe(1);
  });
});
