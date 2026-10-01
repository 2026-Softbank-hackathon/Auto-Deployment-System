import { describe, expect, it, vi, beforeEach } from "vitest";
import { stage } from "@camellia/analyzer/stager";
import type { WorkerDeps } from "../src/deps.js";
import { handleBuild } from "../src/handlers/build.js";

vi.mock("@camellia/analyzer/stager", () => ({ stage: vi.fn() }));

const DIGEST = `sha256:${"a".repeat(64)}` as `sha256:${string}`;
const IR = {
  $ir_version: "0.1.0",
  metadata: { name: "demo-app", version: "1.0.0" },
  services: {
    api: {
      type: "http",
      build: { dockerfile: "Dockerfile", context: "." },
      port: 3000,
      health: {
        path: "/health",
        expected_status: 200,
        timeout_seconds: 3,
      },
      expose: "public",
      size: "small",
    },
  },
  deploy: { profile: "aws-ecs-basic" },
};

function makeHarness(overrides: Partial<{
  status: string;
  existingArtifactId: number | null;
  credentialsType: "access_key" | "assume_role";
  buildFailure: Error;
}> = {}) {
  let currentStatus = overrides.status ?? "queued";
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("SELECT status FROM deployments")) {
        return { rows: [{ status: currentStatus }] };
      }
      if (sql.includes("UPDATE deployments")) {
        currentStatus = params[0] as string;
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
        const credentialsType = overrides.credentialsType ?? "access_key";
        return {
          rows: [
            {
              status: currentStatus,
              project_id: "1",
              target_profile: "aws-ecs-basic",
              source_storage_key: "sources/demo.zip",
              ir_json: IR,
              registry_environment_type: "aws",
              aws_config:
                credentialsType === "access_key"
                  ? {
                      credentialsType,
                      accessKeyIdSecretName: "aws-access",
                      secretAccessKeySecretName: "aws-secret",
                      region: "ap-northeast-2",
                    }
                  : {
                      credentialsType,
                      roleArn: "arn:aws:iam::1:role/demo",
                      externalId: "external",
                      region: "ap-northeast-2",
                    },
              existing_artifact_id: overrides.existingArtifactId ?? null,
            },
          ],
        };
      }
      return { rows: [] };
    }),
  };
  const files = new Map<string, Buffer>();
  const storage = {
    get: vi.fn(async (key: string) =>
      key === "sources/demo.zip" ? Buffer.from("zip") : files.get(key)!,
    ),
    exists: vi.fn(async (key: string) => files.has(key)),
    put: vi.fn(async (key: string, value: Buffer) => {
      files.set(key, value);
    }),
    delete: vi.fn(),
    presignUrl: vi.fn(),
    listKeys: vi.fn(),
  };
  const boss = { send: vi.fn(async () => "job-id") };
  const notifier = { notify: vi.fn(async () => {}) };
  const secretReader = {
    read: vi.fn(async (_projectId: number, name: string) =>
      name === "aws-access" ? "access-value" : "secret-value",
    ),
  };
  const registry = {
    ensureProjectRepository: vi.fn(async () => ({
      name: "camellia/projects/1",
      repositoryUri:
        "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/camellia/projects/1",
      registryUri: "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com",
    })),
    getAuthorization: vi.fn(async () => ({
      registryUri: "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com",
      username: "AWS" as const,
      password: "temporary-password",
      expiresAt: "2026-10-01T12:00:00.000Z",
    })),
  };
  const awsRegistryFactory = vi.fn(() => registry);
  const registrySession = {
    withAuthorization: vi.fn(async (_authorization, task) =>
      task({ ...process.env, DOCKER_CONFIG: "/tmp/docker-config" }),
    ),
  };
  const buildHandler = {
    build: overrides.buildFailure
      ? vi.fn(async () => Promise.reject(overrides.buildFailure))
      : vi.fn(async (request) => ({
          strategy: "dockerfile" as const,
          platform: "linux/amd64" as const,
          image: {
            repository: request.image.repository,
            tag: request.image.tag,
            digest: DIGEST,
            taggedRef: `${request.image.repository}:${request.image.tag}`,
            immutableRef: `${request.image.repository}@${DIGEST}`,
          },
        })),
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const deps = {
    pool,
    boss,
    storage,
    notifier,
    secretReader,
    awsRegistryFactory,
    registrySession,
    buildHandler,
    log,
  } as unknown as WorkerDeps;

  return {
    deps,
    pool,
    boss,
    notifier,
    secretReader,
    registry,
    awsRegistryFactory,
    registrySession,
    buildHandler,
    log,
    queries,
    getStatus: () => currentStatus,
  };
}

