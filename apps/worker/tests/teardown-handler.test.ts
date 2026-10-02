/**
 * apps/worker/tests/teardown-handler.test.ts
 * 앱 삭제 teardown 잡 (#247) — Terraform destroy · 공개 주소 정리 · DB row 삭제 · 실패 시 failed.
 */

import { describe, expect, it, vi } from "vitest";
import type { WorkerDeps } from "../src/deps.js";
import { handleTeardown } from "../src/handlers/teardown.js";
import { TerraformCliError } from "../src/terraform-cli.js";
import { OriginActivationError } from "../src/origin-activation.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const IR = {
  $ir_version: "0.1.0",
  metadata: { name: "monolith.seohyeon", version: "1.0.0" },
  services: {
    api: {
      type: "http",
      build: { dockerfile: "Dockerfile" },
      port: 3000,
      health: { path: "/health", expected_status: 200, timeout_seconds: 3 },
      expose: "public",
      size: "small",
    },
  },
  deploy: { profile: "aws-ecs-basic" },
};
const AWS_CONFIG = {
  credentialsType: "access_key",
  accessKeyIdSecretName: "AWS_ACCESS_KEY_ID",
  secretAccessKeySecretName: "AWS_SECRET_ACCESS_KEY",
  region: "ap-northeast-2",
};

type EnvRow = {
  environment_id: string;
  environment_project_id: string | null;
  target_profile: string | null;
  aws_config: unknown;
  ir_json: unknown;
  immutable_ref: string | null;
};

function awsEnv(overrides: Partial<EnvRow> = {}): EnvRow {
  return {
    environment_id: "5",
    environment_project_id: null,
    target_profile: "aws-ecs-basic",
    aws_config: AWS_CONFIG,
    ir_json: IR,
    immutable_ref: `123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/camellia/projects/24@${DIGEST}`,
    ...overrides,
  };
}

function harness(options: {
  project?: { deletion_status: string | null; deletion_warnings?: string[] } | null;
  inProgress?: boolean;
  envs?: EnvRow[];
  onpremDeploymentIds?: string[];
  cleanupStatuses?: Record<string, string>;
  deploymentIds?: string[];
  stateExists?: boolean;
  destroyFailure?: Error;
  originFailures?: string[];
  originError?: Error;
  deleteFailure?: Error;
} = {}) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const project = options.project === undefined
    ? { id: "24", name: "monolith-seohyeon", deletion_status: "deleting", deletion_warnings: [] }
    : options.project && { id: "24", name: "monolith-seohyeon", deletion_warnings: [], ...options.project };
  const route = async (sql: string, params: unknown[] = []) => {
    const text = sql.replace(/\s+/g, " ").trim();
    queries.push({ sql: text, params });
    if (text.includes("DELETE FROM deployments") && options.deleteFailure) throw options.deleteFailure;
    if (/FROM projects WHERE id = \$1/.test(text)) return { rows: project ? [project] : [] };
    if (text.includes("NOT (status = ANY")) {
      return { rows: options.inProgress ? [{ id: "7", status: "building" }] : [] };
    }
    if (text.includes("JOIN build_artifacts")) return { rows: options.envs ?? [awsEnv()] };
    if (text.includes("FROM onprem_agent_cleanup_jobs")) {
      return {
        rows: (options.onpremDeploymentIds ?? []).map((id) => ({
          deployment_id: id,
          status: options.cleanupStatuses?.[id] ?? "succeeded",
        })),
      };
    }
    if (text.includes("JOIN onprem_agent_jobs")) {
      return { rows: (options.onpremDeploymentIds ?? []).map((id) => ({ id })) };
    }
    if (text.startsWith("SELECT id FROM deployments WHERE project_id")) {
      return { rows: (options.deploymentIds ?? ["41", "42"]).map((id) => ({ id })) };
    }
    return { rows: [] };
  };
  const client = { query: vi.fn(route), release: vi.fn() };
  const pool = { query: vi.fn(route), connect: vi.fn(async () => client) };
  const destroy = vi.fn(async () => {
    if (options.destroyFailure) throw options.destroyFailure;
  });
  const stateStore = {
    exists: vi.fn(async () => options.stateExists ?? true),
    delete: vi.fn(async () => undefined),
  };
  const removeProjectOrigins = vi.fn(async () => {
    if (options.originError) throw options.originError;
    return options.originFailures ?? [];
  });
  const secretReader = {
    read: vi.fn(async (_owner: number | null, name: string) => `${name}-value`),
  };
  const storage = {
    listKeys: vi.fn(async (prefix: string) => [`${prefix}build.log`]),
    delete: vi.fn(async () => undefined),
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps = {
    pool,
    boss: {},
    storage,
    log,
    secretReader,
    terraformCli: { destroy },
    terraformBackend: {
      bucket: "camellia-terraform-state",
      region: "ap-northeast-2",
      kmsKeyId: "arn:aws:kms:ap-northeast-2:123456789012:key/example",
    },
    terraformModuleRoot: "/repo/infra/terraform/profiles",
    terraformStateStore: stateStore,
    originActivator: { removeProjectOrigins },
  } as unknown as WorkerDeps;
  const sqls = () => queries.map((q) => q.sql);
  const auditLog = () => {
    const insert = queries.find((q) => q.sql.startsWith("INSERT INTO audit_logs"));
    return insert && { statusCode: insert.params[1], metadata: JSON.parse(String(insert.params[3])) };
  };
  return { deps, destroy, stateStore, removeProjectOrigins, secretReader, storage, log, queries, sqls, auditLog };
}

