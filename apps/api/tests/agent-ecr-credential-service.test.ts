import { describe, expect, it, vi } from "vitest";
import type { Pool } from "@camellia/db";
import {
  AgentEcrCredentialService,
  type AwsEcrRegistryFactory,
} from "../src/services/agent-ecr-credential-service.js";
import type { SecretService } from "../src/services/secret-service.js";

const agent = { agentId: 7, environmentId: 12 };
const jobRow = {
  project_id: "4",
  aws_config: {
    credentialsType: "access_key",
    accessKeyIdSecretName: "aws-access-key",
    secretAccessKeySecretName: "aws-secret-key",
    region: "ap-northeast-2",
  },
  payload: {
    image: {
      repositoryUri: "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/camellia/projects/4@sha256:abc",
    },
  },
  attempt: 2,
};

function setup(rows: unknown[] = [jobRow]) {
  const query = vi.fn(async () => ({ rows, rowCount: rows.length }));
  const pool = { query } as unknown as Pool;
  const decrypt = vi.fn(async ({ name }: { projectId: number; name: string }) =>
    name === "aws-access-key" ? "AKIA_EXAMPLE" : "secret-example",
  );
  const secretService = { decrypt } as unknown as SecretService;
  const getAuthorization = vi.fn(async () => ({
    registryUri: "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com",
    username: "AWS" as const,
    password: "SHORT_LIVED_ECR_PASSWORD",
    expiresAt: "2026-10-01T10:00:00.000Z",
  }));
  const factory = vi.fn((_options) => ({ getAuthorization })) as unknown as AwsEcrRegistryFactory;
  const service = new AgentEcrCredentialService(pool, secretService, factory);
  return { service, query, decrypt, factory, getAuthorization };
}

describe("AgentEcrCredentialService.issue", () => {
  it("자기 lease의 attempt에 한해 사용자 AWS ECR 인증정보를 발급한다", async () => {
    const { service, query, decrypt, factory, getAuthorization } = setup();

    const credential = await service.issue({ agent, jobId: "73" });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("job.lease_owner_id = $3"),
      ["73", 12, 7],
    );
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("job.lease_expires_at > NOW()");
    expect(sql).toContain("job.ecr_credential_issued_attempt IS DISTINCT FROM job.attempt");
    expect(sql).toContain("registry_environment.id = deployment.registry_environment_id");
    expect(sql).toContain("target_environment.id = job.environment_id");
    expect(decrypt).toHaveBeenNthCalledWith(1, { projectId: 4, name: "aws-access-key" });
    expect(decrypt).toHaveBeenNthCalledWith(2, { projectId: 4, name: "aws-secret-key" });
    expect(factory).toHaveBeenCalledWith({
      region: "ap-northeast-2",
      credentials: { accessKeyId: "AKIA_EXAMPLE", secretAccessKey: "secret-example" },
    });
    expect(getAuthorization).toHaveBeenCalledOnce();
    expect(credential).toEqual({
      registry: "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com",
      username: "AWS",
      password: "SHORT_LIVED_ECR_PASSWORD",
      expiresAt: "2026-10-01T10:00:00.000Z",
    });
    expect(JSON.stringify(query.mock.calls)).not.toContain("SHORT_LIVED_ECR_PASSWORD");
  });

  it("자기 소유 active lease가 아니거나 attempt에서 이미 발급됐으면 거부한다", async () => {
    const { service, decrypt, factory } = setup([]);

    await expect(service.issue({ agent, jobId: "73" })).rejects.toMatchObject({
      statusCode: 409,
      code: "AGENT_JOB_NOT_ELIGIBLE",
    });
    expect(decrypt).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it("동시 요청 경쟁에서 단 하나의 요청만 attempt marker를 획득한다", async () => {
    let issuedAttempt: number | null = null;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("UPDATE onprem_agent_jobs AS job")) {
        if (issuedAttempt === 2) return { rows: [], rowCount: 0 };
        issuedAttempt = 2;
        return { rows: [jobRow], rowCount: 1 };
      }
      if (sql.includes("FROM onprem_agent_jobs AS job")) {
        return { rows: [{ one: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const getAuthorization = vi.fn(async () => ({
      registryUri: "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com",
      username: "AWS" as const,
      password: "ONE_WINNER_ONLY",
      expiresAt: "2026-10-01T10:00:00.000Z",
    }));
    const service = new AgentEcrCredentialService(
      { query } as unknown as Pool,
      { decrypt: vi.fn(async () => "secret") } as unknown as SecretService,
      (() => ({ getAuthorization })) as unknown as AwsEcrRegistryFactory,
    );

    const results = await Promise.allSettled([
      service.issue({ agent, jobId: "73" }),
      service.issue({ agent, jobId: "73" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(getAuthorization).toHaveBeenCalledOnce();
  });

  it("registry 발급 실패는 민감한 AWS 오류 대신 정규화하고 재시도 marker를 해제한다", async () => {
    const { query } = setup();
    const badFactory = vi.fn(() => ({
      getAuthorization: vi.fn(async () => {
        throw new Error("AWS secret access key leaked by provider error");
      }),
    })) as unknown as AwsEcrRegistryFactory;
    const pool = { query } as unknown as Pool;
    const secretService = { decrypt: vi.fn(async () => "secret") } as unknown as SecretService;
    const failingService = new AgentEcrCredentialService(pool, secretService, badFactory);

    await expect(failingService.issue({ agent, jobId: "73" })).rejects.toMatchObject({
      statusCode: 502,
      code: "ECR_CREDENTIAL_UNAVAILABLE",
      message: "사용자 AWS 계정의 ECR 인증정보를 발급하지 못했습니다.",
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[1]?.[0])).toContain("SET ecr_credential_issued_attempt = NULL");
  });

  it("다른 ECR registry 정보는 Agent에 반환하지 않는다", async () => {
    const { query } = setup();
    const registryMismatchFactory = vi.fn(() => ({
      getAuthorization: vi.fn(async () => ({
        registryUri: "999999999999.dkr.ecr.us-east-1.amazonaws.com",
        username: "AWS" as const,
        password: "MUST_NOT_RETURN",
        expiresAt: "2026-10-01T10:00:00.000Z",
      })),
    })) as unknown as AwsEcrRegistryFactory;
    const failingService = new AgentEcrCredentialService(
      { query } as unknown as Pool,
      { decrypt: vi.fn(async () => "secret") } as unknown as SecretService,
      registryMismatchFactory,
    );

    await expect(failingService.issue({ agent, jobId: "73" })).rejects.toMatchObject({
      code: "ECR_CREDENTIAL_UNAVAILABLE",
    });
    expect(JSON.stringify(query.mock.calls)).not.toContain("MUST_NOT_RETURN");
  });
});
