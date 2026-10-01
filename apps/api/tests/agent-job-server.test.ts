import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "@camellia/db";
import type PgBoss from "pg-boss";
import type { Storage } from "@camellia/storage";
import { buildServer } from "../src/server.js";
import { MockPool, MockPgBoss, MockStorage } from "./mocks/db.js";

let server: FastifyInstance;
let pool: MockPool;
let boss: MockPgBoss;
let storage: MockStorage;

beforeEach(async () => {
  pool = new MockPool();
  boss = new MockPgBoss();
  storage = new MockStorage();
  server = await buildServer({
    pool: pool as unknown as Pool,
    boss: boss as unknown as PgBoss,
    storage: storage as unknown as Storage,
    apiKey: "platform-api-key",
    nodeEnv: "production",
    logger: false,
    enablePgListener: false,
    agentJobPollTimeoutMs: 5,
    agentJobPollIntervalMs: 1,
  });
  await server.ready();
});

afterEach(async () => {
  await server.close();
  pool.reset();
  boss.reset();
  storage.reset();
});

describe("POST /api/v1/agents/jobs/claim integration", () => {
  it("main AgentService bearer 인증으로 자기 환경의 Job을 가져온다", async () => {
    pool.on(/FROM agents WHERE long_lived_key_hash/, () => ({
      rows: [{ id: 7, environment_id: 12 }],
    }));
    pool.on(/WITH candidate AS/, () => ({
      rows: [{
        job_id: "73",
        attempt: 1,
        deployment_id: "73",
        environment_id: "12",
        payload: {
          plan: { target: "onprem" },
          image: {
            repositoryUri: "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/camellia/projects/4",
            digest: `sha256:${"a".repeat(64)}`,
            platform: "linux/amd64",
            registryType: "ecr",
            region: "ap-northeast-2",
          },
        },
      }],
    }));

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/agents/jobs/claim",
      headers: { authorization: "Bearer agent-long-lived-key" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      job: {
        jobId: "73",
        attempt: 1,
        deploymentId: 73,
        environmentId: "12",
        plan: { target: "onprem" },
        image: { platform: "linux/amd64" },
      },
    });
  });

  it("잘못된 Agent Bearer 키는 플랫폼 API 키 없이 통과하지 못한다", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/agents/jobs/claim",
      headers: { authorization: "Bearer invalid-agent-key" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });
});
