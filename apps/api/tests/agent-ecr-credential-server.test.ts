import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "@camellia/db";
import type PgBoss from "pg-boss";
import type { Storage } from "@camellia/storage";
import { buildServer } from "../src/server.js";
import { SecretService } from "../src/services/secret-service.js";
import { MockPgBoss, MockStorage } from "./mocks/db.js";

const masterKey = Buffer.alloc(32, 42);
const ecrPassword = "AWS_SHORT_LIVED_TOKEN_MUST_NOT_BE_STORED";
const imageRepository = "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/camellia/projects/4@sha256:abc";

let server: FastifyInstance;
let boss: MockPgBoss;
let storedSecrets: Map<string, { ciphertext: Buffer; iv: Buffer; auth_tag: Buffer }>;
let query: ReturnType<typeof vi.fn>;
let issueAttempt: number | null;
let getAuthorization: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  storedSecrets = new Map();
  issueAttempt = null;
  getAuthorization = vi.fn(async () => ({
    registryUri: "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com",
    username: "AWS" as const,
    password: ecrPassword,
    expiresAt: "2026-10-01T10:00:00.000Z",
  }));
  query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("SELECT 1 FROM projects")) return { rows: [{ one: 1 }], rowCount: 1 };
    if (sql.includes("INSERT INTO secrets")) {
      storedSecrets.set(String(params[1]), {
        ciphertext: params[2] as Buffer,
        iv: params[3] as Buffer,
        auth_tag: params[4] as Buffer,
      });
      return { rows: [{ created_at: new Date() }], rowCount: 1 };
    }
    if (sql.includes("FROM agents WHERE long_lived_key_hash")) {
      return { rows: [{ id: 7, environment_id: 12 }], rowCount: 1 };
    }
    if (sql.includes("UPDATE onprem_agent_jobs AS job")) {
      if (issueAttempt !== null) return { rows: [], rowCount: 0 };
      issueAttempt = 2;
      return {
        rows: [{
          project_id: "4",
          aws_config: {
            credentialsType: "access_key",
            accessKeyIdSecretName: "aws-access-key",
            secretAccessKeySecretName: "aws-secret-key",
            region: "ap-northeast-2",
          },
          payload: { image: { repositoryUri: imageRepository } },
          attempt: 2,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM onprem_agent_jobs AS job")) {
      const rows = issueAttempt === 2 ? [{ one: 1 }] : [];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("SELECT ciphertext, iv, auth_tag FROM secrets")) {
      const value = storedSecrets.get(String(params[1]));
      return { rows: value ? [value] : [], rowCount: value ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  const pool = { query } as unknown as Pool;
  const secretService = new SecretService(pool, masterKey);
  await secretService.create({ projectId: 4, name: "aws-access-key", value: "AKIA_USER_ACCOUNT_KEY" });
  await secretService.create({ projectId: 4, name: "aws-secret-key", value: "USER_ACCOUNT_SECRET_KEY" });

  boss = new MockPgBoss();
  server = await buildServer({
    pool,
    boss: boss as unknown as PgBoss,
    storage: new MockStorage() as unknown as Storage,
    apiKey: "platform-api-key",
    nodeEnv: "production",
    logger: false,
    enablePgListener: false,
    secretMasterKey: masterKey,
    awsEcrRegistryFactory: () => ({ getAuthorization }),
  });
  await server.ready();
});

afterEach(async () => {
  await server.close();
  boss.reset();
});

describe("Agent ECR credential API integration", () => {
  it("실제 API 인증·Secret 복호화 경로를 거쳐 한 attempt당 최대 한 번 password를 반환한다", async () => {
    const first = await server.inject({
      method: "POST",
      url: "/api/v1/agents/jobs/73/ecr-credential",
      headers: { authorization: "Bearer registered-agent-key" },
    });
    const second = await server.inject({
      method: "POST",
      url: "/api/v1/agents/jobs/73/ecr-credential",
      headers: { authorization: "Bearer registered-agent-key" },
    });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ registry: "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com", username: "AWS", password: ecrPassword });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("AGENT_JOB_NOT_ELIGIBLE");
    expect(getAuthorization).toHaveBeenCalledOnce();

    const queryValues = JSON.stringify(query.mock.calls.map((call) => call[1]));
    expect(queryValues).not.toContain("AKIA_USER_ACCOUNT_KEY");
    expect(queryValues).not.toContain("USER_ACCOUNT_SECRET_KEY");
    expect(queryValues).not.toContain(ecrPassword);
  });

  it("ECR provider 오류에 포함된 비밀 원문은 API 응답에 노출되지 않는다", async () => {
    issueAttempt = null;
    getAuthorization.mockRejectedValueOnce(new Error("provider echoed USER_ACCOUNT_SECRET_KEY"));

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/agents/jobs/73/ecr-credential",
      headers: { authorization: "Bearer registered-agent-key" },
    });

    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain("USER_ACCOUNT_SECRET_KEY");
    expect(response.body).not.toContain(ecrPassword);
  });
});
