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
  autoApproveFailure: Error;
  reusableDigest: string;
  registryOwnerProjectId: string | null;
  irJson: unknown;
}> = {}) {
  let currentStatus = overrides.status ?? "queued";
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const clientQueries: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      clientQueries.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }
      if (sql.includes("SELECT status FROM deployments")) {
        return { rows: [{ status: currentStatus }] };
      }
      if (sql.includes("INSERT INTO approvals")) {
        if (overrides.autoApproveFailure) throw overrides.autoApproveFailure;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE deployments")) {
        // transitionTo 는 params[0] 로 status 전달, autoApprovePlanInline 은 리터럴로 박음.
        const literalMatch = sql.match(/status\s*=\s*'([^']+)'/);
        if (literalMatch) {
          currentStatus = literalMatch[1]!;
        } else if (typeof params[0] === "string") {
          currentStatus = params[0];
        }
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes("INSERT INTO build_artifacts") && sql.includes("SELECT")) {
        return {
          rows: overrides.reusableDigest
            ? [{ image_digest: overrides.reusableDigest }]
            : [],
        };
      }
      if (sql.includes("SELECT d.status")) {
        const credentialsType = overrides.credentialsType ?? "access_key";
        return {
          rows: [
            {
              status: currentStatus,
              project_id: "1",
              target_profile: "aws-ecs-basic",
              source_storage_key: "sources/demo.zip",
              ir_json: overrides.irJson ?? IR,
              registry_environment_type: "aws",
              registry_environment_project_id:
                overrides.registryOwnerProjectId === undefined ? "1" : overrides.registryOwnerProjectId,
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
    read: vi.fn(async (_projectId: number | null, name: string) =>
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
          lambdaWebAdapter: "1.1.0",
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
    clientQueries,
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

  it("레지스트리가 공용 연결이면 공용 시크릿을 읽고 ECR 저장소는 배포 프로젝트 것을 쓴다 (#215)", async () => {
    const harness = makeHarness({ registryOwnerProjectId: null });

    await handleBuild({ data: { deployment_id: 42 } }, harness.deps);

    const context = harness.queries.find((q) => q.sql.includes("SELECT d.status"))!;
    expect(context.sql).toContain("registry_environment.project_id AS registry_environment_project_id");
    expect(harness.secretReader.read).toHaveBeenCalledWith(null, "aws-access");
    expect(harness.secretReader.read).toHaveBeenCalledWith(null, "aws-secret");
    expect(harness.registry.ensureProjectRepository).toHaveBeenCalledWith(1);
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
    // 서버리스 배포에 쓸 수 있는 이미지인지 (#282)
    expect(artifact?.params[7]).toBe("1.1.0");
    expect(harness.getStatus()).toBe("provisioning");
    expect(harness.boss.send).toHaveBeenCalledWith("provision", {
      deployment_id: 42,
    });
  });

  it("정적 사이트 IR 이면 빌드 전에 프로필을 aws-static-basic 으로 맞추고 정적 이미지 plan 으로 빌드한다 (#273)", async () => {
    const harness = makeHarness({
      irJson: {
        metadata: { name: "site", version: "1.0.0" },
        services: {
          site: { type: "static", port: 8080, health: { path: "/" }, static: { build_command: "npm run build", output_dir: "dist" } },
        },
        deploy: { profile: "aws-ecs-basic" },
      },
    });

    await handleBuild({ data: { deployment_id: 42 } }, harness.deps);

    const profileUpdate = harness.queries.find((q) => q.sql.includes("SET target_profile"));
    expect(profileUpdate?.params).toEqual(["aws-static-basic", 42]);
    const irVersion = harness.queries.find((q) => q.sql.includes("INSERT INTO ir_versions"));
    expect(irVersion?.sql).toContain("profile_sync");
    expect(JSON.parse(String(irVersion?.params[1])).deploy.profile).toBe("aws-static-basic");
    expect(harness.buildHandler.build).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: {
          context: ".",
          staticSite: { buildCommand: "npm run build", outputDir: "dist", spaFallback: true, listenPort: 8080 },
        },
      }),
    );
    expect(harness.getStatus()).toBe("provisioning");
  });

  it("이미 저장된 artifact가 있으면 다시 build하지 않고 다음 단계로 간다", async () => {
    const harness = makeHarness({ existingArtifactId: 7 });

    await handleBuild({ data: { deployment_id: 42 } }, harness.deps);

    expect(harness.buildHandler.build).not.toHaveBeenCalled();
    expect(harness.secretReader.read).not.toHaveBeenCalled();
    expect(harness.getStatus()).toBe("provisioning");
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

  it("planning까지 저장된 재시도는 자동 승인을 거쳐 provisioning 으로 복구한다", async () => {
    const harness = makeHarness({ status: "planning", existingArtifactId: 7 });

    await handleBuild({ data: { deployment_id: 42 } }, harness.deps);

    expect(harness.buildHandler.build).not.toHaveBeenCalled();
    expect(harness.boss.send).toHaveBeenCalledWith("provision", {
      deployment_id: 42,
    });
    expect(harness.getStatus()).toBe("provisioning");
    const approvalInsert = harness.clientQueries.find((query) =>
      query.sql.includes("INSERT INTO approvals"),
    );
    expect(approvalInsert).toBeDefined();
  });

  it("Plan 자동 승인 후 approvals 테이블에 auto-approve 레코드를 남긴다", async () => {
    const harness = makeHarness();

    await handleBuild({ data: { deployment_id: 42 } }, harness.deps);

    const approvalInsert = harness.clientQueries.find((query) =>
      query.sql.includes("INSERT INTO approvals"),
    );
    expect(approvalInsert).toBeDefined();
    expect(approvalInsert?.params).toEqual([42]);
    expect(approvalInsert?.sql).toContain("'plan'");
    expect(approvalInsert?.sql).toContain("'approve'");
    expect(approvalInsert?.sql).toContain("auto-approved");
    expect(approvalInsert?.sql).toContain(
      "ON CONFLICT (deployment_id, gate) DO NOTHING",
    );
  });

  it("Plan 자동 승인 성공 시 state_changed SSE 를 building → planning → awaiting_plan_approval → provisioning 순서로 발행한다", async () => {
    const harness = makeHarness();

    await handleBuild({ data: { deployment_id: 42 } }, harness.deps);

    const stateChanges = harness.notifier.notify.mock.calls
      .filter(([, event]) => event === "state_changed")
      .map(([, , payload]) => (payload as { status: string }).status);
    expect(stateChanges).toEqual([
      "building",
      "planning",
      "awaiting_plan_approval",
      "provisioning",
    ]);
  });

  it("자동 승인 중 approvals INSERT 가 실패하면 ROLLBACK 하고 handleBuild catch 가 failed 전이 + env_lock 해제", async () => {
    const harness = makeHarness({
      autoApproveFailure: new Error("approvals constraint violation"),
    });

    await handleBuild({ data: { deployment_id: 42 } }, harness.deps);

    expect(harness.clientQueries.some((query) => query.sql === "ROLLBACK")).toBe(
      true,
    );
    expect(harness.boss.send).not.toHaveBeenCalledWith(
      "provision",
      expect.anything(),
    );
    expect(
      harness.queries.some((query) => query.sql.includes("DELETE FROM env_locks")),
    ).toBe(true);
    expect(harness.getStatus()).toBe("failed");
  });

  describe("재배포 이미지 재사용", () => {
    const OLD_DIGEST = `sha256:${"b".repeat(64)}`;

    it("원본 배포의 이미지를 복사하고 빌드 없이 다음 단계로 간다", async () => {
      const harness = makeHarness({ reusableDigest: OLD_DIGEST });

      await handleBuild(
        { data: { deployment_id: 42, redeployed_from: 7 } },
        harness.deps,
      );

      const copy = harness.queries.find(
        (query) =>
          query.sql.includes("INSERT INTO build_artifacts") &&
          query.sql.includes("SELECT"),
      );
      expect(copy?.params).toEqual([42, 7]);
      expect(harness.buildHandler.build).not.toHaveBeenCalled();
      expect(harness.secretReader.read).not.toHaveBeenCalled();
      expect(harness.getStatus()).toBe("provisioning");
      expect(harness.boss.send).toHaveBeenCalledWith("provision", {
        deployment_id: 42,
      });
      const stateChanges = harness.notifier.notify.mock.calls
        .filter(([, event]) => event === "state_changed")
        .map(([, , payload]) => (payload as { status: string }).status);
      expect(stateChanges).toEqual([
        "building",
        "planning",
        "awaiting_plan_approval",
        "provisioning",
      ]);
      const logLines = harness.notifier.notify.mock.calls
        .filter(([, event]) => event === "log.line")
        .map(([, , payload]) => JSON.stringify(payload));
      expect(logLines.some((line) => line.includes(OLD_DIGEST) && line.includes("#7"))).toBe(true);
    });

    it("재사용할 이미지가 없으면 지금처럼 빌드한다", async () => {
      const harness = makeHarness();

      await handleBuild(
        { data: { deployment_id: 42, redeployed_from: 7 } },
        harness.deps,
      );

      expect(harness.buildHandler.build).toHaveBeenCalledTimes(1);
      const saved = harness.queries.find(
        (query) =>
          query.sql.includes("INSERT INTO build_artifacts") &&
          query.sql.includes("VALUES"),
      );
      expect(saved?.params[3]).toBe(DIGEST);
      expect(harness.getStatus()).toBe("provisioning");
    });

    it("서버리스 배포는 Lambda Web Adapter 가 들어 있는 이미지만 재사용하고 그 표시도 복사한다 (#282)", async () => {
      const harness = makeHarness({ reusableDigest: OLD_DIGEST });

      await handleBuild(
        { data: { deployment_id: 42, redeployed_from: 7 } },
        harness.deps,
      );

      const copy = harness.queries.find(
        (query) =>
          query.sql.includes("INSERT INTO build_artifacts") &&
          query.sql.includes("SELECT"),
      )!;
      const sql = copy.sql.replace(/\s+/g, " ");
      expect(sql).toContain("lambda_web_adapter");
      expect(sql).toContain("target.target_profile <> 'aws-lambda-basic' OR artifact.lambda_web_adapter IS NOT NULL");
    });

    it("재배포가 아니면 재사용 조회를 하지 않는다", async () => {
      const harness = makeHarness({ reusableDigest: OLD_DIGEST });

      await handleBuild({ data: { deployment_id: 42 } }, harness.deps);

      expect(harness.buildHandler.build).toHaveBeenCalledTimes(1);
    });
  });
});