describe("handleTeardown", () => {
  it("AWS 환경마다 같은 state key 로 destroy 하고 state 를 지운 뒤 공개 주소 · DB row 를 정리한다", async () => {
    const h = harness();

    await handleTeardown({ data: { project_id: 24 } }, h.deps);

    expect(h.removeProjectOrigins).toHaveBeenCalledWith({ projectId: 24, onpremDeploymentIds: [] });
    // 공용 연결(project_id NULL)의 시크릿은 공용 범위에서 읽는다
    expect(h.secretReader.read).toHaveBeenCalledWith(null, "AWS_ACCESS_KEY_ID");
    expect(h.secretReader.read).toHaveBeenCalledWith(null, "AWS_SECRET_ACCESS_KEY");
    const stateKey = "projects/24/environments/5/terraform.tfstate";
    expect(h.stateStore.exists).toHaveBeenCalledWith({
      bucket: "camellia-terraform-state",
      region: "ap-northeast-2",
      key: stateKey,
      credentials: { accessKeyId: "AWS_ACCESS_KEY_ID-value", secretAccessKey: "AWS_SECRET_ACCESS_KEY-value" },
    });
    expect(h.destroy).toHaveBeenCalledTimes(1);
    const request = (h.destroy.mock.calls[0] as unknown as [Record<string, unknown>])[0] as {
      moduleDirectory: string;
      backend: Record<string, string>;
      region: string;
      variables: Record<string, unknown>;
    };
    expect(request.moduleDirectory.replaceAll("\\", "/")).toMatch(/\/repo\/infra\/terraform\/profiles\/aws-ecs-basic$/);
    expect(request.backend).toMatchObject({ bucket: "camellia-terraform-state", stateKey });
    expect(request.region).toBe("ap-northeast-2");
    expect(request.variables).toMatchObject({
      app_name: "monolith-seohyeon",
      region: "ap-northeast-2",
      resource_name: expect.stringMatching(/^cam-[0-9a-f]{16}$/),
      container_image: expect.stringContaining(DIGEST),
      container_port: 3000,
      environment_variables: {},
      secret_references: {},
    });
    expect(h.stateStore.delete).toHaveBeenCalledWith(expect.objectContaining({ key: stateKey }));

    const sqls = h.sqls();
    const deleteDeployments = sqls.findIndex((s) => s.startsWith("DELETE FROM deployments WHERE project_id = $1"));
    const deleteProject = sqls.findIndex((s) => s.startsWith("DELETE FROM projects WHERE id = $1"));
    expect(deleteDeployments).toBeGreaterThan(-1);
    expect(deleteProject).toBeGreaterThan(deleteDeployments);
    expect(sqls).toContain("COMMIT");
    // 공용 연결은 지우지 않는다 — environments 를 직접 지우는 쿼리가 없다 (프로젝트 연결은 FK CASCADE)
    expect(sqls.some((s) => s.startsWith("DELETE FROM environments"))).toBe(false);
    expect(sqls.some((s) => s.startsWith("DELETE FROM secrets"))).toBe(false);
    // 배포 로그 파일도 정리
    expect(h.storage.listKeys).toHaveBeenCalledWith("logs/deployments/41/");
    expect(h.storage.delete).toHaveBeenCalledWith("logs/deployments/42/build.log");
    expect(h.auditLog()).toMatchObject({
      statusCode: 200,
      metadata: { result: "deleted", destroyedEnvironments: ["5"], warnings: [] },
    });
  });

  it("PostgreSQL 추가 모듈을 쓴 앱도 같은 state 로 destroy 해 RDS 까지 지운다 (#278)", async () => {
    const irWithDatabase = {
      ...IR,
      resources: { db: { type: "postgres", connection_env: "DATABASE_URL", local_fallback: "sqlite" } },
    };
    const h = harness({ envs: [awsEnv({ ir_json: irWithDatabase })] });

    await handleTeardown({ data: { project_id: 24 } }, h.deps);

    const request = (h.destroy.mock.calls[0] as unknown as [{ variables: Record<string, unknown> }])[0];
    expect(request.variables).toMatchObject({ database_enabled: true, database_env_name: "DATABASE_URL" });
    expect(h.stateStore.delete).toHaveBeenCalled();
  });

  it("프로젝트 소유 연결이면 그 프로젝트 범위의 시크릿을 읽는다", async () => {
    const h = harness({ envs: [awsEnv({ environment_id: "9", environment_project_id: "24" })] });

    await handleTeardown({ data: { project_id: "24" } }, h.deps);

    expect(h.secretReader.read).toHaveBeenCalledWith(24, "AWS_ACCESS_KEY_ID");
  });

  it("state 가 없는 환경은 destroy 하지 않고 넘어간다", async () => {
    const h = harness({ stateExists: false });

    await handleTeardown({ data: { project_id: 24 } }, h.deps);

    expect(h.destroy).not.toHaveBeenCalled();
    expect(h.stateStore.delete).not.toHaveBeenCalled();
    expect(h.sqls().some((s) => s.startsWith("DELETE FROM projects"))).toBe(true);
    expect(h.auditLog()?.metadata).toMatchObject({ destroyedEnvironments: [], skippedEnvironments: ["5"] });
  });

  it("IR 을 읽을 수 없으면 provider region 만 맞춘 기본 변수로 destroy 한다", async () => {
    const h = harness({ envs: [awsEnv({ ir_json: null, immutable_ref: null, target_profile: null })] });

    await handleTeardown({ data: { project_id: 24 } }, h.deps);

    const request = (h.destroy.mock.calls[0] as unknown as [{ variables: Record<string, unknown> }])[0];
    expect(request.variables).toMatchObject({
      region: "ap-northeast-2",
      container_image: expect.stringMatching(/@sha256:0{64}$/),
      task_cpu: 256,
      task_memory: 512,
    });
  });

  it("destroy 가 실패하면 프로젝트를 남기고 failed + 이유를 기록한다 (다시 시도 가능)", async () => {
    const h = harness({
      destroyFailure: new TerraformCliError("TERRAFORM_DESTROY_FAILED", "Error: DependencyViolation"),
    });

    await expect(handleTeardown({ data: { project_id: 24 } }, h.deps)).resolves.toBeUndefined();

    const failed = h.queries.find((q) => q.sql.includes("SET deletion_status = 'failed'"))!;
    expect(failed.params).toEqual([24, "TERRAFORM_DESTROY_FAILED\nError: DependencyViolation"]);
    expect(h.stateStore.delete).not.toHaveBeenCalled();
    expect(h.sqls().some((s) => s.startsWith("DELETE FROM deployments"))).toBe(false);
    expect(h.sqls().some((s) => s.startsWith("DELETE FROM projects"))).toBe(false);
    expect(h.auditLog()).toMatchObject({
      statusCode: 500,
      metadata: { result: "failed", error: "TERRAFORM_DESTROY_FAILED" },
    });
  });

  it("DB 정리에서 실패해도 롤백하고 failed 로 남긴다", async () => {
    const h = harness({ deleteFailure: new Error("violates foreign key constraint") });

    await handleTeardown({ data: { project_id: 24 } }, h.deps);

    expect(h.sqls()).toContain("ROLLBACK");
    const failed = h.queries.find((q) => q.sql.includes("SET deletion_status = 'failed'"))!;
    expect(failed.params[1]).toBe("TEARDOWN_FAILED");
  });

  it("진행 중인 배포가 생겼으면 아무것도 지우지 않고 failed", async () => {
    const h = harness({ inProgress: true });

    await handleTeardown({ data: { project_id: 24 } }, h.deps);

    expect(h.removeProjectOrigins).not.toHaveBeenCalled();
    expect(h.destroy).not.toHaveBeenCalled();
    const failed = h.queries.find((q) => q.sql.includes("SET deletion_status = 'failed'"))!;
    expect(failed.params[1]).toBe("PROJECT_DEPLOYMENT_IN_PROGRESS");
  });

  it("삭제 요청 상태가 아니거나 이미 지워진 프로젝트면 아무것도 하지 않는다", async () => {
    for (const project of [null, { deletion_status: null }, { deletion_status: "failed" }]) {
      const h = harness({ project });

      await handleTeardown({ data: { project_id: 24 } }, h.deps);

      expect(h.destroy).not.toHaveBeenCalled();
      expect(h.removeProjectOrigins).not.toHaveBeenCalled();
      expect(h.sqls().some((s) => s.startsWith("DELETE"))).toBe(false);
      expect(h.sqls().some((s) => s.includes("SET deletion_status = 'failed'"))).toBe(false);
    }
  });

  it("공개 주소 정리 실패 · Cloudflare 미설정은 삭제를 멈추지 않고 기록만 한다", async () => {
    const partial = harness({ originFailures: ["DNS service-24.example.com"] });
    await handleTeardown({ data: { project_id: 24 } }, partial.deps);
    expect(partial.sqls().some((s) => s.startsWith("DELETE FROM projects"))).toBe(true);
    expect(partial.auditLog()?.metadata.cloudflareFailures).toEqual(["DNS service-24.example.com"]);

    const missing = harness({ originError: new OriginActivationError("ORIGIN_CONFIGURATION_MISSING") });
    await handleTeardown({ data: { project_id: 24 } }, missing.deps);
    expect(missing.sqls().some((s) => s.startsWith("DELETE FROM projects"))).toBe(true);
    expect(missing.auditLog()?.metadata.cloudflareFailures).toEqual(["ORIGIN_CONFIGURATION_MISSING"]);
  });

  it("온프레미스에서 돈 앱 — Agent cleanup 성공을 확인한 뒤 검증용 주소와 DB를 정리한다", async () => {
    const h = harness({
      envs: [],
      onpremDeploymentIds: ["42"],
    });

    await handleTeardown({ data: { project_id: 24 } }, h.deps);

    expect(h.removeProjectOrigins).toHaveBeenCalledWith({ projectId: 24, onpremDeploymentIds: [42] });
    expect(h.destroy).not.toHaveBeenCalled();
    expect(h.sqls().some((s) => s.startsWith("DELETE FROM projects"))).toBe(true);
    expect(h.auditLog()?.metadata.warnings).toEqual([]);
    const cleanupCheck = h.queries.find((q) => q.sql.includes("FROM onprem_agent_cleanup_jobs"));
    expect(cleanupCheck?.params).toEqual([[42]]);
  });

  it("Agent cleanup이 끝나지 않으면 프로젝트 row를 지우지 않고 재시도 가능한 failed로 남긴다", async () => {
    const h = harness({
      envs: [],
      onpremDeploymentIds: ["42"],
      cleanupStatuses: { "42": "pending" },
    });
    h.deps.onpremCleanupWait = {
      timeoutMs: 0,
      pollIntervalMs: 1,
      sleep: vi.fn(async () => undefined),
    };

    await handleTeardown({ data: { project_id: 24 } }, h.deps);

    expect(h.removeProjectOrigins).not.toHaveBeenCalled();
    expect(h.sqls().some((s) => s.startsWith("DELETE FROM projects"))).toBe(false);
    const failed = h.queries.find((q) => q.sql.includes("SET deletion_status = 'failed'"))!;
    expect(failed.params[1]).toBe("ONPREM_CLEANUP_TIMEOUT");
  });
});
