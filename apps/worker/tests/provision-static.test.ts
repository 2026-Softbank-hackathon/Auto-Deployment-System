import { describe, expect, it, vi } from "vitest";
import type { WorkerDeps } from "../src/deps.js";
import { handleProvision, staticSiteBucketName } from "../src/handlers/provision.js";
import { StaticSitePublishError } from "../src/static-site-publisher.js";

const IMAGE_DIGEST = `sha256:${"d".repeat(64)}`;
const IMMUTABLE_REF = `123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/camellia/projects/12@${IMAGE_DIGEST}`;
const WEBSITE = "service-12.camellia.example.com.s3-website.ap-northeast-2.amazonaws.com";
const STATIC_IR = {
  metadata: { name: "landing", version: "2.0.0" },
  services: {
    site: { type: "static", port: 8080, health: { path: "/" }, static: { output_dir: "." } },
  },
  deploy: { profile: "aws-static-basic" },
};

function makeHarness(overrides: Partial<{
  status: string;
  originUrl: string | null;
  egressIp: string | null;
  publishFailure: Error;
  platformDomain: string | undefined;
  databaseBefore: boolean;
  /** 같은 프로젝트 · 환경에서 직전에 Terraform 입력 지문을 남긴 배포 */
  previous: {
    id: number;
    status: string;
    terraform_inputs_hash: string;
    target_profile: string | null;
    terraform_outputs: unknown;
  } | null;
}> = {}) {
  let status = overrides.status ?? "provisioning";
  const order: string[] = [];
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("SELECT status FROM deployments")) return { rows: [{ status }] };
      if (sql.includes("SET status = 'failed'")) {
        status = "failed";
        return { rows: [{ id: params[1] }] };
      }
      if (sql.includes("UPDATE deployments") && typeof params[0] === "string") {
        status = params[0];
        order.push(`status:${status}`);
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes("jsonb_each")) {
        return { rows: overrides.databaseBefore ? [{ id: 7 }] : [] };
      }
      if (sql.includes("terraform_inputs_hash IS NOT NULL")) {
        return { rows: overrides.previous ? [overrides.previous] : [] };
      }
      if (sql.includes("SELECT d.status")) {
        return {
          rows: [{
            status,
            project_id: "12",
            target_profile: "aws-static-basic",
            target_environment_id: "34",
            target_environment_type: "aws",
            target_environment_project_id: "12",
            aws_config: {
              credentialsType: "access_key",
              accessKeyIdSecretName: "AWS_ACCESS_KEY_ID",
              secretAccessKeySecretName: "AWS_SECRET_ACCESS_KEY",
              region: "ap-northeast-2",
            },
            ir_json: STATIC_IR,
            repository_uri: "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/camellia/projects/12",
            immutable_ref: IMMUTABLE_REF,
            image_digest: IMAGE_DIGEST,
            image_platform: "linux/amd64",
            origin_url: overrides.originUrl ?? null,
          }],
        };
      }
      return { rows: [] };
    }),
  };
  const outputs = {
    origin_url: { value: `http://${WEBSITE}` },
    origin_hostname: { value: WEBSITE },
    bucket_name: { value: "service-12.camellia.example.com" },
  };
  const terraformCli = {
    fingerprint: vi.fn(async () => "hash"),
    apply: vi.fn(async () => {
      order.push("apply");
      return outputs;
    }),
    output: vi.fn(async () => {
      order.push("output");
      return outputs;
    }),
  };
  const registry = { getAuthorization: vi.fn(async () => ({ registryUri: "x", username: "AWS", password: "p", expiresAt: "" })) };
  const awsRegistryFactory = vi.fn(() => registry);
  const registrySession = {
    withAuthorization: vi.fn(async (_auth: unknown, task: (env: NodeJS.ProcessEnv) => Promise<unknown>) =>
      task({ DOCKER_CONFIG: "/tmp/docker" }),
    ),
  };
  const staticSitePublisher = {
    publish: vi.fn(async () => {
      order.push("publish");
      if (overrides.publishFailure) throw overrides.publishFailure;
      return { uploaded: 3, unchanged: 0, deleted: 0 };
    }),
  };
  const boss = {
    send: vi.fn(async (queue: string) => {
      order.push(`send:${queue}`);
      return "job";
    }),
  };
  const deps = {
    pool,
    boss,
    storage: {} as WorkerDeps["storage"],
    notifier: { notify: vi.fn(async () => {}) },
    secretReader: { read: vi.fn(async (_p: number | null, name: string) => (name === "AWS_ACCESS_KEY_ID" ? "AKIA" : "SECRET")) },
    terraformCli,
    terraformBackend: { bucket: "state", region: "ap-northeast-2", kmsKeyId: "kms" },
    terraformModuleRoot: "/repo/infra/terraform/profiles",
    ecsRolloutWaiter: { wait: vi.fn() },
    awsRegistryFactory,
    registrySession,
    staticSitePublisher,
    egressIpResolver: vi.fn(async () => (overrides.egressIp === undefined ? "203.0.113.9" : overrides.egressIp)),
    platformDomain: "platformDomain" in overrides ? overrides.platformDomain : "Camellia.Example.com.",
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as WorkerDeps;
  return { deps, order, queries, terraformCli, staticSitePublisher, boss, awsRegistryFactory, getStatus: () => status };
}

