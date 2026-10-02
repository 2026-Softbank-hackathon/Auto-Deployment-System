/**
 * apps/api/tests/deployment-mode.test.ts
 * 배포 형태(컨테이너 · 서버리스, #282) — POST /deployments 의 mode 필드, 재배포 body 의 mode,
 * 앱(projects.deploy_mode)에 저장한 형태로 프로필을 고르는지.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import multipartPlugin from "../src/plugins/multipart.js";
import errorHandlerPlugin from "../src/plugins/error-handler.js";
import swaggerPlugin from "../src/plugins/swagger.js";
import deploymentsRoutes from "../src/routes/deployments.js";
import { DeploymentService } from "../src/services/deployment-service.js";
import { MockPool, MockPgBoss, MockStorage } from "./mocks/db.js";

describe("배포 형태 — 라우트", () => {
  let server: FastifyInstance;
  const create = vi.fn(async () => ({
    deploymentId: "42", status: "received", eventsUrl: "/api/v1/deployments/42/events",
  }));
  const redeploy = vi.fn(async () => ({
    deploymentId: "43", status: "queued", eventsUrl: "/api/v1/deployments/43/events",
  }));

  beforeEach(async () => {
    create.mockClear();
    redeploy.mockClear();
    server = Fastify({ logger: false });
    await server.register(errorHandlerPlugin);
    await server.register(multipartPlugin);
    await server.register(swaggerPlugin);
    await server.register(deploymentsRoutes, {
      prefix: "/api/v1/deployments",
      deploymentService: { create, redeploy } as unknown as DeploymentService,
    });
    await server.ready();
  });

  afterEach(async () => server.close());

  async function upload(fields: Record<string, string>) {
    const form = new FormData();
    form.append("source", new Blob([Buffer.from([0x50, 0x4b, 0x03, 0x04])], { type: "application/zip" }), "app.zip");
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    const request = new Request("http://localhost/api/v1/deployments", { method: "POST", body: form });
    return server.inject({
      method: "POST",
      url: "/api/v1/deployments",
      headers: { "content-type": request.headers.get("content-type")! },
      payload: Buffer.from(await request.arrayBuffer()),
    });
  }

  it("mode 를 서비스로 넘긴다", async () => {
    const response = await upload({ project_id: "7", target: "aws", mode: "serverless" });

    expect(response.statusCode, response.body).toBe(202);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ projectId: 7, targetVendor: "aws", mode: "serverless" }));
  });

  it("mode 가 없으면 넘기지 않는다 (앱에 저장된 형태)", async () => {
    const response = await upload({ project_id: "7", target: "aws" });

    expect(response.statusCode, response.body).toBe(202);
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("mode");
  });

  it("알 수 없는 mode 는 거절한다", async () => {
    const response = await upload({ project_id: "7", target: "aws", mode: "lambda" });

    expect(response.statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("재배포 body 의 mode 를 넘긴다", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/deployments/42/redeploy",
      payload: { mode: "container" },
    });

    expect(response.statusCode, response.body).toBe(202);
    expect(redeploy).toHaveBeenCalledWith(42, { targetEnvironmentId: undefined, mode: "container" });
  });

  it("재배포 body 의 잘못된 mode 는 거절한다", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/deployments/42/redeploy",
      payload: { mode: "fargate" },
    });

    expect(response.statusCode).toBe(400);
    expect(redeploy).not.toHaveBeenCalled();
  });
});

type QueryCall = { sql: string; params: unknown[] };

describe("배포 형태 — DeploymentService", () => {
  let pool: MockPool;
  let boss: MockPgBoss;
  let calls: QueryCall[];
  let service: DeploymentService;
  let projectMode: "container" | "serverless";

  beforeEach(() => {
    pool = new MockPool();
    boss = new MockPgBoss();
    calls = [];
    projectMode = "container";
    const query = pool.query.bind(pool);
    pool.query = async (sql: string, params: unknown[] = []) => {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      return query(sql, params);
    };
    service = new DeploymentService(
      pool as unknown as import("@camellia/db").Pool,
      boss as unknown as import("pg-boss").default,
      new MockStorage() as unknown as import("@camellia/storage").Storage,
    );
    pool.on(/SELECT deploy_mode FROM projects WHERE id = \$1/, () => ({ rows: [{ deploy_mode: projectMode }] }));
  });

  function insertedDeploymentParams() {
    return calls.find((call) => /INSERT INTO deployments/.test(call.sql))?.params;
  }

  function projectModeUpdates() {
    return calls.filter((call) => /UPDATE projects SET deploy_mode/.test(call.sql)).map((call) => call.params);
  }

  describe("create", () => {
    beforeEach(() => {
      // 기본 연결: aws 10, onprem 20
      pool.on(/SELECT id FROM environments WHERE \(project_id = \$1 OR project_id IS NULL\) AND type = \$2/, (params) => ({
        rows: [{ id: params[1] === "aws" ? 10 : 20 }],
      }));
      pool.on(/INSERT INTO deployments/, () => ({ rows: [{ id: 99 }] }));
      pool.on(/INSERT INTO source_versions/, () => ({ rows: [{ id: 5 }] }));
    });

    it("AWS + 서버리스면 aws-lambda-basic 으로 만들고 앱의 형태를 바꾼다", async () => {
      await service.create({ projectId: 7, targetVendor: "aws", mode: "serverless", fileBuffer: Buffer.from("zip") });

      expect(insertedDeploymentParams()).toEqual([7, "aws-lambda-basic", 10, 10]);
      expect(projectModeUpdates()).toEqual([["serverless", 7]]);
    });

    it("mode 가 없으면 앱에 저장된 형태를 따른다", async () => {
      projectMode = "serverless";
      await service.create({ projectId: 7, targetVendor: "aws", fileBuffer: Buffer.from("zip") });

      expect(insertedDeploymentParams()).toEqual([7, "aws-lambda-basic", 10, 10]);
      expect(projectModeUpdates()).toEqual([]);
    });

    it("기본은 컨테이너(aws-ecs-basic)", async () => {
      await service.create({ projectId: 7, targetVendor: "aws", fileBuffer: Buffer.from("zip") });

      expect(insertedDeploymentParams()).toEqual([7, "aws-ecs-basic", 10, 10]);
    });

    it("온프레미스는 서버리스를 골라도 컨테이너 — 앱의 형태는 저장한다", async () => {
      await service.create({ projectId: 7, targetVendor: "onprem", mode: "serverless", fileBuffer: Buffer.from("zip") });

      expect(insertedDeploymentParams()).toEqual([7, "onprem-docker-basic", 20, 10]);
      expect(projectModeUpdates()).toEqual([["serverless", 7]]);
    });
  });

  describe("redeploy", () => {
    const sourceIr = {
      $ir_version: "0.1.0",
      metadata: { name: "app", version: "1.0.0" },
      services: { web: { type: "http", port: 3000 } },
      deploy: { profile: "aws-ecs-basic" },
    };

    function setupSource(targetProfile: string, environmentId = "10", irProfile = targetProfile) {
      pool.on(/SELECT id, status, target_profile, target_environment_id/, () => ({
        rows: [{
          id: "42", status: "succeeded", project_id: "1", target_profile: targetProfile,
          target_environment_id: environmentId, registry_environment_id: "10",
        }],
      }));
      pool.on(/FROM ir_versions/, () => ({
        rows: [{ id: 1, ir_json: { ...sourceIr, deploy: { profile: irProfile } }, source: "analyzer" }],
      }));
      pool.on(/FROM source_versions/, () => ({
        rows: [{ id: 1, sha256: "abc", storage_key: "sources/abc.zip", size_bytes: 3 }],
      }));
      pool.on(/INSERT INTO deployments/, () => ({ rows: [{ id: 99 }] }));
    }

    function insertedIrProfile() {
      const call = calls.find((candidate) => /INSERT INTO ir_versions/.test(candidate.sql))!;
      return JSON.parse(call.params[1] as string).deploy.profile;
    }

    it("앱이 서버리스면 같은 환경 재배포(롤백)도 서버리스", async () => {
      projectMode = "serverless";
      setupSource("aws-ecs-basic");

      await service.redeploy(42);

      expect(insertedDeploymentParams()).toEqual([42, "aws-lambda-basic", "10", "10"]);
      expect(insertedIrProfile()).toBe("aws-lambda-basic");
      expect(projectModeUpdates()).toEqual([]);
    });

    it("재배포에서 컨테이너로 바꾸면 aws-ecs-basic 으로 만들고 앱의 형태도 바꾼다", async () => {
      projectMode = "serverless";
      setupSource("aws-lambda-basic");

      await service.redeploy(42, { mode: "container" });

      expect(insertedDeploymentParams()).toEqual([42, "aws-ecs-basic", "10", "10"]);
      expect(insertedIrProfile()).toBe("aws-ecs-basic");
      expect(projectModeUpdates()).toEqual([["container", "1"]]);
    });

    it("앱의 형태와 같으면 원본 프로필 그대로", async () => {
      setupSource("aws-ecs-basic");

      await service.redeploy(42);

      expect(insertedDeploymentParams()).toEqual([42, "aws-ecs-basic", "10", "10"]);
    });

    it("온프레미스 → AWS 전환은 앱의 형태(서버리스)를 따른다", async () => {
      projectMode = "serverless";
      setupSource("onprem-docker-basic", "20");
      pool.on(/SELECT id, type, project_id FROM environments WHERE id = \$1$/, () => ({
        rows: [{ id: "11", type: "aws", project_id: "1" }],
      }));

      await service.redeploy(42, { targetEnvironmentId: 11 });

      expect(insertedDeploymentParams()).toEqual([42, "aws-lambda-basic", "11", "11"]);
      expect(insertedIrProfile()).toBe("aws-lambda-basic");
    });

    it("온프레미스 재배포는 형태와 관계없이 그대로", async () => {
      projectMode = "serverless";
      setupSource("onprem-docker-basic", "20");

      await service.redeploy(42);

      expect(insertedDeploymentParams()).toEqual([42, "onprem-docker-basic", "20", "10"]);
    });
  });
});
