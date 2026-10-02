/**
 * apps/api/tests/project-address-change.test.ts
 * 앱 주소 변경 (#301) — PATCH /projects/:id/subdomain, 진행 중 배포 · 앱 삭제 막기, 응답 addressChange.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "@camellia/db";
import type PgBoss from "pg-boss";
import type { Storage } from "@camellia/storage";
import { ErrorBodySchema, ProjectSchema } from "@camellia/contracts";
import { buildServer } from "../src/server.js";
import { DeploymentService } from "../src/services/deployment-service.js";
import { MockPgBoss, MockPool, MockStorage } from "./mocks/db.js";

const NOW = new Date("2026-10-02T03:00:00.000Z");
let server: FastifyInstance;
let pool: MockPool;
let boss: MockPgBoss;
let queries: Array<{ sql: string; params: unknown[] }>;

beforeEach(async () => {
  pool = new MockPool();
  boss = new MockPgBoss();
  queries = [];
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
    platformDomain: "camellia-deploy.app",
  });
  await server.ready();
});

afterEach(async () => {
  await server.close();
});

type ProjectState = {
  exists?: boolean;
  subdomain?: string;
  deleting?: boolean;
  changing?: boolean;
  activeDeployment?: boolean;
  live?: { id: number; target_profile: string } | null;
  taken?: boolean;
};

/** PATCH 트랜잭션과 이어지는 GET 이 읽는 row */
function given(state: ProjectState = {}) {
  let current = {
    subdomain: state.subdomain ?? "service-3",
    address_change_status: state.changing ? "changing" : null as string | null,
    address_change_from: state.changing ? "service-3" : null as string | null,
    address_change_to: state.changing ? "other" : null as string | null,
    address_change_error: null as string | null,
    address_change_requested_at: state.changing ? NOW : null as Date | null,
    address_change_finished_at: null as Date | null,
  };
  pool.on(/FROM projects WHERE id = \$1 FOR UPDATE/, () => ({
    rows: state.exists === false ? [] : [{
      id: 3,
      subdomain: current.subdomain,
      deletion_status: state.deleting ? "deleting" : null,
      address_change_active: state.changing === true,
    }],
  }));
  pool.on(/FROM deployments WHERE project_id = \$1 AND NOT \(status = ANY/, () => ({
    rows: state.activeDeployment ? [{ id: 7, status: "building" }] : [],
  }));
  pool.on(/SELECT d\.id, d\.target_profile FROM deployments d/, () => ({
    rows: state.live === undefined
      ? [{ id: 9, target_profile: "aws-ecs-basic" }]
      : state.live === null ? [] : [state.live],
  }));
  pool.on(/FROM projects WHERE \(lower\(subdomain\)/, () => ({ rows: state.taken ? [{ id: 1 }] : [] }));
  pool.on(/^UPDATE projects SET address_change_status = 'changing'/, (params) => {
    current = {
      ...current,
      address_change_status: "changing",
      address_change_from: params[2] as string,
      address_change_to: params[1] as string,
      address_change_requested_at: NOW,
    };
    return { rows: [] };
  });
  pool.on(/^UPDATE projects SET subdomain = \$2/, (params) => {
    current = {
      ...current,
      subdomain: params[1] as string,
      address_change_status: "succeeded",
      address_change_from: params[2] as string,
      address_change_to: params[1] as string,
      address_change_requested_at: NOW,
      address_change_finished_at: NOW,
    };
    return { rows: [] };
  });
  pool.on(/FROM projects p/, () => ({
    rows: [{
      id: 3, name: "app-3", description: null, created_at: NOW, updated_at: NOW, deploy_mode: "container",
      ...current,
      live_deployment_id: null, live_environment_id: null, live_environment_type: null,
      live_environment_name: null, live_target_profile: null, live_succeeded_at: null,
      latest_deployment_id: null, latest_status: null, latest_environment_type: null, latest_created_at: null,
      deletion_status: null, deletion_error: null, deletion_requested_at: null, deletion_warnings: [],
    }],
  }));
}

function patch(subdomain: string, id = 3) {
  return server.inject({ method: "PATCH", url: `/api/v1/projects/${id}/subdomain`, payload: { subdomain } });
}

describe("PATCH /projects/:id/subdomain (#301)", () => {
  it("서비스 중인 배포가 있으면 주소 변경 작업을 넣고 202 + addressChange=changing", async () => {
    given();

    const res = await patch(" Shop ");

    expect(res.statusCode, res.body).toBe(202);
    expect(ProjectSchema.safeParse(res.json()).success).toBe(true);
    expect(res.json()).toMatchObject({
      subdomain: "service-3",
      addressChange: { status: "changing", from: "service-3", to: "shop", finishedAt: null, error: null },
    });
    expect(boss.sentJobs).toEqual([{ name: "address-change", data: { project_id: 3 } }]);
    expect(queries.some((q) => /pg_advisory_xact_lock/.test(q.sql))).toBe(true);
  });

  it("서비스 중인 배포가 없으면 바로 바꾸고 200 (작업 없음)", async () => {
    given({ live: null });

    const res = await patch("shop");

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      subdomain: "shop",
      publicUrl: "https://shop.camellia-deploy.app",
      addressChange: { status: "succeeded", from: "service-3", to: "shop" },
    });
    expect(boss.sentJobs).toEqual([]);
  });

  it("정적 사이트(S3)로 서비스 중이면 409 ADDRESS_CHANGE_STATIC_UNSUPPORTED", async () => {
    given({ live: { id: 9, target_profile: "aws-static-basic" } });

    const res = await patch("shop");

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ADDRESS_CHANGE_STATIC_UNSUPPORTED");
    expect(res.json().error.message).toContain("정적 사이트는 주소 변경 미지원");
    expect(ErrorBodySchema.safeParse(res.json()).success).toBe(true);
    expect(boss.sentJobs).toEqual([]);
  });

  it("진행 중인 배포가 있으면 409 PROJECT_DEPLOYMENT_IN_PROGRESS", async () => {
    given({ activeDeployment: true });

    const res = await patch("shop");

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("PROJECT_DEPLOYMENT_IN_PROGRESS");
  });

  it("이미 주소를 바꾸는 중이면 409 ADDRESS_CHANGE_IN_PROGRESS", async () => {
    given({ changing: true });

    const res = await patch("shop");

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ADDRESS_CHANGE_IN_PROGRESS");
  });

  it("다른 앱이 쓰거나 바꾸려는 주소면 409 SUBDOMAIN_TAKEN", async () => {
    given({ taken: true });

    const res = await patch("shop");

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("SUBDOMAIN_TAKEN");
    const taken = queries.find((q) => /lower\(subdomain\)/.test(q.sql));
    expect(taken?.sql).toMatch(/address_change_to/);
  });

  it("삭제 중인 앱은 409 PROJECT_DELETING, 없는 앱은 404", async () => {
    given({ deleting: true });
    expect((await patch("shop")).json().error.code).toBe("PROJECT_DELETING");

    pool.reset();
    given({ exists: false });
    expect((await patch("shop")).statusCode).toBe(404);
  });

  it("지금 주소와 같으면 아무것도 하지 않고 200", async () => {
    given({ subdomain: "shop" });

    const res = await patch("shop");

    expect(res.statusCode).toBe(200);
    expect(boss.sentJobs).toEqual([]);
    expect(queries.some((q) => q.sql.startsWith("UPDATE projects"))).toBe(false);
  });

  it("형식 오류 · 예약어는 400", async () => {
    given();
    for (const subdomain of ["a", "api", "verify-d1", "service-9", "Bad_Name"]) {
      expect((await patch(subdomain)).statusCode, subdomain).toBe(400);
    }
  });
});

