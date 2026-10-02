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
});
