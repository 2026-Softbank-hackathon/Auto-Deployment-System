import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "@camellia/db";
import type { WorkerDeps } from "../src/deps.js";
import { handleBuild } from "../src/handlers/build.js";

const databaseUrl = process.env["REDEPLOY_TEST_DATABASE_URL"];
const schema = `build_reuse_test_${randomUUID().replaceAll("-", "")}`;
let admin: Pool;
let pool: Pool;

const OLD_DIGEST = `sha256:${"c".repeat(64)}`;

describe.skipIf(!databaseUrl)("재배포 이미지 재사용: isolated PostgreSQL", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    for (const file of ["001_initial.sql", "002_diagnosis.sql", "004_secrets_environments.sql", "006_deployment_environments.sql", "007_build_artifacts.sql", "019_deploy_mode.sql"]) {
      await pool.query(await readFile(new URL(`../../../packages/db/migrations/${file}`, import.meta.url), "utf8"));
    }
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  async function fixture(sourceAdapter: string | null = null) {
    const project = await pool.query<{ id: string }>("INSERT INTO projects(name) VALUES($1) RETURNING id", [randomUUID()]);
    const projectId = project.rows[0]!.id;
    const env = async (type: string) => {
      const result = await pool.query<{ id: string }>(
        "INSERT INTO environments(project_id, name, type, aws_config) VALUES($1, $2, $3, $4) RETURNING id",
        [projectId, randomUUID(), type, type === "aws" ? { credentialsType: "access_key", region: "ap-northeast-2", accessKeyIdSecretName: "a", secretAccessKeySecretName: "b" } : null],
      );
      return result.rows[0]!.id;
    };
    const registryA = await env("aws");
    const registryB = await env("aws");
    const onprem = await env("onprem");

    const source = await pool.query<{ id: string }>(
      `INSERT INTO deployments(project_id, status, target_profile, target_environment_id, registry_environment_id)
       VALUES($1, 'succeeded', 'aws-ecs-basic', $2, $2) RETURNING id`,
      [projectId, registryA],
    );
    const sourceId = Number(source.rows[0]!.id);
    await pool.query(
      `INSERT INTO build_artifacts(deployment_id, repository_uri, image_tag, image_digest, immutable_ref, platform, strategy, lambda_web_adapter)
       VALUES($1, 'repo', 'v1-d1', $2, $3, 'linux/amd64', 'dockerfile', $4)`,
      [sourceId, OLD_DIGEST, `repo@${OLD_DIGEST}`, sourceAdapter],
    );

    const redeploy = async (targetEnvironmentId: string, registryEnvironmentId: string, profile = "onprem-docker-basic") => {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO deployments(project_id, status, target_profile, target_environment_id, registry_environment_id)
         VALUES($1, 'queued', $4, $2, $3) RETURNING id`,
        [projectId, targetEnvironmentId, registryEnvironmentId, profile],
      );
      const id = Number(result.rows[0]!.id);
      await pool.query("INSERT INTO source_versions(deployment_id, sha256, storage_key, size_bytes) VALUES($1, 'x', 'sources/x.zip', 1)", [id]);
      await pool.query("INSERT INTO ir_versions(deployment_id, ir_json, source) VALUES($1, '{}', 'analyzer_cache')", [id]);
      return id;
    };

    const notify = vi.fn(async () => undefined);
    const send = vi.fn(async () => "job");
    const storage = { exists: vi.fn(async () => false), get: vi.fn(), put: vi.fn(async () => undefined) };
    const deps = { pool, notifier: { notify }, boss: { send }, storage } as unknown as WorkerDeps;
    return { sourceId, registryA, registryB, onprem, redeploy, deps, notify, send };
  }

  async function row(deploymentId: number) {
    const result = await pool.query(
      `SELECT d.status, d.error, a.image_digest, a.immutable_ref, a.lambda_web_adapter
       FROM deployments d LEFT JOIN build_artifacts a ON a.deployment_id = d.id
       WHERE d.id = $1`,
      [deploymentId],
    );
    return result.rows[0];
  }

  it("같은 Registry 환경이면 원본 이미지(digest)를 복사하고 빌드 없이 provisioning 으로 간다", async () => {
    const f = await fixture();
    const id = await f.redeploy(f.onprem, f.registryA);

    await handleBuild({ data: { deployment_id: id, redeployed_from: f.sourceId } }, f.deps);

    expect(await row(id)).toMatchObject({
      status: "provisioning",
      image_digest: OLD_DIGEST,
      immutable_ref: `repo@${OLD_DIGEST}`,
    });
    expect(f.send).toHaveBeenCalledWith("provision", { deployment_id: id });
    // 원본 artifact 는 그대로
    expect((await row(f.sourceId)).image_digest).toBe(OLD_DIGEST);
  });

  it("Registry 환경이 다르면 복사하지 않고 빌드 경로로 간다", async () => {
    const f = await fixture();
    const id = await f.redeploy(f.registryB, f.registryB);

    await handleBuild({ data: { deployment_id: id, redeployed_from: f.sourceId } }, f.deps);

    // 테스트 deps 에 빌드 의존성이 없으므로 빌드 경로로 가면 BUILD_DEPENDENCY_MISSING 으로 실패한다
    expect(await row(id)).toMatchObject({
      status: "failed",
      error: "BUILD_DEPENDENCY_MISSING",
      image_digest: null,
    });
  });

  it("서버리스 배포는 Lambda Web Adapter 가 없는 예전 이미지를 재사용하지 않고 다시 빌드한다 (#282)", async () => {
    const f = await fixture(null);
    const id = await f.redeploy(f.registryA, f.registryA, "aws-lambda-basic");

    await handleBuild({ data: { deployment_id: id, redeployed_from: f.sourceId } }, f.deps);

    expect(await row(id)).toMatchObject({ status: "failed", error: "BUILD_DEPENDENCY_MISSING", image_digest: null });
  });

  it("서버리스 배포도 Lambda Web Adapter 가 든 이미지는 그대로 재사용한다 (#282)", async () => {
    const f = await fixture("1.1.0");
    const id = await f.redeploy(f.registryA, f.registryA, "aws-lambda-basic");

    await handleBuild({ data: { deployment_id: id, redeployed_from: f.sourceId } }, f.deps);

    expect(await row(id)).toMatchObject({ status: "provisioning", image_digest: OLD_DIGEST, lambda_web_adapter: "1.1.0" });
  });
});
