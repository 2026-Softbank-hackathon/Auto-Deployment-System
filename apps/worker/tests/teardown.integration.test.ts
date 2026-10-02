/**
 * apps/worker/tests/teardown.integration.test.ts
 * 앱 삭제 (#247) — 실제 PostgreSQL 에서 teardown 의 DB 정리가 FK 를 통과하고 공용 연결 · 다른 앱을 건드리지 않는지 확인.
 * TEARDOWN_TEST_DATABASE_URL 이 있을 때만 실행 (격리 schema 생성 후 삭제).
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "@camellia/db";
import { MIGRATION_FILES } from "@camellia/db/migrations";
import type { WorkerDeps } from "../src/deps.js";
import { handleTeardown } from "../src/handlers/teardown.js";
import { TerraformCliError } from "../src/terraform-cli.js";

const databaseUrl = process.env["TEARDOWN_TEST_DATABASE_URL"];
const schema = `teardown_test_${randomUUID().replaceAll("-", "")}`;
const DIGEST = `sha256:${"b".repeat(64)}`;
const AWS_CONFIG = {
  credentialsType: "access_key",
  accessKeyIdSecretName: "aws-id",
  secretAccessKeySecretName: "aws-secret",
  region: "ap-northeast-2",
};
const IR = {
  $ir_version: "0.1.0",
  metadata: { name: "todo", version: "1.0.0" },
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

let admin: Pool;
let pool: Pool;

describe.skipIf(!databaseUrl)("teardown (#247): isolated PostgreSQL", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    for (const file of MIGRATION_FILES) {
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

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE audit_logs, ai_usage, agents, deployments, environments, secrets, env_vars, projects RESTART IDENTITY CASCADE",
    );
  });

  async function id(sql: string, params: unknown[]): Promise<number> {
    const result = await pool.query<{ id: string }>(sql, params);
    return Number(result.rows[0]!.id);
  }

  async function project(name: string, deleting = true): Promise<number> {
    return id(
      `INSERT INTO projects(name, deletion_status, deletion_requested_at)
       VALUES($1, $2, CASE WHEN $2::text IS NULL THEN NULL ELSE NOW() END) RETURNING id`,
      [name, deleting ? "deleting" : null],
    );
  }

  async function environment(projectId: number | null, name: string, type: "aws" | "onprem"): Promise<number> {
    return id(
      `INSERT INTO environments(project_id, name, type, aws_config, onprem_config)
       VALUES($1, $2, $3, $4::jsonb, $5::jsonb) RETURNING id`,
      [
        projectId,
        name,
        type,
        type === "aws" ? JSON.stringify(AWS_CONFIG) : null,
        type === "onprem" ? JSON.stringify({ hostname: "mac.local" }) : null,
      ],
    );
  }

  async function secret(projectId: number | null, name: string): Promise<void> {
    await pool.query(
      `INSERT INTO secrets(project_id, name, ciphertext, iv, auth_tag) VALUES($1, $2, 'c', 'i', 't')`,
      [projectId, name],
    );
  }

  async function agent(environmentId: number): Promise<void> {
    const agentId = await id(
      `INSERT INTO agents(environment_id, long_lived_key_hash) VALUES($1, 'hash') RETURNING id`,
      [environmentId],
    );
    await pool.query(
      `INSERT INTO agent_registration_tokens(environment_id, token_hash, expires_at, consumed_at, consumed_by_agent_id)
       VALUES($1, $2, NOW(), NOW(), $3)`,
      [environmentId, randomUUID(), agentId],
    );
  }

  /** 배포 1건과 딸린 row 들 (분석 · IR · 빌드 · 승인 · 단계 · 헬스체크 · 락 · AI 사용량) */
  async function deployment(input: {
    projectId: number;
    targetEnvironmentId: number;
    registryEnvironmentId: number;
    profile: string;
    onprem?: boolean;
  }): Promise<number> {
    const deploymentId = await id(
      `INSERT INTO deployments(project_id, status, target_profile, target_environment_id, registry_environment_id)
       VALUES($1, 'succeeded', $2, $3, $4) RETURNING id`,
      [input.projectId, input.profile, input.targetEnvironmentId, input.registryEnvironmentId],
    );
    const sourceId = await id(
      `INSERT INTO source_versions(deployment_id, sha256, storage_key, size_bytes) VALUES($1, 'sha', 'sources/sha.zip', 1) RETURNING id`,
      [deploymentId],
    );
    await pool.query(
      `INSERT INTO analysis_reports(deployment_id, source_version_id, services_json, resources_json, warnings_json, unresolved_json, ir_valid)
       VALUES($1, $2, '[]', '[]', '[]', '[]', true)`,
      [deploymentId, sourceId],
    );
    await pool.query(`INSERT INTO ir_versions(deployment_id, ir_json, source) VALUES($1, $2::jsonb, 'analyzer')`, [
      deploymentId,
      JSON.stringify(input.profile === "aws-ecs-basic" ? IR : { ...IR, deploy: { profile: input.profile } }),
    ]);
    await pool.query(
      `INSERT INTO build_artifacts(deployment_id, repository_uri, image_tag, image_digest, immutable_ref, platform, strategy)
       VALUES($1, 'repo', 'tag', $2, $3, 'linux/amd64', 'dockerfile')`,
      [deploymentId, DIGEST, `123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/camellia/projects/${input.projectId}@${DIGEST}`],
    );
    await pool.query(`INSERT INTO approvals(deployment_id, gate, decision) VALUES($1, 'target', 'approve')`, [deploymentId]);
    const stepId = await id(
      `INSERT INTO deployment_steps(deployment_id, step_name, status) VALUES($1, 'verify', 'succeeded') RETURNING id`,
      [deploymentId],
    );
    await pool.query(
      `INSERT INTO health_check_attempts(deployment_step_id, environment_id, attempt, checked_at, passed)
       VALUES($1, $2, 1, NOW(), true)`,
      [stepId, String(input.targetEnvironmentId)],
    );
    await pool.query(
      `INSERT INTO env_locks(env_key, deployment_id, lease_expires_at) VALUES($1, $2, NOW())`,
      [randomUUID(), deploymentId],
    );
    await pool.query(
      `INSERT INTO ai_usage(deployment_id, model, input_tokens, output_tokens, estimated_cost_usd) VALUES($1, 'm', 1, 1, 0)`,
      [deploymentId],
    );
    if (input.onprem) {
      await pool.query(
        `INSERT INTO onprem_agent_jobs(job_id, deployment_id, environment_id, status, payload)
         VALUES($1, $2, $3, 'ready_for_verify', '{}'::jsonb)`,
        [String(deploymentId), deploymentId, input.targetEnvironmentId],
      );
    }
    return deploymentId;
  }

  function deps(options: { destroyFailure?: Error } = {}) {
    const destroy = vi.fn(async () => {
      if (options.destroyFailure) throw options.destroyFailure;
    });
    const read = vi.fn(async (owner: number | null, name: string) => `${owner ?? "shared"}:${name}`);
    const removeProjectOrigins = vi.fn(async () => []);
    const stateStore = { exists: vi.fn(async () => true), delete: vi.fn(async () => undefined) };
    const value = {
      pool,
      boss: {},
      storage: { listKeys: vi.fn(async () => []), delete: vi.fn(async () => undefined) },
      secretReader: { read },
      terraformCli: { destroy },
      terraformBackend: { bucket: "state-bucket", region: "ap-northeast-2", kmsKeyId: "kms" },
      terraformModuleRoot: "/repo/infra/terraform/profiles",
      terraformStateStore: stateStore,
      originActivator: { removeProjectOrigins },
    } as unknown as WorkerDeps;
    return { value, destroy, read, removeProjectOrigins, stateStore };
  }

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const result = await pool.query<{ count: string }>(sql, params);
    return Number(result.rows[0]!.count);
  }

  it("배포 기록 · 프로젝트 전용 연결 · 시크릿 · 환경변수를 지우고 공용 연결과 다른 앱은 남긴다", async () => {
    // 공용 연결 (project_id NULL) — AWS + 온프레미스(Agent 등록됨)
    const sharedAws = await environment(null, "shared-aws", "aws");
    const sharedOnprem = await environment(null, "shared-mac", "onprem");
    await secret(null, "aws-id");
    await secret(null, "aws-secret");
    await agent(sharedOnprem);

    // 삭제할 앱: 공용 AWS · 공용 온프레미스 · 자기 AWS 연결에 배포
    const target = await project("monolith-seohyeon");
    const ownAws = await environment(target, "own-aws", "aws");
    const ownOnprem = await environment(target, "own-mac", "onprem");
    await agent(ownOnprem);
    await secret(target, "aws-id");
    await secret(target, "aws-secret");
    await pool.query(`INSERT INTO env_vars(project_id, name, value) VALUES($1, 'NODE_ENV', 'production')`, [target]);
    await deployment({ projectId: target, targetEnvironmentId: sharedAws, registryEnvironmentId: sharedAws, profile: "aws-ecs-basic" });
    await deployment({ projectId: target, targetEnvironmentId: sharedOnprem, registryEnvironmentId: sharedAws, profile: "onprem-docker-basic", onprem: true });
    await deployment({ projectId: target, targetEnvironmentId: ownAws, registryEnvironmentId: ownAws, profile: "aws-ecs-basic" });
    await deployment({ projectId: target, targetEnvironmentId: ownOnprem, registryEnvironmentId: ownAws, profile: "onprem-docker-basic", onprem: true });

    // 남아야 하는 다른 앱 — 같은 공용 연결에 배포
    const other = await project("other-app", false);
    const otherDeployment = await deployment({
      projectId: other, targetEnvironmentId: sharedAws, registryEnvironmentId: sharedAws, profile: "aws-ecs-basic",
    });

    const d = deps();
    await handleTeardown({ data: { project_id: target } }, d.value);

    // AWS 연결 둘 다 destroy — 공용 연결은 공용 시크릿, 자기 연결은 프로젝트 시크릿
    expect(d.destroy).toHaveBeenCalledTimes(2);
    expect(d.read).toHaveBeenCalledWith(null, "aws-id");
    expect(d.read).toHaveBeenCalledWith(target, "aws-id");
    expect(d.stateStore.delete.mock.calls.map(([location]) => (location as { key: string }).key).sort()).toEqual([
      `projects/${target}/environments/${ownAws}/terraform.tfstate`,
      `projects/${target}/environments/${sharedAws}/terraform.tfstate`,
    ].sort());
    expect(d.removeProjectOrigins).toHaveBeenCalledWith({
      projectId: target,
      onpremDeploymentIds: [expect.any(Number), expect.any(Number)],
    });

    // 삭제된 것
    expect(await count(`SELECT count(*) FROM projects WHERE id = $1`, [target])).toBe(0);
    expect(await count(`SELECT count(*) FROM deployments WHERE project_id = $1`, [target])).toBe(0);
    expect(await count(`SELECT count(*) FROM environments WHERE project_id = $1`, [target])).toBe(0);
    expect(await count(`SELECT count(*) FROM secrets WHERE project_id = $1`, [target])).toBe(0);
    expect(await count(`SELECT count(*) FROM env_vars WHERE project_id = $1`, [target])).toBe(0);
    expect(await count(`SELECT count(*) FROM agents WHERE environment_id = $1`, [ownOnprem])).toBe(0);
    expect(await count(`SELECT count(*) FROM onprem_agent_jobs`)).toBe(0);
    for (const table of ["source_versions", "analysis_reports", "ir_versions", "build_artifacts", "approvals", "deployment_steps", "env_locks"]) {
      expect(await count(`SELECT count(*) FROM ${table} WHERE deployment_id <> $1`, [otherDeployment]), table).toBe(0);
    }
    expect(await count(`SELECT count(*) FROM health_check_attempts`)).toBe(1);

    // 남은 것 — 공용 연결 · 공용 시크릿 · 공용 Agent · 다른 앱과 그 배포
    expect(await count(`SELECT count(*) FROM environments WHERE project_id IS NULL`)).toBe(2);
    expect(await count(`SELECT count(*) FROM secrets WHERE project_id IS NULL`)).toBe(2);
    expect(await count(`SELECT count(*) FROM agents WHERE environment_id = $1`, [sharedOnprem])).toBe(1);
    expect(await count(`SELECT count(*) FROM projects WHERE id = $1`, [other])).toBe(1);
    expect(await count(`SELECT count(*) FROM deployments WHERE id = $1`, [otherDeployment])).toBe(1);
    // AI 사용량은 비용 집계용으로 남기고 배포 연결만 끊는다 (ON DELETE SET NULL)
    expect(await count(`SELECT count(*) FROM ai_usage WHERE deployment_id IS NULL`)).toBe(4);

    const audit = await pool.query(`SELECT resource_id, status_code, metadata FROM audit_logs WHERE action = 'TEARDOWN project'`);
    expect(audit.rows).toEqual([
      expect.objectContaining({ resource_id: String(target), status_code: 200, metadata: expect.objectContaining({ result: "deleted" }) }),
    ]);
  });

  it("destroy 가 실패하면 아무 row 도 지우지 않고 failed + 이유를 남긴다", async () => {
    const sharedAws = await environment(null, "shared-aws", "aws");
    const target = await project("broken-app");
    await deployment({ projectId: target, targetEnvironmentId: sharedAws, registryEnvironmentId: sharedAws, profile: "aws-ecs-basic" });

    const d = deps({ destroyFailure: new TerraformCliError("TERRAFORM_DESTROY_FAILED", "Error: timeout") });
    await handleTeardown({ data: { project_id: target } }, d.value);

    const row = await pool.query(`SELECT deletion_status, deletion_error FROM projects WHERE id = $1`, [target]);
    expect(row.rows[0]).toEqual({ deletion_status: "failed", deletion_error: "TERRAFORM_DESTROY_FAILED\nError: timeout" });
    expect(await count(`SELECT count(*) FROM deployments WHERE project_id = $1`, [target])).toBe(1);
    expect(d.stateStore.delete).not.toHaveBeenCalled();
  });
});
