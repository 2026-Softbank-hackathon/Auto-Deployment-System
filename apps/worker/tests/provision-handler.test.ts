import { describe, expect, it, vi } from "vitest";
import type { WorkerDeps } from "../src/deps.js";
import { handleProvision } from "../src/handlers/provision.js";
import { TerraformCliError } from "../src/terraform-cli.js";
import { EcsRolloutError } from "../src/ecs-rollout.js";


const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const TASK_DEFINITION_ARN =
  "arn:aws:ecs:ap-northeast-2:123456789012:task-definition/cam-demo:8";
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
  targetOwnerProjectId: string | null;
  previousApply: { status: string; terraform_inputs_hash: string } | null;
  rolloutFailure: Error;
  taskDefinitionArn: string | null;
}> = {}) {
  let status = overrides.status ?? "provisioning";
  let transactionStatus = status;
  const ir = overrides.targetType === "onprem"
    ? { ...IR, deploy: { profile: "onprem-docker-basic" } }
    : IR;
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const order: string[] = [];
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
              target_environment_project_id:
                overrides.targetOwnerProjectId === undefined ? "12" : overrides.targetOwnerProjectId,
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
      if (sql.includes("terraform_inputs_hash IS NOT NULL")) {
        return { rows: overrides.previousApply ? [overrides.previousApply] : [] };
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
    fingerprint: vi.fn(async () => "inputs-hash-current"),
    output: vi.fn(async () => ({
      origin_url: { value: "http://alb.example.test", sensitive: false },
      cluster_name: { value: "cluster-from-output", sensitive: false },
      service_name: { value: "service-from-output", sensitive: false },
      task_definition_arn: {
        value: overrides.taskDefinitionArn === undefined
          ? TASK_DEFINITION_ARN
          : overrides.taskDefinitionArn,
        sensitive: false,
      },
    })),
    apply: overrides.terraformFailure
      ? vi.fn(async () => {
          if (overrides.statusAfterApplyFailure) status = overrides.statusAfterApplyFailure;
          throw overrides.terraformFailure;
        })
      : vi.fn(async () => {
          order.push("apply");
          return {
            origin_url: { value: "http://alb.example.test", sensitive: false },
            cluster_name: { value: "cluster-from-output", sensitive: false },
            service_name: { value: "service-from-output", sensitive: false },
            task_definition_arn: {
              value: overrides.taskDefinitionArn === undefined
                ? TASK_DEFINITION_ARN
                : overrides.taskDefinitionArn,
              sensitive: false,
            },
          };
        }),
  };
  const ecsRolloutWaiter = {
    wait: vi.fn(async (input: { log: (line: string) => Promise<void> }) => {
      order.push(`rollout:${status}`);
      await input.log("헬스체크 통과 (1/1)");
      if (overrides.rolloutFailure) throw overrides.rolloutFailure;
    }),
  };
  const boss = {
    send: vi.fn(async (queue: string, _payload: unknown) => {
      order.push(`send:${queue}`);
      return "verify-job";
    }),
  };
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
    read: vi.fn(async (_projectId: number | null, name: string) =>
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
    ecsRolloutWaiter,
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
    ecsRolloutWaiter,
    order,
    queries,
    agentJobQueries,
    onpremPreparationOrder,
    getStatus: () => status,
  };
}

