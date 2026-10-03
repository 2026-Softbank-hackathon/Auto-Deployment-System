/**
 * POST /credentials/verify — AWS 키 확인 (#209). STS 호출은 바꿔 끼운 확인 함수로 대신한다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "@camellia/db";
import type PgBoss from "pg-boss";
import type { Storage } from "@camellia/storage";
import { VerifyAwsCredentialsResultSchema, type VerifyAwsCredentialsResult } from "@camellia/contracts";
import { buildServer } from "../src/server.js";
import type { AwsCredentialVerifier } from "../src/services/aws-credential-verifier.js";
import { ApiError } from "../src/plugins/error-handler.js";
import { MockPgBoss, MockPool, MockStorage } from "./mocks/db.js";

let server: FastifyInstance | null = null;

async function start(verify: AwsCredentialVerifier) {
  server = await buildServer({
    pool: new MockPool() as unknown as Pool,
    boss: new MockPgBoss() as unknown as PgBoss,
    storage: new MockStorage() as unknown as Storage,
    nodeEnv: "development",
    logger: false,
    enablePgListener: false,
    verifyAwsCredentials: verify,
  });
  await server.ready();
  return server;
}

afterEach(async () => {
  await server?.close();
  server = null;
});

const body = { accessKeyId: " AKIAEXAMPLE ", secretAccessKey: "secret", region: "ap-northeast-2" };

describe("POST /credentials/verify", () => {
  it("맞는 키 — 계정 번호와 ARN, 앞뒤 공백은 지우고 넘긴다", async () => {
    const verify = vi.fn<AwsCredentialVerifier>(async () => ({ valid: true, accountId: "123456789012", arn: "arn:aws:iam::123456789012:user/deploy" }));
    const app = await start(verify);
    const res = await app.inject({ method: "POST", url: "/api/v1/credentials/verify", payload: body });
    expect(res.statusCode).toBe(200);
    expect(VerifyAwsCredentialsResultSchema.parse(res.json())).toEqual({ valid: true, accountId: "123456789012", arn: "arn:aws:iam::123456789012:user/deploy" });
    expect(verify).toHaveBeenCalledWith({ accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", region: "ap-northeast-2" });
  });

  it("틀린 키 — 200 { valid: false, reason }", async () => {
    const rejected: VerifyAwsCredentialsResult = { valid: false, reason: "SIGNATURE_MISMATCH" };
    const app = await start(async () => rejected);
    const res = await app.inject({ method: "POST", url: "/api/v1/credentials/verify", payload: body });
    expect(res.statusCode).toBe(200);
    expect(VerifyAwsCredentialsResultSchema.parse(res.json())).toEqual(rejected);
  });

  it("빈 키 — 400, 확인 함수는 부르지 않는다", async () => {
    const verify = vi.fn<AwsCredentialVerifier>();
    const app = await start(verify);
    const res = await app.inject({ method: "POST", url: "/api/v1/credentials/verify", payload: { ...body, secretAccessKey: "" } });
    expect(res.statusCode).toBe(400);
    expect(verify).not.toHaveBeenCalled();
  });

  it("AWS 에 닿지 못하면 502 AWS_VERIFY_UNAVAILABLE, 응답에 키가 없다", async () => {
    const app = await start(async () => { throw new ApiError(502, "AWS_VERIFY_UNAVAILABLE", "AWS 에 키를 확인하지 못했습니다."); });
    const res = await app.inject({ method: "POST", url: "/api/v1/credentials/verify", payload: body });
    expect(res.statusCode).toBe(502);
    expect(res.json().error?.code ?? res.json().code).toBe("AWS_VERIFY_UNAVAILABLE");
    expect(res.body).not.toContain("secret\"");
    expect(res.body).not.toContain("AKIAEXAMPLE");
  });
});
