import { describe, expect, it, vi } from "vitest";
import type { WorkerDeps } from "../src/deps.js";
import { handleProvision } from "../src/handlers/provision.js";
import { TerraformCliError } from "../src/terraform-cli.js";

const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const IR = {
  $ir_version: "0.1.0",
  metadata: { name: "demo.app", version: "1.0.0" },
  services: {
    api: {
      type: "http",
      build: { dockerfile: "Dockerfile" },
      port: 3000,
      health: { path: "/health", expected_status: 200, timeout_seconds: 3 },
      env: ["PUBLIC_MODE"],
      expose: "public",
      size: "small",
    },
  },
  deploy: { profile: "aws-ecs-basic" },
};

function makeHarness(overrides: Partial<{
  status: string;
  targetType: "aws" | "onprem";
  terraformFailure: Error;
  environmentVariables: Array<{ name: string; value: string }>;
  originUrl: string | null;
  existingAgentJob: boolean;
  existingAgentJobDigest: string;
  repositoryUri: string;
  imagePlatform: string;
  statusAfterApplyFailure: string;
  cleanupFailure: boolean;
  dnsPreparationFailure: Error;
}> = {}) {
  let status = overrides.status ?? "provisioning";
  let transactionStatus = status;
  const ir = overrides.targetType === "onprem"
    ? { ...IR, deploy: { profile: "onprem-docker-basic" } }
    : IR;
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const agentJobQueries: Array<{ sql: string; params: unknown[] }> = [];
  const onpremPreparationOrder: string[] = [];
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql === "BEGIN") transactionStatus = status;
      if (sql === "ROLLBACK") status = transactionStatus;
      if (sql.includes("DELETE FROM env_locks") && overrides.cleanupFailure) {
        throw new Error("cleanup unavailable");
      }
      if (sql.includes("SET status = 'failed'")) {
        if (status !== params[2]) return { rows: [] };
        status = "failed";
        return { rows: [{ id: params[1] }] };
      }
      if (sql.includes("SELECT status FROM deployments")) {
        return { rows: [{ status }] };
      }
      if (sql.includes("UPDATE deployments") && !sql.includes("public_url")) {
        status = params[0] as string;
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes("SELECT d.status")) {
        return {
          rows: [
            {
              status,
              project_id: "12",
              target_profile: overrides.targetType === "onprem" ? "onprem-docker-basic" : "aws-ecs-basic",
              target_environment_id: "34",
              target_environment_type: overrides.targetType ?? "aws",
              aws_config: {
                credentialsType: "access_key",
                accessKeyIdSecretName: "AWS_ACCESS_KEY_ID",
                secretAccessKeySecretName: "AWS_SECRET_ACCESS_KEY",
                region: "ap-northeast-2",
              },
              registry_aws_config: { credentialsType: "access_key", region: "ap-northeast-2" },
              ir_json: ir,
              repository_uri: overrides.repositoryUri ?? "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/camellia/projects/12",
              immutable_ref: `123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/demo@${IMAGE_DIGEST}`,
              image_digest: IMAGE_DIGEST,
              image_platform: overrides.imagePlatform ?? "linux/amd64",
              origin_url: overrides.originUrl ?? null,
            },
          ],
        };
      }
      if (sql.includes("FROM env_vars")) {
        return { rows: overrides.environmentVariables ?? [{ name: "PUBLIC_MODE", value: "demo" }] };
      }
      if (sql.includes("INSERT INTO onprem_agent_jobs")) {
        onpremPreparationOrder.push("agent-job");
        agentJobQueries.push({ sql, params });
        return { rows: overrides.existingAgentJob ? [] : [{ job_id: params[0] }] };
      }
      if (sql.includes("FROM onprem_agent_jobs")) {
        agentJobQueries.push({ sql, params });
        return {
          rows: overrides.existingAgentJob
            ? [{ job_id: "99", status: "pending", payload: { image: { digest: overrides.existingAgentJobDigest ?? IMAGE_DIGEST } } }]
            : [],
        };
      }
      return { rows: [] };
    }),
  };
  const terraformCli = {
    apply: overrides.terraformFailure
      ? vi.fn(async () => {
          if (overrides.statusAfterApplyFailure) status = overrides.statusAfterApplyFailure;
          throw overrides.terraformFailure;
        })
      : vi.fn(async () => ({
          origin_url: { value: "http://alb.example.test", sensitive: false },
        })),
  };
  const boss = { send: vi.fn(async (_queue: string, _payload: unknown) => "verify-job") };
  const notifier = { notify: vi.fn(async () => {}) };
  const originActivator = {
    prepareOnpremVerification: vi.fn(async () => {
      onpremPreparationOrder.push("dns");
      if (overrides.dnsPreparationFailure) {
        throw overrides.dnsPreparationFailure;
      }
    }),
    activate: vi.fn(async () => undefined),
  };
  const secretReader = {
    read: vi.fn(async (_projectId: number, name: string) =>
      name === "AWS_ACCESS_KEY_ID" ? "access-key-value" : "secret-key-value",
    ),
  };
  const deps = {
    pool,
    boss,
    storage: {} as WorkerDeps["storage"],
    notifier,
    originActivator,
    secretReader,
    terraformCli,
    terraformBackend: {
      bucket: "camellia-state",
      region: "ap-northeast-2",
      kmsKeyId: "arn:aws:kms:ap-northeast-2:123456789012:key/state",
    },
    terraformModuleRoot: "/repo/infra/terraform/profiles",
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as WorkerDeps;

  return {
    deps,
    pool,
    boss,
    notifier,
    originActivator,
    secretReader,
    terraformCli,
    queries,
    agentJobQueries,
    onpremPreparationOrder,
    getStatus: () => status,
  };
}

