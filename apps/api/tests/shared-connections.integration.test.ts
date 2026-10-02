/**
 * apps/api/tests/shared-connections.integration.test.ts
 * #215 공용 연결 — 실제 PostgreSQL 에서 마이그레이션 012 와 서비스 SQL 을 확인한다.
 * SHARED_CONNECTIONS_TEST_DATABASE_URL 이 있을 때만 실행 (격리 schema 생성 후 삭제).
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "@camellia/db";
import { MIGRATION_FILES } from "@camellia/db/migrations";
import type PgBoss from "pg-boss";
import type { Storage } from "@camellia/storage";
import { EnvironmentService } from "../src/services/environment-service.js";
import { SecretService } from "../src/services/secret-service.js";
import { DeploymentService } from "../src/services/deployment-service.js";
import { ApprovalService } from "../src/services/approval-service.js";

const databaseUrl = process.env["SHARED_CONNECTIONS_TEST_DATABASE_URL"];
const schema = `shared_conn_test_${randomUUID().replaceAll("-", "")}`;
const MASTER_KEY = Buffer.alloc(32, 0x5a);
let admin: Pool;
let pool: Pool;

async function runMigration(file: string) {
  const sql = await readFile(
    new URL(`../../../packages/db/migrations/${file}`, import.meta.url),
    "utf8",
  );
  await pool.query(sql);
}

describe.skipIf(!databaseUrl)("공용 연결 (#215): isolated PostgreSQL", () => {
  let environments: EnvironmentService;
  let secrets: SecretService;
  let deployments: DeploymentService;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    for (const file of MIGRATION_FILES) await runMigration(file);
    environments = new EnvironmentService(pool);
    secrets = new SecretService(pool, MASTER_KEY);
    deployments = new DeploymentService(
      pool,
      { send: vi.fn(async () => "job") } as unknown as PgBoss,
      { put: vi.fn(async () => undefined) } as unknown as Storage,
    );
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE env_locks, agents, deployments, environments, secrets, projects RESTART IDENTITY CASCADE",
    );
  });

  async function project(): Promise<number> {
    const result = await pool.query<{ id: string }>(
      "INSERT INTO projects(name) VALUES($1) RETURNING id",
      [randomUUID()],
    );
    return Number(result.rows[0]!.id);
  }

  async function sharedAws(name = "aws-shared", isDefault?: boolean) {
    await secrets.create({ name: `${name}-id`, value: "AKIA" }).catch(() => undefined);
    await secrets.create({ name: `${name}-secret`, value: "s" }).catch(() => undefined);
    return environments.create({
      name,
      type: "aws",
      ...(isDefault === undefined ? {} : { isDefault }),
      awsConfig: {
        credentialsType: "access_key",
        accessKeyIdSecretName: `${name}-id`,
        secretAccessKeySecretName: `${name}-secret`,
        region: "ap-northeast-2",
      },
    });
  }

  async function sharedOnprem(name = "mac-shared") {
    return environments.create({
      name,
      type: "onprem",
      onpremConfig: { agentRegistrationToken: "tok", hostname: "mac.local" },
    });
  }

  it("마이그레이션 012 는 다시 돌려도 실패하지 않는다", async () => {
    await expect(runMigration("012_shared_connections.sql")).resolves.toBeUndefined();
  });

  describe("시크릿", () => {
    it("projectId 없이 저장하면 공용 시크릿 — 목록 · 복호화 · 중복 409 가 공용 범위에서 동작", async () => {
      const projectId = await project();
      const created = await secrets.create({ name: "aws-key", value: "AKIA_SHARED" });
      expect(created).toMatchObject({ name: "aws-key", projectId: null, shared: true });

      // 같은 이름이라도 프로젝트 시크릿은 따로 있다
      await secrets.create({ projectId, name: "aws-key", value: "AKIA_PROJECT" });
      await expect(secrets.create({ name: "aws-key", value: "x" })).rejects.toMatchObject({
        statusCode: 409,
      });

      expect((await secrets.list({})).map((s) => [s.name, s.shared])).toEqual([["aws-key", true]]);
      const projectList = await secrets.list({ projectId });
      expect(projectList).toHaveLength(1);
      expect(projectList[0]).toMatchObject({ shared: false });

      expect(await secrets.decrypt({ projectId: null, name: "aws-key" })).toBe("AKIA_SHARED");
      expect(await secrets.decrypt({ projectId, name: "aws-key" })).toBe("AKIA_PROJECT");
    });

    it("공용 연결이 참조하는 공용 시크릿은 지우지 못하고, 안 쓰는 공용 시크릿은 지운다", async () => {
      await sharedAws();
      await expect(secrets.delete({ name: "aws-shared-id" })).rejects.toMatchObject({
        statusCode: 409,
        code: "SECRET_IN_USE",
      });
      await secrets.create({ name: "unused", value: "v" });
      await expect(secrets.delete({ name: "unused" })).resolves.toBeUndefined();
      await expect(secrets.delete({ name: "unused" })).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe("연결(environments)", () => {
    it("projectId 없이 등록하면 공용 연결 — 종류별 첫 연결이 기본값, 이름 중복 409", async () => {
      const first = await sharedAws("aws-a");
      expect(first).toMatchObject({ projectId: null, shared: true, isDefault: true });
      const second = await sharedAws("aws-b");
      expect(second.isDefault).toBe(false);
      const third = await sharedAws("aws-c", true);
      expect(third.isDefault).toBe(true);

      const list = await environments.list({});
      expect(list.map((e) => [e.name, e.isDefault, e.shared])).toEqual([
        ["aws-a", false, true],
        ["aws-b", false, true],
        ["aws-c", true, true],
      ]);

      await expect(sharedAws("aws-a")).rejects.toMatchObject({ statusCode: 409 });
    });

    it("공용 연결은 공용 시크릿만 참조할 수 있다", async () => {
      const projectId = await project();
      await secrets.create({ projectId, name: "p-id", value: "a" });
      await secrets.create({ projectId, name: "p-secret", value: "b" });
      await expect(
        environments.create({
          name: "aws",
          type: "aws",
          awsConfig: {
            credentialsType: "access_key",
            accessKeyIdSecretName: "p-id",
            secretAccessKeySecretName: "p-secret",
            region: "ap-northeast-2",
          },
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("프로젝트 연결 목록과 공용 연결 목록은 섞이지 않는다", async () => {
      const projectId = await project();
      await sharedOnprem();
      await environments.create({
        projectId,
        name: "own-mac",
        type: "onprem",
        onpremConfig: { agentRegistrationToken: "t", hostname: "h" },
      });

      expect((await environments.list({ projectId })).map((e) => [e.name, e.shared])).toEqual([
        ["own-mac", false],
      ]);
      expect((await environments.list({})).map((e) => [e.name, e.shared])).toEqual([
        ["mac-shared", true],
      ]);
    });

    it("On-Prem 연결은 agents.last_seen_at 으로 Agent 연결 여부를 알려 준다", async () => {
      const online = await sharedOnprem("mac-online");
      const stale = await sharedOnprem("mac-stale");
      await sharedOnprem("mac-none");
      await pool.query(
        `INSERT INTO agents(environment_id, long_lived_key_hash, last_seen_at)
         VALUES ($1, 'h1', NOW() - INTERVAL '10 seconds'),
                ($2, 'h2', NOW() - INTERVAL '10 minutes')`,
        [online.id, stale.id],
      );

      const byName = Object.fromEntries((await environments.list({})).map((e) => [e.name, e]));
      expect(byName["mac-online"]).toMatchObject({ agentOnline: true });
      expect(byName["mac-online"]!.agentLastSeenAt).not.toBeNull();
      expect(byName["mac-stale"]).toMatchObject({ agentOnline: false });
      expect(byName["mac-stale"]!.agentLastSeenAt).not.toBeNull();
      expect(byName["mac-none"]).toMatchObject({ agentOnline: false, agentLastSeenAt: null });

      const one = await environments.get(Number(online.id));
      expect(one).toMatchObject({ agentOnline: true, shared: true });
    });

    it("배포 기록이 있는 연결을 지우면 500 대신 409", async () => {
      const projectId = await project();
      const env = await sharedAws();
      await pool.query(
        `INSERT INTO deployments(project_id, status, target_environment_id, registry_environment_id)
         VALUES ($1, 'succeeded', $2, $2)`,
        [projectId, env.id],
      );
      await expect(environments.delete(Number(env.id))).rejects.toMatchObject({
        statusCode: 409,
        code: "CONFLICT",
      });
    });
  });

  describe("배포 생성 시 연결 고르기", () => {
    async function createdEnvironments(deploymentId: string) {
      const result = await pool.query<{
        target_environment_id: string;
        registry_environment_id: string;
        target_profile: string;
      }>(
        `SELECT target_environment_id, registry_environment_id, target_profile
         FROM deployments WHERE id = $1`,
        [deploymentId],
      );
      return result.rows[0]!;
    }

    it("프로젝트 연결이 없으면 공용 기본 연결을 쓴다 (On-Prem 의 레지스트리도 공용 AWS)", async () => {
      const projectId = await project();
      const aws = await sharedAws();
      const mac = await sharedOnprem();

      const toAws = await deployments.create({
        projectId,
        targetVendor: "aws",
        fileBuffer: Buffer.from("zip"),
      });
      expect(await createdEnvironments(toAws.deploymentId)).toEqual({
        target_environment_id: String(aws.id),
        registry_environment_id: String(aws.id),
        target_profile: "aws-ecs-basic",
      });

      const toMac = await deployments.create({
        projectId,
        targetVendor: "onprem",
        fileBuffer: Buffer.from("zip"),
      });
      expect(await createdEnvironments(toMac.deploymentId)).toEqual({
        target_environment_id: String(mac.id),
        registry_environment_id: String(aws.id),
        target_profile: "onprem-docker-basic",
      });
    });

    it("프로젝트 기본 연결이 있으면 공용보다 먼저 쓴다", async () => {
      const projectId = await project();
      await sharedAws();
      await secrets.create({ projectId, name: "p-id", value: "a" });
      await secrets.create({ projectId, name: "p-secret", value: "b" });
      const own = await environments.create({
        projectId,
        name: "own-aws",
        type: "aws",
        awsConfig: {
          credentialsType: "access_key",
          accessKeyIdSecretName: "p-id",
          secretAccessKeySecretName: "p-secret",
          region: "ap-northeast-2",
        },
      });

      const created = await deployments.create({
        projectId,
        targetVendor: "aws",
        fileBuffer: Buffer.from("zip"),
      });
      expect((await createdEnvironments(created.deploymentId)).target_environment_id).toBe(
        String(own.id),
      );
    });

    it("environment_id 로 고르면 연결 type 이 벤더 · 프로필을 정한다", async () => {
      const projectId = await project();
      const aws = await sharedAws();
      await sharedAws("aws-other");
      const mac = await sharedOnprem();

      const chosen = await deployments.create({
        projectId,
        environmentId: Number(mac.id),
        fileBuffer: Buffer.from("zip"),
      });
      expect(await createdEnvironments(chosen.deploymentId)).toEqual({
        target_environment_id: String(mac.id),
        registry_environment_id: String(aws.id),
        target_profile: "onprem-docker-basic",
      });

      await expect(
        deployments.create({
          projectId,
          environmentId: Number(mac.id),
          targetVendor: "aws",
          fileBuffer: Buffer.from("zip"),
        }),
      ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });
    });

    it("다른 프로젝트 전용 연결은 고를 수 없다", async () => {
      const mine = await project();
      const other = await project();
      const foreign = await environments.create({
        projectId: other,
        name: "other-mac",
        type: "onprem",
        onpremConfig: { agentRegistrationToken: "t", hostname: "h" },
      });
      await expect(
        deployments.create({
          projectId: mine,
          environmentId: Number(foreign.id),
          fileBuffer: Buffer.from("zip"),
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("공용 AWS 연결의 시크릿이 없어지면 공용 범위에서 찾아 409", async () => {
      const projectId = await project();
      await sharedAws();
      await pool.query("DELETE FROM secrets WHERE name = 'aws-shared-secret'");
      await expect(
        deployments.create({ projectId, targetVendor: "aws", fileBuffer: Buffer.from("zip") }),
      ).rejects.toMatchObject({ statusCode: 409, code: "AWS_CREDENTIALS_MISSING" });
    });
  });

  describe("환경 락", () => {
    async function awaitingTarget(projectId: number, environmentId: number | string) {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO deployments(project_id, status, target_environment_id, registry_environment_id)
         VALUES ($1, 'awaiting_target_confirmation', $2, $2) RETURNING id`,
        [projectId, environmentId],
      );
      return Number(result.rows[0]!.id);
    }

    it("같은 공용 연결이어도 다른 앱끼리는 막지 않고, 같은 앱은 막는다", async () => {
      const approvals = new ApprovalService(pool);
      const env = await sharedAws();
      const appA = await project();
      const appB = await project();

      const a1 = await awaitingTarget(appA, env.id);
      const b1 = await awaitingTarget(appB, env.id);
      const a2 = await awaitingTarget(appA, env.id);

      await expect(
        approvals.submit({ deploymentId: a1, gate: "target", decision: "approve" }),
      ).resolves.toMatchObject({ lockAcquired: true });
      await expect(
        approvals.submit({ deploymentId: b1, gate: "target", decision: "approve" }),
      ).resolves.toMatchObject({ lockAcquired: true });
      await expect(
        approvals.submit({ deploymentId: a2, gate: "target", decision: "approve" }),
      ).rejects.toMatchObject({ statusCode: 409, code: "DEPLOYMENT_LOCKED" });

      const keys = await pool.query<{ env_key: string }>("SELECT env_key FROM env_locks ORDER BY id");
      expect(keys.rows.map((r) => r.env_key)).toEqual([
        `environment:${env.id}:project:${appA}`,
        `environment:${env.id}:project:${appB}`,
      ]);
    });
  });
});