describe("주소 변경 중에는 배포 · 앱 삭제를 막는다 (#301)", () => {
  it("DELETE /projects/:id — 409 ADDRESS_CHANGE_IN_PROGRESS", async () => {
    given({ changing: true });

    const res = await server.inject({ method: "DELETE", url: "/api/v1/projects/3" });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ADDRESS_CHANGE_IN_PROGRESS");
    expect(boss.sentJobs).toEqual([]);
  });

  function deploymentService() {
    return new DeploymentService(
      pool as unknown as Pool,
      boss as unknown as PgBoss,
      new MockStorage() as unknown as Storage,
    );
  }

  it("새 배포 — 배포 row 를 만드는 트랜잭션에서 프로젝트를 잠그고 409", async () => {
    pool.on(/SELECT id FROM environments WHERE \(project_id = \$1 OR project_id IS NULL\) AND type = \$2/, () => ({
      rows: [{ id: 10 }],
    }));
    pool.on(/AS address_change_active FROM projects WHERE id = \$1 FOR SHARE/, () => ({
      rows: [{ address_change_active: true }],
    }));
    pool.on(/INSERT INTO deployments/, () => ({ rows: [{ id: 99 }] }));

    await expect(
      deploymentService().create({ projectId: 3, targetVendor: "aws", fileBuffer: Buffer.from("zip") }),
    ).rejects.toMatchObject({ statusCode: 409, code: "ADDRESS_CHANGE_IN_PROGRESS" });
    expect(queries.some((q) => /INSERT INTO deployments/.test(q.sql))).toBe(false);
    expect(boss.sentJobs).toEqual([]);
  });

  it("재배포 · 롤백 · 환경 전환도 409", async () => {
    pool.on(/SELECT id, status, target_profile, target_environment_id/, () => ({
      rows: [{
        id: "42", status: "succeeded", project_id: "3", target_profile: "aws-ecs-basic",
        target_environment_id: "10", registry_environment_id: "10",
      }],
    }));
    pool.on(/FROM ir_versions/, () => ({
      rows: [{ id: 1, ir_json: { metadata: { name: "a" }, services: {}, deploy: { profile: "aws-ecs-basic" } }, source: "analyzer" }],
    }));
    pool.on(/AS address_change_active FROM projects WHERE id = \$1 FOR SHARE/, () => ({
      rows: [{ address_change_active: true }],
    }));
    pool.on(/INSERT INTO deployments/, () => ({ rows: [{ id: 99 }] }));

    await expect(deploymentService().redeploy(42)).rejects.toMatchObject({
      statusCode: 409, code: "ADDRESS_CHANGE_IN_PROGRESS",
    });
    expect(boss.sentJobs).toEqual([]);
  });
});
