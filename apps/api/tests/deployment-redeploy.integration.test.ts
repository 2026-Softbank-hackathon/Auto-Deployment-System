/**
 * apps/api/tests/deployment-redeploy.integration.test.ts
 * DeploymentService.redeploy 를 실제 PostgreSQL 에 돌려 SQL 을 검증한다.
 * REDEPLOY_TEST_DATABASE_URL 이 없으면 건너뜀.
 *
 * - 롤백: 새 배포가 떠 있는 동안 이전 배포를 같은 환경에 재배포
 * - 환경 전환: AWS → 온프레미스 (프로필 재선정 · Registry 유지)
 * - 공용 환경 (project_id NULL): 다른 프로젝트의 진행 중 배포에는 막히지 않음
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "@camellia/db";
import { DeploymentService } from "../src/services/deployment-service.js";
import { MockPgBoss, MockStorage } from "./mocks/db.js";

const databaseUrl = process.env["REDEPLOY_TEST_DATABASE_URL"];
const schema = `redeploy_test_${randomUUID().replaceAll("-", "")}`;
let admin: Pool;
let pool: Pool;

describe.skipIf(!databaseUrl)("DeploymentService.redeploy: isolated PostgreSQL", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    for (const file of ["001_initial.sql", "004_secrets_environments.sql", "006_deployment_environments.sql", "007_build_artifacts.sql", "015_project_deletion.sql"]) {
      await pool.query(await readFile(new URL(`../../../packages/db/migrations/${file}`, import.meta.url), "utf8"));
    }
    // 공용 환경(project_id NULL)은 별도 PR 에서 허용된다 — 여기서는 미리 풀어 둔다.
    await pool.query("ALTER TABLE environments ALTER COLUMN project_id DROP NOT NULL");
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  function service() {
    const boss = new MockPgBoss();
    const svc = new DeploymentService(
      pool,
      boss as unknown as import("pg-boss").default,
      new MockStorage() as unknown as import("@camellia/storage").Storage,
    );
    return { svc, boss };
  }

  async function project() {
    const result = await pool.query<{ id: string }>("INSERT INTO projects(name) VALUES($1) RETURNING id", [randomUUID()]);
    return result.rows[0]!.id;
  }

  async function environment(projectId: string | null, type: "aws" | "onprem", isDefault = false) {
    const result = await pool.query<{ id: string }>(
      "INSERT INTO environments(project_id, name, type, is_default) VALUES($1, $2, $3, $4) RETURNING id",
      [projectId, randomUUID(), type, isDefault],
    );
    return result.rows[0]!.id;
  }

  async function deployment(input: {
    projectId: string;
    status: string;
    profile: string;
    target: string;
    registry: string | null;
    digest?: string;
  }) {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO deployments(project_id, status, target_profile, target_environment_id, registry_environment_id)
       VALUES($1, $2, $3, $4, $5) RETURNING id`,
      [input.projectId, input.status, input.profile, input.target, input.registry],
    );
    const id = result.rows[0]!.id;
    await pool.query("INSERT INTO source_versions(deployment_id, sha256, storage_key, size_bytes) VALUES($1, 'x', 'sources/x.zip', 1)", [id]);
    await pool.query("INSERT INTO ir_versions(deployment_id, ir_json, source) VALUES($1, $2, 'analyzer')", [id, JSON.stringify({
      $ir_version: "0.1.0",
      metadata: { name: "app", version: "1.0.0" },
      services: { api: { type: "http", port: 3000 } },
      deploy: { profile: input.profile, region: "ap-northeast-2" },
    })]);
    if (input.digest) {
      await pool.query(
        `INSERT INTO build_artifacts(deployment_id, repository_uri, image_tag, image_digest, immutable_ref, platform, strategy)
         VALUES($1, 'repo', 't', $2, $3, 'linux/amd64', 'dockerfile')`,
        [id, input.digest, `repo@${input.digest}`],
      );
    }
    return Number(id);
  }

  async function row(id: string) {
    const result = await pool.query(
      `SELECT status, target_profile, target_environment_id::text, registry_environment_id::text
       FROM deployments WHERE id = $1`,
      [id],
    );
    return result.rows[0];
  }

  const digest = (c: string) => `sha256:${c.repeat(64)}`;

  async function storedIr(id: number | string) {
    const result = await pool.query("SELECT ir_json FROM ir_versions WHERE deployment_id=$1 ORDER BY id DESC LIMIT 1", [id]);
    return result.rows[0]!.ir_json;
  }

  it("롤백 — 새 배포가 떠 있어도 이전 배포를 같은 환경에 다시 배포하고, build 는 이전 배포 이미지를 재사용할 수 있다", async () => {
    const projectId = await project();
    const aws = await environment(projectId, "aws", true);
    const v1 = await deployment({ projectId, status: "succeeded", profile: "aws-ecs-basic", target: aws, registry: aws, digest: digest("1") });
    await deployment({ projectId, status: "succeeded", profile: "aws-ecs-basic", target: aws, registry: aws, digest: digest("2") });
    const { svc, boss } = service();

    const result = await svc.redeploy(v1);

    expect(await storedIr(result.deploymentId)).toEqual(await storedIr(v1));

    expect(await row(result.deploymentId)).toEqual({
      status: "queued",
      target_profile: "aws-ecs-basic",
      target_environment_id: aws,
      registry_environment_id: aws,
    });
    expect(boss.sentJobs).toEqual([
      { name: "build", data: { deployment_id: expect.anything(), redeployed_from: v1 } },
    ]);
    // build 핸들러의 재사용 조건(같은 프로젝트 · 같은 Registry) 충족 → v1 digest 가 복사됨
    const reusable = await pool.query(
      `SELECT artifact.image_digest
       FROM deployments target
       JOIN deployments source ON source.id = $2
       JOIN build_artifacts artifact ON artifact.deployment_id = source.id
       WHERE target.id = $1
         AND source.project_id = target.project_id
         AND source.registry_environment_id = target.registry_environment_id`,
      [result.deploymentId, v1],
    );
    expect(reusable.rows).toEqual([{ image_digest: digest("1") }]);
  });

  it("AWS → 온프레미스 전환 — 프로필을 다시 고르고 Registry 는 원본 AWS 환경을 유지한다", async () => {
    const projectId = await project();
    const aws = await environment(projectId, "aws", true);
    const onprem = await environment(projectId, "onprem", true);
    const v1 = await deployment({ projectId, status: "succeeded", profile: "aws-ecs-basic", target: aws, registry: aws, digest: digest("3") });
    const { svc } = service();

    const result = await svc.redeploy(v1, { targetEnvironmentId: Number(onprem) });

    const sourceIr = await storedIr(v1);
    expect(await storedIr(result.deploymentId)).toEqual({ ...sourceIr, deploy: { ...sourceIr.deploy, profile: "onprem-docker-basic" } });
    expect((await storedIr(v1)).deploy.profile).toBe("aws-ecs-basic");

    expect(await row(result.deploymentId)).toMatchObject({
      target_profile: "onprem-docker-basic",
      target_environment_id: onprem,
      registry_environment_id: aws,
    });

    // 다시 AWS 로 — 프로필 aws-ecs-basic, Registry = 대상 AWS 환경
    await pool.query("UPDATE deployments SET status = 'succeeded' WHERE id = $1", [result.deploymentId]);
    const back = await svc.redeploy(Number(result.deploymentId), { targetEnvironmentId: Number(aws) });
    expect(await storedIr(back.deploymentId)).toEqual(sourceIr);
    expect((await storedIr(result.deploymentId)).deploy.profile).toBe("onprem-docker-basic");
    expect(await row(back.deploymentId)).toMatchObject({
      target_profile: "aws-ecs-basic",
      target_environment_id: aws,
      registry_environment_id: aws,
    });
  });

  it("Registry 가 없는 온프레미스 배포를 옮기면 공용 기본 AWS 환경을 Registry 로 쓴다", async () => {
    const projectId = await project();
    const sharedAws = await environment(null, "aws", true);
    const onpremA = await environment(projectId, "onprem", true);
    const onpremB = await environment(projectId, "onprem");
    const v1 = await deployment({ projectId, status: "failed", profile: "onprem-docker-basic", target: onpremA, registry: null });
    const { svc } = service();

    const result = await svc.redeploy(v1, { targetEnvironmentId: Number(onpremB) });

    expect(await row(result.deploymentId)).toMatchObject({
      target_profile: "onprem-docker-basic",
      target_environment_id: onpremB,
      registry_environment_id: sharedAws,
    });
    await pool.query("DELETE FROM deployments WHERE registry_environment_id = $1", [sharedAws]);
    await pool.query("DELETE FROM environments WHERE id = $1", [sharedAws]);
  });

  it("공용 환경 — 다른 프로젝트의 진행 중 배포에는 막히지 않고, 같은 프로젝트면 409", async () => {
    const projectId = await project();
    const otherProjectId = await project();
    const aws = await environment(projectId, "aws", true);
    const sharedOnprem = await environment(null, "onprem");
    const v1 = await deployment({ projectId, status: "succeeded", profile: "aws-ecs-basic", target: aws, registry: aws });
    const otherAws = await environment(otherProjectId, "aws", true);
    await deployment({ projectId: otherProjectId, status: "provisioning", profile: "onprem-docker-basic", target: sharedOnprem, registry: otherAws });
    const { svc } = service();

    const result = await svc.redeploy(v1, { targetEnvironmentId: Number(sharedOnprem) });
    expect(await row(result.deploymentId)).toMatchObject({
      target_profile: "onprem-docker-basic",
      target_environment_id: sharedOnprem,
      registry_environment_id: aws,
    });

    // 방금 만든 배포(queued)가 같은 프로젝트의 진행 중 배포 → 다시 요청하면 409
    await expect(svc.redeploy(v1, { targetEnvironmentId: Number(sharedOnprem) })).rejects.toMatchObject({
      statusCode: 409,
      code: "DEPLOYMENT_LOCKED",
    });
  });

  it("다른 프로젝트의 환경은 400, 없는 환경은 404", async () => {
    const projectId = await project();
    const otherProjectId = await project();
    const aws = await environment(projectId, "aws", true);
    const otherOnprem = await environment(otherProjectId, "onprem", true);
    const v1 = await deployment({ projectId, status: "succeeded", profile: "aws-ecs-basic", target: aws, registry: aws });
    const { svc } = service();

    await expect(svc.redeploy(v1, { targetEnvironmentId: Number(otherOnprem) })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.redeploy(v1, { targetEnvironmentId: 99_999_999 })).rejects.toMatchObject({ statusCode: 404 });
  });
});