describe("handleProvision", () => {
  it("On-Prem Agent Job을 공개하기 전에 검증용 DNS를 준비한다", async () => {
    const harness = makeHarness({ targetType: "onprem" });

    await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

    expect(harness.originActivator.prepareOnpremVerification).toHaveBeenCalledWith({
      deploymentId: 99,
      projectId: 12,
    });
    expect(harness.onpremPreparationOrder).toEqual(["dns", "agent-job"]);
  });

  it("검증용 DNS 준비 실패 시 Agent Job을 노출하지 않고 락을 해제한다", async () => {
    const harness = makeHarness({
      targetType: "onprem",
      dnsPreparationFailure: new Error("provider unavailable"),
    });

    await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

    expect(harness.agentJobQueries).toHaveLength(0);
    expect(harness.getStatus()).toBe("failed");
    expect(harness.queries).toContainEqual({
      sql: "DELETE FROM env_locks WHERE deployment_id = $1",
      params: [99],
    });
  });

  it.each(["aws", "onprem"] as const)("%s planning 오류는 failed와 락 해제를 같은 트랜잭션으로 처리한다", async (targetType) => {
    const harness = makeHarness({ status: "planning", targetType });
    await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

    expect(harness.getStatus()).toBe("failed");
    const operations = harness.queries.map(({ sql }) => sql);
    const update = operations.findIndex((sql) => sql.includes("SET status = 'failed'"));
    const unlock = operations.findIndex((sql) => sql.includes("DELETE FROM env_locks"));
    expect(operations[update - 1]).toBe("BEGIN");
    expect(unlock).toBe(update + 1);
    expect(operations[unlock + 1]).toBe("COMMIT");
    expect(harness.notifier.notify).toHaveBeenCalledWith(99, "state_changed", { status: "failed" });
    expect(harness.boss.send).toHaveBeenCalledWith("diagnose", { deployment_id: 99 });
    expect(harness.terraformCli.apply).not.toHaveBeenCalled();
    expect(harness.agentJobQueries).toHaveLength(0);

    await handleProvision({ data: { deployment_id: 99 } }, harness.deps);
    expect(harness.notifier.notify.mock.calls.filter(([, event]) => event === "state_changed")).toHaveLength(1);
  });

  it.each(["succeeded", "failed", "cancelled", "rejected"])("종료 상태 %s의 뒤늦은 Job은 상태와 락을 변경하지 않는다", async (status) => {
    const harness = makeHarness({ status });
    await handleProvision({ data: { deployment_id: 99 } }, harness.deps);
    expect(harness.getStatus()).toBe(status);
    expect(harness.pool.connect).not.toHaveBeenCalled();
    expect(harness.terraformCli.apply).not.toHaveBeenCalled();
    expect(harness.boss.send).not.toHaveBeenCalled();
    expect(harness.notifier.notify).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "verifying"])("실패 처리 전 상태가 %s로 변경되면 덮어쓰거나 락을 풀지 않는다", async (statusAfterApplyFailure) => {
    const harness = makeHarness({
      terraformFailure: new TerraformCliError("TERRAFORM_APPLY_FAILED"), statusAfterApplyFailure,
    });
    await expect(handleProvision({ data: { deployment_id: 99 } }, harness.deps)).rejects.toThrow("TERRAFORM_APPLY_FAILED");
    expect(harness.getStatus()).toBe(statusAfterApplyFailure);
    expect(harness.queries.some(({ sql }) => sql.includes("DELETE FROM env_locks"))).toBe(false);
    expect(harness.notifier.notify).not.toHaveBeenCalledWith(99, "state_changed", { status: "failed" });
    expect(harness.boss.send).not.toHaveBeenCalledWith("diagnose", expect.anything());
  });

  it("락 정리 DB 오류는 상태도 롤백하고 실패 SSE를 발행하지 않는다", async () => {
    const harness = makeHarness({ status: "planning", cleanupFailure: true });
    await expect(handleProvision({ data: { deployment_id: 99 } }, harness.deps)).rejects.toThrow("cleanup unavailable");
    expect(harness.getStatus()).toBe("planning");
    expect(harness.queries.some(({ sql }) => sql === "ROLLBACK")).toBe(true);
    expect(harness.notifier.notify).not.toHaveBeenCalledWith(99, "state_changed", { status: "failed" });
    expect(harness.boss.send).not.toHaveBeenCalledWith("diagnose", expect.anything());
  });

  it("사용자 계정 credential로 digest를 적용하고 Verify payload를 큐잉한다", async () => {
    const harness = makeHarness();

    await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

    expect(harness.secretReader.read).toHaveBeenCalledWith(12, "AWS_ACCESS_KEY_ID");
    expect(harness.secretReader.read).toHaveBeenCalledWith(12, "AWS_SECRET_ACCESS_KEY");
    expect(harness.terraformCli.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: expect.objectContaining({
          stateKey: "projects/12/environments/34/terraform.tfstate",
        }),
        credentials: {
          accessKeyId: "access-key-value",
          secretAccessKey: "secret-key-value",
        },
        variables: expect.objectContaining({
          container_image: expect.stringContaining(`@${IMAGE_DIGEST}`),
          region: "ap-northeast-2",
          environment_variables: { PUBLIC_MODE: "demo" },
          secret_references: {},
        }),
      }),
    );
    expect(harness.queries.some((query) => query.sql.includes("SET public_url"))).toBe(true);
    expect(harness.boss.send).toHaveBeenCalledWith("verify", {
      jobId: "verify-deployment-99",
      attempt: 1,
      deploymentId: 99,
      environmentId: "34",
      environmentType: "aws",
      serviceId: "api",
      targetUrl: "http://alb.example.test",
      health: { path: "/health", expectedStatus: 200, timeoutMs: 3000 },
      expectedDigest: IMAGE_DIGEST,
    });
    expect(harness.getStatus()).toBe("verifying");
    expect(harness.queries.some((query) => query.sql.includes("DELETE FROM env_locks"))).toBe(false);
  });

  it("Terraform apply 실패를 상태 코드로 정규화하고 환경 락을 해제한다", async () => {
    const harness = makeHarness({
      terraformFailure: new TerraformCliError("TERRAFORM_APPLY_FAILED"),
    });

    await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

    expect(harness.getStatus()).toBe("failed");
    expect(harness.queries).toContainEqual({
      sql: "DELETE FROM env_locks WHERE deployment_id = $1",
      params: [99],
    });
    expect(harness.boss.send).not.toHaveBeenCalledWith(
      "verify",
      expect.anything(),
    );
    expect(harness.notifier.notify).toHaveBeenCalledWith(99, "state_changed", {
      status: "failed",
    });
  });

  it("자신이 verifying으로 전이한 뒤 Verify 큐잉이 실패해도 failed와 락 해제를 처리한다", async () => {
    const harness = makeHarness();
    harness.boss.send.mockImplementation(async (queue) => {
      if (queue === "verify") throw new Error("queue unavailable");
      return "diagnose-job";
    });
    await handleProvision({ data: { deployment_id: 99 } }, harness.deps);
    expect(harness.getStatus()).toBe("failed");
    expect(harness.queries.some(({ sql }) => sql.includes("DELETE FROM env_locks"))).toBe(true);
    expect(harness.notifier.notify).toHaveBeenCalledWith(99, "state_changed", { status: "failed" });
  });

  it("이미 verifying 상태인 중복 작업은 Terraform을 다시 실행하지 않는다", async () => {
    const harness = makeHarness({ status: "verifying" });

    await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

    expect(harness.terraformCli.apply).not.toHaveBeenCalled();
    expect(harness.boss.send).not.toHaveBeenCalled();
  });

  it("필수 env var 값이 누락되면 실패하고 Apply를 시작하지 않는다", async () => {
    const harness = makeHarness({ environmentVariables: [] });

    await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

    expect(harness.terraformCli.apply).not.toHaveBeenCalled();
    expect(harness.getStatus()).toBe("failed");
  });

  it("On-Prem 대상은 digest 기반 Agent Job을 저장하고 deploying으로 전이한다", async () => {
    const harness = makeHarness({ targetType: "onprem" });

    await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

    const insert = harness.agentJobQueries.find(({ sql }) => sql.includes("INSERT INTO onprem_agent_jobs"));
    expect(insert).toBeDefined();
    expect(insert?.params[0]).toBe("99");
    expect(JSON.parse(String(insert?.params[4]))).toMatchObject({
      jobId: "99",
      attempt: 1,
      deploymentId: 99,
      environmentId: "34",
      plan: { target: "onprem", profile: { id: "onprem-docker-basic" } },
      image: {
        repositoryUri: "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/camellia/projects/12",
        digest: IMAGE_DIGEST,
        platform: "linux/amd64",
        registryType: "ecr",
        region: "ap-northeast-2",
      },
      environment: { PUBLIC_MODE: "demo" },
    });
    expect(harness.terraformCli.apply).not.toHaveBeenCalled();
    expect(harness.getStatus()).toBe("deploying");
    expect(harness.boss.send).not.toHaveBeenCalledWith("verify", expect.anything());
  });

  it("동일 On-Prem Provision 재전달은 기존 Agent Job을 재사용한다", async () => {
    const harness = makeHarness({ targetType: "onprem", status: "deploying", existingAgentJob: true });

    await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

    expect(harness.agentJobQueries).toHaveLength(2);
    expect(harness.agentJobQueries[1]?.sql).toContain("SELECT job_id, status, payload");
    expect(harness.terraformCli.apply).not.toHaveBeenCalled();
    expect(harness.getStatus()).toBe("deploying");
  });

  it("잘못된 ECR URI는 Agent Job을 만들지 않고 실패 처리한다", async () => {
    const harness = makeHarness({
      targetType: "onprem",
      repositoryUri: "not-an-ecr-repository",
    });

    await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

    expect(harness.agentJobQueries).toHaveLength(0);
    expect(harness.getStatus()).toBe("failed");
    expect(harness.queries.some(({ sql }) => sql.includes("DELETE FROM env_locks"))).toBe(true);
  });

  it("기존 Agent Job과 image digest가 다르면 재사용하지 않는다", async () => {
    const harness = makeHarness({
      targetType: "onprem",
      status: "deploying",
      existingAgentJob: true,
      existingAgentJobDigest: `sha256:${"b".repeat(64)}`,
    });

    await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

    expect(harness.getStatus()).toBe("failed");
    expect(harness.queries.some(({ sql }) => sql.includes("DELETE FROM env_locks"))).toBe(true);
  });
});
