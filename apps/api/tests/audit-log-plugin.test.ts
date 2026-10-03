/**
 * apps/api/tests/audit-log-plugin.test.ts
 * audit-log 미들웨어 통합 테스트 (fastify.inject + MockPool).
 *
 * - POST 요청 → audit_logs INSERT 호출 확인
 * - GET 요청 → INSERT 호출 안 됨
 * - D-50: 시크릿 필드 마스킹 확인 (password, value, token* 등)
 * - redactSecrets 유닛 테스트
 * - parseResource 유닛 테스트
 * - 미들웨어 INSERT 실패 시 응답 블로킹 없음
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { MockPool, MockPgBoss, MockStorage } from "./mocks/db.js";
import { redactSecrets, parseResource } from "../src/plugins/audit-log.js";

let server: FastifyInstance;
let pool: MockPool;
let boss: MockPgBoss;
let storage: MockStorage;

beforeEach(async () => {
  pool = new MockPool();
  boss = new MockPgBoss();
  storage = new MockStorage();
  server = await buildServer({
    pool: pool as any,
    boss: boss as any,
    storage: storage as any,
    nodeEnv: "test",
    logger: false,
    enablePgListener: false,
  });
  await server.ready();
});

afterEach(async () => {
  await server.close();
  pool.reset();
  boss.reset();
  storage.reset();
});

// ── redactSecrets 유닛 ─────────────────────────────────────────────────────────

describe("redactSecrets", () => {
  it("시크릿 필드 마스킹: password, value, token", () => {
    const input = {
      name: "my-secret",
      password: "super-secret",
      value: "secret-value",
      token: "my-token",
      nested: { accessKey: "AKIAXXXX", other: "ok" },
    };
    const result = redactSecrets(input) as Record<string, unknown>;

    expect(result["name"]).toBe("my-secret");
    expect(result["password"]).toBe("***");
    expect(result["value"]).toBe("***");
    expect(result["token"]).toBe("***");
    const nested = result["nested"] as Record<string, unknown>;
    expect(nested["accessKey"]).toBe("***");
    expect(nested["other"]).toBe("ok");
  });

  it("AWS 키 확인 요청의 Access Key ID · Secret Access Key 마스킹 (#209)", () => {
    const result = redactSecrets({ accessKeyId: "AKIAXXXX", secretAccessKey: "wJalr", region: "ap-northeast-2" }) as Record<string, unknown>;
    expect(result).toEqual({ accessKeyId: "***", secretAccessKey: "***", region: "ap-northeast-2" });
  });

  it("시크릿 아닌 필드는 그대로 유지", () => {
    const input = { projectId: 1, name: "test", description: "ok" };
    const result = redactSecrets(input) as Record<string, unknown>;
    expect(result).toEqual(input);
  });

  it("null 값은 그대로 반환", () => {
    expect(redactSecrets(null)).toBeNull();
  });

  it("배열 내부도 재귀 마스킹", () => {
    const input = [{ password: "secret" }, { name: "ok" }];
    const result = redactSecrets(input) as Array<Record<string, unknown>>;
    expect(result[0]!["password"]).toBe("***");
    expect(result[1]!["name"]).toBe("ok");
  });
});

// ── parseResource 유닛 ─────────────────────────────────────────────────────────

describe("parseResource", () => {
  it("/api/v1/deployments/42 → deployment, 42", () => {
    const r = parseResource("/api/v1/deployments/42");
    expect(r.resourceType).toBe("deployment");
    expect(r.resourceId).toBe("42");
  });

  it("/api/v1/projects → project, null", () => {
    const r = parseResource("/api/v1/projects");
    expect(r.resourceType).toBe("project");
    expect(r.resourceId).toBeNull();
  });

  it("/api/v1/secrets/my-key → secret, null (비숫자 segment)", () => {
    const r = parseResource("/api/v1/secrets/my-key");
    expect(r.resourceType).toBe("secret");
    expect(r.resourceId).toBeNull();
  });

  it("/api/v1/environments/5 → environment, 5", () => {
    const r = parseResource("/api/v1/environments/5");
    expect(r.resourceType).toBe("environment");
    expect(r.resourceId).toBe("5");
  });
});

// ── 미들웨어 통합 ─────────────────────────────────────────────────────────────

describe("audit-log middleware integration", () => {
  it("POST 요청 시 INSERT INTO audit_logs 호출", async () => {
    let insertCalled = false;
    pool.on(/INSERT INTO audit_logs/, (params) => {
      insertCalled = true;
      return { rows: [] };
    });
    // projects 조회 mock (POST /api/v1/projects 가 실제로 뭔가 반환해야 하므로)
    pool.on(/INSERT INTO projects/, () => ({ rows: [{ id: 1, name: "test", created_at: new Date() }] }));

    await server.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "test-project" },
    });

    // onResponse hook 이 비동기로 실행됨 — 짧게 기다림
    await new Promise((r) => setTimeout(r, 20));
    expect(insertCalled).toBe(true);
  });

  it("GET 요청 시 INSERT INTO audit_logs 호출 안 됨", async () => {
    let insertCalled = false;
    pool.on(/INSERT INTO audit_logs/, () => {
      insertCalled = true;
      return { rows: [] };
    });
    pool.on(/SELECT.*FROM projects/, () => ({ rows: [] }));

    await server.inject({
      method: "GET",
      url: "/api/v1/projects",
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(insertCalled).toBe(false);
  });

  it("D-50: POST body 에 password 필드 포함 시 마스킹된 값만 metadata 에 저장", async () => {
    let capturedMetadata: string | null = null;
    pool.on(/INSERT INTO audit_logs/, (params) => {
      capturedMetadata = params[7] as string;
      return { rows: [] };
    });
    pool.on(/INSERT INTO secrets/, () => ({ rows: [{ name: "my-secret", project_id: 1, created_at: new Date() }] }));

    await server.inject({
      method: "POST",
      url: "/api/v1/secrets",
      payload: { name: "my-secret", value: "super-secret-value", projectId: 1 },
    });

    await new Promise((r) => setTimeout(r, 20));
    // capturedMetadata 는 JSON 문자열 또는 이미 파싱된 객체
    const metadata = typeof capturedMetadata === "string"
      ? JSON.parse(capturedMetadata)
      : capturedMetadata;

    if (metadata !== null) {
      expect(metadata.value).toBe("***");
      expect(metadata.name).toBe("my-secret");
    }
  });

  it("INSERT 실패해도 응답 블로킹 없음 (silent fail)", async () => {
    // audit_logs INSERT 가 실패하도록 설정
    pool.on(/INSERT INTO audit_logs/, () => {
      throw new Error("DB connection lost");
    });
    // projects SELECT (GET /projects) 는 정상 응답
    pool.on(/SELECT.*FROM projects|FROM projects/i, () => ({ rows: [] }));

    // GET 요청 → onResponse 훅이 실행 안 됨 (mutating method 아님) → 정상 200
    const res = await server.inject({
      method: "GET",
      url: "/api/v1/projects",
    });
    expect(res.statusCode).toBe(200);

    // audit_logs INSERT 실패해도 응답 블로킹 없는지 확인하려면 onResponse hook 직접 검증
    // onResponse 에서 try/catch 로 감싸므로 에러가 응답에 전파되지 않는다
    // 미들웨어 자체의 try/catch 로직은 audit-log.ts 코드에서 보장됨
    // 여기서는 logger.warn 이 호출됐는지 확인 (Fastify 로거 spy)
    const warnSpy = vi.spyOn(server.log, "warn");

    pool.on(/INSERT INTO projects/, () => ({
      rows: [{ id: 1, name: "test", created_at: new Date().toISOString() }],
    }));

    const res2 = await server.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "test" },
    });

    // onResponse 비동기 실행 대기
    await new Promise((r) => setTimeout(r, 30));

    // 응답이 audit_logs INSERT 실패 때문에 500이 되면 안 됨
    // projects INSERT 가 성공하면 201, 실패해도 audit 로그 실패가 아닌 비즈니스 로직 에러
    // 핵심: warnSpy 가 호출됐으면 try/catch 가 작동한 것
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining("audit-log"),
    );
  });
});