describe("handleProvision", () => {
  it.each(["aws", "onprem"] as const)("%s 큐의 문자열 배포 ID를 숫자로 정규화한다", async (targetType) => {
    const harness = makeHarness({ targetType });

    await handleProvision({ data: { deployment_id: "99" } }, harness.deps);

    expect(harness.getStatus()).toBe(targetType === "onprem" ? "deploying" : "verifying");
    if (targetType === "onprem") {
      expect(harness.originActivator.prepareOnpremVerification).toHaveBeenCalledWith({
        deploymentId: 99,
        projectId: 12,
      });
      const payload = JSON.parse(String(harness.agentJobQueries[0]?.params[4]));
      expect(payload.deploymentId).toBe(99);
    } else {
      expect(harness.boss.send).toHaveBeenCalledWith("verify", expect.objectContaining({
        deploymentId: 99,
      }));
    }
  });

  it.each(["invalid", "0", "-1", "1.5", "9007199254740992"])("잘못된 큐 배포 ID는 외부 실행 전에 거부한다: %s", async (deploymentId) => {
    const harness = makeHarness({ targetType: "onprem" });
    await expect(handleProvision({ data: { deployment_id: deploymentId } }, harness.deps))
      .rejects.toThrow("DEPLOYMENT_ID_INVALID");
    expect(harness.pool.query).not.toHaveBeenCalled();
    expect(harness.originActivator.prepareOnpremVerification).not.toHaveBeenCalled();
  });

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

  it("공용 AWS 연결이면 공용 시크릿을 읽고 state key · 리소스 이름은 프로젝트별로 둔다 (#215)", async () => {
    const harness = makeHarness({ targetOwnerProjectId: null });

    await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

    const context = harness.queries.find(({ sql }) => sql.includes("SELECT d.status"))!;
    expect(context.sql).toContain("target_environment.project_id AS target_environment_project_id");
    expect(harness.secretReader.read).toHaveBeenCalledWith(null, "AWS_ACCESS_KEY_ID");
    expect(harness.secretReader.read).toHaveBeenCalledWith(null, "AWS_SECRET_ACCESS_KEY");
    expect(harness.terraformCli.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: expect.objectContaining({
          stateKey: "projects/12/environments/34/terraform.tfstate",
        }),
      }),
    );
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

  it("apply 뒤 ECS 롤아웃 완료를 기다린 다음 verifying 으로 넘기고 Verify 를 큐잉한다 (#253)", async () => {
    const harness = makeHarness();

    await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

    expect(harness.ecsRolloutWaiter.wait).toHaveBeenCalledWith(expect.objectContaining({
      region: "ap-northeast-2",
      credentials: { accessKeyId: "access-key-value", secretAccessKey: "secret-key-value" },
      clusterName: "cluster-from-output",
      serviceName: "service-from-output",
      expectedTaskDefinition: TASK_DEFINITION_ARN,
    }));
    // 롤아웃 대기는 deploying 상태에서, Verify 큐잉보다 먼저
    expect(harness.order).toEqual(["apply", "rollout:deploying", "send:verify"]);
    const logLines = harness.notifier.notify.mock.calls
      .filter(([, event]) => event === "log.line")
      .map(([, , payload]) => payload as { step: string; line: string });
    expect(logLines).toContainEqual(expect.objectContaining({
      step: "provision",
      line: expect.stringContaining("헬스체크 통과 (1/1)"),
    }));
    expect(harness.getStatus()).toBe("verifying");
  });

  it("deploying 에서 재시도되면 Terraform 은 건너뛰어도 롤아웃 대기는 다시 한다 (#253)", async () => {
    const harness = makeHarness({ status: "deploying", originUrl: "http://alb.example.test" });

    await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

    expect(harness.terraformCli.apply).not.toHaveBeenCalled();
    expect(harness.terraformCli.output).toHaveBeenCalledTimes(1);
    expect(harness.ecsRolloutWaiter.wait).toHaveBeenCalledWith(expect.objectContaining({
      clusterName: "cluster-from-output",
      serviceName: "service-from-output",
      expectedTaskDefinition: TASK_DEFINITION_ARN,
    }));
    expect(harness.order).toEqual(["rollout:deploying", "send:verify"]);
  });

  it("재시도 state에 task definition ARN이 없으면 이전 배포를 추측하지 않고 실패한다", async () => {
    const harness = makeHarness({
      status: "deploying",
      originUrl: "http://alb.example.test",
      taskDefinitionArn: null,
    });

    await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

    expect(harness.getStatus()).toBe("failed");
    expect(harness.ecsRolloutWaiter.wait).not.toHaveBeenCalled();
    expect(harness.boss.send).not.toHaveBeenCalledWith("verify", expect.anything());
  });

  it("ECS 롤아웃 실패는 코드와 ECS 사유를 남기고 Verify 없이 실패 처리한다 (#253)", async () => {
    const detail = "새 태스크가 중지되었습니다: Essential container in task exited\n컨테이너 api: 종료 코드 1";
    const harness = makeHarness({ rolloutFailure: new EcsRolloutError("ECS_TASK_STOPPED", detail) });

    await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

    expect(harness.getStatus()).toBe("failed");
    const failQuery = harness.queries.find(({ sql }) => sql.includes("SET status = 'failed'"));
    expect(failQuery?.params[0]).toBe(`ECS_TASK_STOPPED\n${detail}`);
    expect(failQuery?.params[2]).toBe("deploying");
    expect(harness.queries.some(({ sql }) => sql.includes("DELETE FROM env_locks"))).toBe(true);
    expect(harness.boss.send).not.toHaveBeenCalledWith("verify", expect.anything());
    expect(harness.boss.send).toHaveBeenCalledWith("diagnose", { deployment_id: 99 });
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

  it("워커 재시작으로 재시도된 provisioning 작업은 Terraform 을 다시 적용하고 verifying 으로 넘어간다", async () => {
    // 이전 시도가 public_url 까지 저장한 뒤 끊긴 경우
    const harness = makeHarness({ status: "provisioning", originUrl: "http://old-alb.example.test" });

    await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

    expect(harness.terraformCli.apply).toHaveBeenCalledTimes(1);
    expect(harness.terraformCli.apply).toHaveBeenCalledWith(
      expect.objectContaining({ log: expect.any(Function) }),
    );
    expect(harness.getStatus()).toBe("verifying");
    expect(harness.boss.send).toHaveBeenCalledWith("verify", expect.objectContaining({
      deploymentId: 99,
      targetUrl: "http://alb.example.test",
    }));
  });

  it("deploying 까지 넘어간 뒤 재시도된 작업은 Terraform 을 건너뛰고 검증을 큐잉한다", async () => {
    const harness = makeHarness({ status: "deploying", originUrl: "http://alb.example.test" });

    await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

    expect(harness.terraformCli.apply).not.toHaveBeenCalled();
    expect(harness.getStatus()).toBe("verifying");
    expect(harness.boss.send).toHaveBeenCalledWith("verify", expect.objectContaining({ deploymentId: 99 }));
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

  function provisionLogLines(harness: ReturnType<typeof makeHarness>): string[] {
    return harness.notifier.notify.mock.calls
      .filter(([, event]) => event === "log.line")
      .map(([, , payload]) => (payload as { line: string }).line);
  }

  describe("이미지만 바뀐 재배포의 상태 재조회 생략 (#252)", () => {
    it("입력 지문은 이미지를 뺀 변수로 만들고, 같은 프로젝트 · 환경의 직전 Terraform 배포를 찾는다", async () => {
      const harness = makeHarness();

      await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

      const [input] = harness.terraformCli.fingerprint.mock.calls[0] as unknown as [{
        moduleDirectory: string; region: string; credentials: { accessKeyId: string }; variables: Record<string, unknown>;
      }];
      expect(input.variables).not.toHaveProperty("container_image");
      expect(input.variables).toMatchObject({ region: "ap-northeast-2", environment_variables: { PUBLIC_MODE: "demo" } });
      expect(input.credentials.accessKeyId).toBe("access-key-value");
      const previous = harness.queries.find(({ sql }) => sql.includes("terraform_inputs_hash IS NOT NULL"))!;
      expect(previous.sql).toMatch(/ORDER BY id DESC\s+LIMIT 1/);
      expect(previous.params).toEqual([12, 34, 99]);
    });

    it("직전 Terraform 배포가 성공했고 입력 지문이 같으면 -refresh=false 로 적용한다", async () => {
      const harness = makeHarness({
        previousApply: { status: "succeeded", terraform_inputs_hash: "inputs-hash-current" },
      });

      await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

      expect(harness.terraformCli.apply).toHaveBeenCalledWith(expect.objectContaining({ refresh: false }));
      expect(provisionLogLines(harness).some((line) => line.includes("이미지만 바뀌어 상태 재조회 생략"))).toBe(true);
      expect(harness.getStatus()).toBe("verifying");
    });

    it.each([
      ["입력이 바뀜", { status: "succeeded", terraform_inputs_hash: "inputs-hash-old" }],
      ["직전 배포가 실패", { status: "failed", terraform_inputs_hash: "inputs-hash-current" }],
      ["첫 Terraform 배포", null],
    ])("%s → 전체 상태 재조회로 적용한다", async (_case, previousApply) => {
      const harness = makeHarness({ previousApply });

      await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

      expect(harness.terraformCli.apply).toHaveBeenCalledWith(expect.objectContaining({ refresh: true }));
      expect(provisionLogLines(harness).some((line) => line.includes("전체 상태 재조회"))).toBe(true);
    });

    it("apply 전에 이번 배포의 입력 지문을 기록해, 실패하면 다음 배포가 전체 재조회하게 한다", async () => {
      const harness = makeHarness({ terraformFailure: new TerraformCliError("TERRAFORM_APPLY_FAILED") });

      await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

      const record = harness.queries.findIndex(({ sql }) => sql.includes("SET terraform_inputs_hash"));
      expect(record).toBeGreaterThan(-1);
      expect(harness.queries[record]!.params).toEqual(["inputs-hash-current", 99]);
      expect(harness.terraformCli.apply).toHaveBeenCalled();
    });
  });

  it("TerraformCliError에 detail이 있으면 DB error 컬럼에 code와 detail을 같이 저장한다", async () => {
    const stderrDetail = "Error: no valid credential sources\nRequestError: access denied to AWS";
    const harness = makeHarness({
      terraformFailure: new TerraformCliError("TERRAFORM_APPLY_FAILED", stderrDetail),
    });

    await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

    expect(harness.getStatus()).toBe("failed");
    const failQuery = harness.queries.find(({ sql }) => sql.includes("SET status = 'failed'"));
    expect(failQuery).toBeDefined();
    const storedError = failQuery?.params[0] as string;
    expect(storedError).toContain("TERRAFORM_APPLY_FAILED");
    expect(storedError).toContain(stderrDetail);
  });

  it("TerraformCliError에 detail이 있으면 stepLog에 detail 줄을 추가로 기록한다", async () => {
    const stderrDetail = "Error: no valid credential sources\nRequestError: access denied to AWS";
    const harness = makeHarness({
      terraformFailure: new TerraformCliError("TERRAFORM_APPLY_FAILED", stderrDetail),
    });

    await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

    const logLineCalls = harness.notifier.notify.mock.calls.filter(
      ([, event]) => event === "log.line",
    );
    const logLines = logLineCalls.map(([, , payload]) => (payload as { line: string }).line);
    expect(logLines.some((line) => line.includes("TERRAFORM_APPLY_FAILED"))).toBe(true);
    expect(logLines.some((line) => line.includes(stderrDetail))).toBe(true);
  });
});