function provisionLogLines(harness: ReturnType<typeof makeHarness>): string[] {
  const notify = (harness.deps.notifier as unknown as { notify: ReturnType<typeof vi.fn> }).notify;
  return notify.mock.calls
    .filter(([, event]) => event === "log.line")
    .map(([, , payload]) => String((payload as { line: string }).line));
}

const STORED_OUTPUTS = {
  origin_url: { value: `http://${WEBSITE}` },
  origin_hostname: { value: WEBSITE },
  bucket_name: { value: "service-12.camellia.example.com" },
};

describe("정적 사이트 provision (#274)", () => {
  it("버킷 Terraform → 이미지에서 파일 동기화 → S3 웹사이트 endpoint 검증 순서", async () => {
    const harness = makeHarness();

    await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

    expect(harness.order).toEqual(["apply", "status:deploying", "publish", "status:verifying", "send:verify"]);
    const applyRequest = harness.terraformCli.apply.mock.calls[0]![0] as {
      moduleDirectory: string;
      variables: Record<string, unknown>;
    };
    expect(applyRequest.moduleDirectory.replace(/\\/g, "/")).toMatch(/profiles\/aws-static-basic$/);
    expect(applyRequest.variables).toEqual({
      app_name: "landing",
      region: "ap-northeast-2",
      spa_fallback: true,
      bucket_name: "service-12.camellia.example.com",
      verifier_cidrs: ["203.0.113.9/32"],
    });
    expect(harness.awsRegistryFactory).toHaveBeenCalledWith({
      region: "ap-northeast-2",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "SECRET" },
    });
    expect(harness.staticSitePublisher.publish).toHaveBeenCalledWith(expect.objectContaining({
      imageRef: IMMUTABLE_REF,
      platform: "linux/amd64",
      commandEnvironment: { DOCKER_CONFIG: "/tmp/docker" },
      bucket: "service-12.camellia.example.com",
      region: "ap-northeast-2",
    }));
    const publicUrl = harness.queries.find((q) => q.sql.includes("SET public_url"));
    expect(publicUrl?.params[0]).toBe(`http://${WEBSITE}`);
    expect(harness.boss.send).toHaveBeenCalledWith("verify", expect.objectContaining({
      environmentType: "aws",
      targetUrl: `http://${WEBSITE}`,
      health: { path: "/", expectedStatus: 200, timeoutMs: 3000 },
      expectedDigest: IMAGE_DIGEST,
    }));
  });

  it("재시도(이미 deploying + origin 저장)는 apply 없이 output 으로 이어서 다시 동기화한다", async () => {
    const harness = makeHarness({ status: "deploying", originUrl: `http://${WEBSITE}` });

    await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

    expect(harness.order).toEqual(["output", "publish", "status:verifying", "send:verify"]);
  });

  it("워커 IP 를 모르면 Cloudflare 범위만 열고 계속한다", async () => {
    const harness = makeHarness({ egressIp: null });

    await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

    const applyRequest = harness.terraformCli.apply.mock.calls[0]![0] as { variables: Record<string, unknown> };
    expect(applyRequest.variables["verifier_cidrs"]).toEqual([]);
    expect(harness.getStatus()).toBe("verifying");
  });

  it("동기화 실패는 배포 실패로 남긴다", async () => {
    const harness = makeHarness({ publishFailure: new StaticSitePublishError("STATIC_SITE_INDEX_MISSING") });

    await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

    expect(harness.getStatus()).toBe("failed");
    expect(harness.boss.send).not.toHaveBeenCalledWith("verify", expect.anything());
  });

  it("플랫폼 도메인이 없으면 버킷 이름을 정할 수 없어 실패한다", async () => {
    const harness = makeHarness({ platformDomain: undefined });

    await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

    expect(harness.getStatus()).toBe("failed");
    expect(harness.terraformCli.apply).not.toHaveBeenCalled();
  });

  it("이 환경에 PostgreSQL(RDS)을 만든 적이 있으면 정적 사이트 모듈로 바꾸지 않는다 (DB 보존)", async () => {
    const harness = makeHarness({ databaseBefore: true });

    await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

    expect(harness.getStatus()).toBe("failed");
    expect(harness.terraformCli.apply).not.toHaveBeenCalled();
    const failed = harness.queries.find((q) => q.sql.includes("SET status = 'failed'"));
    expect(failed === undefined || String(failed.params[0]).startsWith("STATIC_SITE_ENVIRONMENT_HAS_DATABASE")).toBe(true);
  });

  it("버킷 이름 = 공개 호스트 이름", () => {
    expect(staticSiteBucketName(7, "Demo.Example.com.")).toBe("service-7.demo.example.com");
  });

  describe("인프라 변경 없는 갱신의 Terraform 생략 (#299)", () => {
    const succeededSameInputs = {
      id: 81,
      status: "succeeded",
      terraform_inputs_hash: "hash",
      target_profile: "aws-static-basic",
      terraform_outputs: STORED_OUTPUTS,
    };

    it("직전 성공 배포와 입력 지문이 같고 출력값이 남아 있으면 Terraform 없이 그 출력값으로 동기화한다", async () => {
      const harness = makeHarness({ previous: succeededSameInputs });

      await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

      expect(harness.terraformCli.apply).not.toHaveBeenCalled();
      expect(harness.terraformCli.output).not.toHaveBeenCalled();
      expect(harness.order).toEqual(["status:deploying", "publish", "status:verifying", "send:verify"]);
      expect(provisionLogLines(harness)).toContainEqual(
        expect.stringContaining("인프라 변경 없음 — Terraform 생략 (직전 성공 배포 #81 출력값 재사용)"),
      );
      expect(harness.staticSitePublisher.publish).toHaveBeenCalledWith(expect.objectContaining({
        bucket: "service-12.camellia.example.com",
      }));
      // 이번 배포에도 지문과 출력값을 남겨 다음 갱신이 이어서 생략할 수 있게 한다
      const hash = harness.queries.find((q) => q.sql.includes("SET terraform_inputs_hash"));
      expect(hash?.params).toEqual(["hash", 99]);
      const saved = harness.queries.find((q) => q.sql.includes("SET public_url"));
      expect(saved?.params[0]).toBe(`http://${WEBSITE}`);
      expect(JSON.parse(String(saved?.params[1]))).toEqual(STORED_OUTPUTS);
      expect(harness.boss.send).toHaveBeenCalledWith("verify", expect.objectContaining({
        targetUrl: `http://${WEBSITE}`,
      }));
    });

    it.each([
      ["입력이 바뀜", { ...succeededSameInputs, terraform_inputs_hash: "hash-old" }, true],
      ["직전 배포가 실패", { ...succeededSameInputs, status: "failed" }, true],
      ["다른 프로필로 배포함", { ...succeededSameInputs, target_profile: "aws-ecs-basic" }, false],
      ["저장된 출력값이 없음", { ...succeededSameInputs, terraform_outputs: null }, false],
      ["첫 배포", null, true],
    ])("%s → Terraform 을 실행하고 출력값을 남긴다", async (_case, previous, refresh) => {
      const harness = makeHarness({ previous });

      await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

      expect(harness.terraformCli.apply).toHaveBeenCalledOnce();
      expect(harness.terraformCli.apply).toHaveBeenCalledWith(expect.objectContaining({ refresh }));
      expect(provisionLogLines(harness).some((line) => line.includes("Terraform 생략"))).toBe(false);
      const saved = harness.queries.find((q) => q.sql.includes("SET public_url"));
      expect(JSON.parse(String(saved?.params[1]))).toEqual(STORED_OUTPUTS);
      expect(harness.getStatus()).toBe("verifying");
    });

    it("sensitive 출력값은 저장하지 않는다", async () => {
      const harness = makeHarness();
      harness.terraformCli.apply.mockResolvedValueOnce({
        ...STORED_OUTPUTS,
        token: { value: "secret", sensitive: true },
      } as never);

      await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

      const saved = harness.queries.find((q) => q.sql.includes("SET public_url"));
      expect(JSON.parse(String(saved?.params[1]))).toEqual(STORED_OUTPUTS);
    });

    it("입력 지문에서 배포마다 바뀌는 앱 이름을 뺀다 (분석기가 이름을 못 찾으면 업로드 폴더 이름이 된다)", async () => {
      const harness = makeHarness();

      await handleProvision({ data: { deployment_id: 99 } }, harness.deps);

      const [input] = harness.terraformCli.fingerprint.mock.calls[0] as unknown as [{ variables: Record<string, unknown> }];
      expect(input.variables).not.toHaveProperty("app_name");
      expect(input.variables).toMatchObject({
        bucket_name: "service-12.camellia.example.com",
        verifier_cidrs: ["203.0.113.9/32"],
      });
    });
  });
});
