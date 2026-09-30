/**
 * apps/api/tests/deployment-logs.test.ts
 * GET /api/v1/deployments/:id/logs (API-12 · LOG-02) — 스토리지 로그 파일 우선, 없으면 deployment_steps.message.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "@camellia/db";
import type PgBoss from "pg-boss";
import type { Storage } from "@camellia/storage";
import { buildServer } from "../src/server.js";
import { MockPgBoss, MockPool, MockStorage } from "./mocks/db.js";

let server: FastifyInstance;
let pool: MockPool;
let storage: MockStorage;

beforeEach(async () => {
  pool = new MockPool();
  storage = new MockStorage();
  server = await buildServer({
    pool: pool as unknown as Pool,
    boss: new MockPgBoss() as unknown as PgBoss,
    storage: storage as unknown as Storage,
    nodeEnv: "development",
    logger: false,
    enablePgListener: false,
  });
  await server.ready();
});

afterEach(async () => {
  await server.close();
  pool.reset();
  storage.reset();
});

function givenDeployment(messages: string[] = []) {
  pool.on(/FROM deployments WHERE id/, () => ({ rows: [{ "?column?": 1 }] }));
  pool.on(/FROM deployment_steps/, () => ({ rows: messages.map((message) => ({ message })) }));
}

const LOG_FILE =
  "[2026-09-30T12:00:00.000Z] docker build 시작\n" +
  "[2026-09-30T12:00:05.000Z] ECR push 완료\n";

describe("GET /api/v1/deployments/:id/logs", () => {
  it("단계 로그 파일이 있으면 파일 내용을 반환함", async () => {
    givenDeployment(["build 요약"]);
    storage.store.set("logs/deployments/7/build.log", Buffer.from(LOG_FILE));

    const res = await server.inject({ method: "GET", url: "/api/v1/deployments/7/logs?step=build" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toBe(LOG_FILE.trimEnd());
  });

  it("tail이면 로그 파일의 마지막 N줄만 반환함", async () => {
    givenDeployment();
    storage.store.set("logs/deployments/7/build.log", Buffer.from(LOG_FILE));

    const res = await server.inject({
      method: "GET",
      url: "/api/v1/deployments/7/logs?step=build&tail=1",
    });

    expect(res.body).toBe("[2026-09-30T12:00:05.000Z] ECR push 완료");
  });

  it("로그 파일이 없으면 단계 요약 메시지를 반환함", async () => {
    givenDeployment(["verify 3회 연속 성공"]);

    const res = await server.inject({ method: "GET", url: "/api/v1/deployments/7/logs?step=verify" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("verify 3회 연속 성공");
  });

  it("로그가 전혀 없으면 204", async () => {
    givenDeployment();

    const res = await server.inject({ method: "GET", url: "/api/v1/deployments/7/logs?step=build" });

    expect(res.statusCode).toBe(204);
  });

  it("배포가 없으면 404", async () => {
    pool.on(/FROM deployments WHERE id/, () => ({ rows: [] }));

    const res = await server.inject({ method: "GET", url: "/api/v1/deployments/99/logs?step=build" });

    expect(res.statusCode).toBe(404);
  });
});