describe("handleBuild", () => {
  beforeEach(() => {
    vi.mocked(stage).mockResolvedValue({
      resolvedPath: "/tmp/staged-demo",
      isDirectory: true,
      cleanup: vi.fn(async () => {}),
    });
  });

  it("Secret reference로 ECR에 build하고 digest를 저장한다", async () => {
    const harness = makeHarness();

    await handleBuild({ data: { deployment_id: 42 } }, harness.deps);

    expect(harness.secretReader.read).toHaveBeenCalledWith(1, "aws-access");
    expect(harness.secretReader.read).toHaveBeenCalledWith(1, "aws-secret");
    expect(harness.awsRegistryFactory).toHaveBeenCalledWith({
      region: "ap-northeast-2",
      credentials: {
        accessKeyId: "access-value",
        secretAccessKey: "secret-value",
      },
    });
    expect(harness.buildHandler.build).toHaveBeenCalledWith(
      expect.objectContaining({
        image: expect.objectContaining({ tag: "v1.0.0-d42" }),
        commandEnvironment: expect.objectContaining({
          DOCKER_CONFIG: "/tmp/docker-config",
        }),
      }),
    );
    const artifact = harness.queries.find((query) =>
      query.sql.includes("INSERT INTO build_artifacts"),
    );
    expect(artifact?.params[3]).toBe(DIGEST);
    expect(harness.getStatus()).toBe("planning");
    expect(harness.boss.send).toHaveBeenCalledWith("provision", {
      deployment_id: 42,
    });
  });

  it("이미 저장된 artifact가 있으면 다시 build하지 않고 다음 단계로 간다", async () => {
    const harness = makeHarness({ existingArtifactId: 7 });

    await handleBuild({ data: { deployment_id: 42 } }, harness.deps);

    expect(harness.buildHandler.build).not.toHaveBeenCalled();
    expect(harness.secretReader.read).not.toHaveBeenCalled();
    expect(harness.getStatus()).toBe("planning");
    expect(harness.boss.send).toHaveBeenCalledWith("provision", {
      deployment_id: 42,
    });
  });

  it("build 실패 시 민감값 없이 failed 처리하고 lock을 해제한다", async () => {
    const secret = "SHOULD_NOT_LEAK";
    const harness = makeHarness({ buildFailure: new Error(secret) });

    await handleBuild({ data: { deployment_id: 42 } }, harness.deps);

    expect(harness.getStatus()).toBe("failed");
    expect(harness.queries.some((query) => query.sql.includes("DELETE FROM env_locks"))).toBe(true);
    expect(JSON.stringify(harness.log.error.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(harness.notifier.notify.mock.calls)).not.toContain(secret);
  });

  it("P0에서 assume-role registry 환경을 명시적으로 거부한다", async () => {
    const harness = makeHarness({ credentialsType: "assume_role" });

    await handleBuild({ data: { deployment_id: 42 } }, harness.deps);

    expect(harness.getStatus()).toBe("failed");
    expect(harness.secretReader.read).not.toHaveBeenCalled();
    expect(harness.log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        error_code: "AWS_REGISTRY_CREDENTIALS_INVALID",
      }),
      "build job failed",
    );
  });

  it("planning까지 저장된 재시도는 provision job만 복구한다", async () => {
    const harness = makeHarness({ status: "planning", existingArtifactId: 7 });

    await handleBuild({ data: { deployment_id: 42 } }, harness.deps);

    expect(harness.buildHandler.build).not.toHaveBeenCalled();
    expect(harness.boss.send).toHaveBeenCalledWith("provision", {
      deployment_id: 42,
    });
    expect(harness.getStatus()).toBe("planning");
  });
});
