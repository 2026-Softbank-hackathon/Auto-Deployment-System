/**
 * apps/api/tests/agent-service.test.ts
 * AgentService 유닛 테스트 (mock pool).
 *
 * - 토큰 발급 → consume 흐름
 * - 만료 토큰 거부
 * - 이미 consumed 토큰 거부
 * - 유효하지 않은 토큰 거부
 * - 장기 키 인증 (match / mismatch)
 * - heartbeat 기록 + cancellation 감지
 * - environment 당 Agent 1대 (409)
 */

import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import type { Pool } from "@camellia/db";
import { AgentService } from "../src/services/agent-service.js";

function sha256(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

/** pool.query + pool.connect(client.query) 를 동시에 다루는 mock factory */
function makePool(
  fn: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number } | Promise<{ rows: unknown[]; rowCount?: number }>,
): Pool {
  const query = vi.fn(fn);
  return {
    query,
    connect: vi.fn(async () => ({
      query,
      release: vi.fn(),
    })),
  } as unknown as Pool;
}

// ── issueRegistrationToken ────────────────────────────────────────────────────

describe("AgentService.issueRegistrationToken", () => {
  it("environment 존재하면 token + expiresAt 반환", async () => {
    const pool = makePool(async (sql) => {
      if (/FROM environments/.test(sql)) return { rows: [{}], rowCount: 1 };
      if (/INSERT INTO agent_registration_tokens/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const svc = new AgentService(pool);
    const result = await svc.issueRegistrationToken(1);

    expect(result.token).toHaveLength(64); // 32 bytes hex
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("environment 없으면 404", async () => {
    const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
    const svc = new AgentService(pool);
    await expect(svc.issueRegistrationToken(999)).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    });
  });
});

// ── register ──────────────────────────────────────────────────────────────────

describe("AgentService.register", () => {
  const PLAIN_TOKEN = "a".repeat(64);
  const TOKEN_HASH = sha256(PLAIN_TOKEN);

  function makeRegisterPool(overrides: {
    tokenRow?: object | null;
    agentRow?: object | null;
    duplicate?: boolean;
  }) {
    const { tokenRow, agentRow, duplicate } = overrides;
    return makePool(async (sql) => {
      if (/BEGIN/.test(sql)) return { rows: [] };
      if (/COMMIT/.test(sql)) return { rows: [] };
      if (/ROLLBACK/.test(sql)) return { rows: [] };

      if (/FROM agent_registration_tokens/.test(sql)) {
        if (tokenRow === null) return { rows: [], rowCount: 0 };
        return {
          rows: [tokenRow ?? {
            id: 1,
            environment_id: 10,
            expires_at: new Date(Date.now() + 60_000),
            consumed_at: null,
          }],
          rowCount: 1,
        };
      }
      if (/INSERT INTO agents/.test(sql)) {
        if (duplicate) throw new Error("unique constraint violation");
        if (agentRow === null) return { rows: [], rowCount: 0 };
        return {
          rows: [agentRow ?? { id: 5, environment_id: 10 }],
          rowCount: 1,
        };
      }
      if (/UPDATE agent_registration_tokens/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
  }

  it("유효 토큰 소비 → agentId, longLivedKey, environmentId 반환", async () => {
    const pool = makeRegisterPool({});
    const svc = new AgentService(pool);
    const result = await svc.register(PLAIN_TOKEN);

    expect(result.agentId).toBe("5");
    expect(result.environmentId).toBe("10");
    // longLivedKey 는 base64url 32 bytes → 약 43자
    expect(result.longLivedKey.length).toBeGreaterThan(30);
  });

  it("토큰 없으면 400 VALIDATION_ERROR", async () => {
    const pool = makeRegisterPool({ tokenRow: null });
    const svc = new AgentService(pool);
    await expect(svc.register(PLAIN_TOKEN)).rejects.toMatchObject({
      statusCode: 400,
      code: "VALIDATION_ERROR",
    });
  });

  it("만료 토큰 → 400 VALIDATION_ERROR", async () => {
    const pool = makeRegisterPool({
      tokenRow: {
        id: 1,
        environment_id: 10,
        expires_at: new Date(Date.now() - 1000), // 이미 만료
        consumed_at: null,
      },
    });
    const svc = new AgentService(pool);
    await expect(svc.register(PLAIN_TOKEN)).rejects.toMatchObject({
      statusCode: 400,
      code: "VALIDATION_ERROR",
    });
  });

  it("이미 consumed 토큰 → 400 VALIDATION_ERROR", async () => {
    const pool = makeRegisterPool({
      tokenRow: {
        id: 1,
        environment_id: 10,
        expires_at: new Date(Date.now() + 60_000),
        consumed_at: new Date(), // 이미 사용됨
      },
    });
    const svc = new AgentService(pool);
    await expect(svc.register(PLAIN_TOKEN)).rejects.toMatchObject({
      statusCode: 400,
      code: "VALIDATION_ERROR",
    });
  });

  it("environment 당 Agent 1대 — UNIQUE 위반 → 409 CONFLICT", async () => {
    const pool = makeRegisterPool({ duplicate: true });
    const svc = new AgentService(pool);
    await expect(svc.register(PLAIN_TOKEN)).rejects.toMatchObject({
      statusCode: 409,
      code: "CONFLICT",
    });
  });
});

// ── authenticate ─────────────────────────────────────────────────────────────

describe("AgentService.authenticate", () => {
  it("올바른 키 → agentId, environmentId 반환", async () => {
    const key = "valid-key";
    const pool = makePool(async (sql) => {
      if (/FROM agents/.test(sql)) return { rows: [{ id: 3, environment_id: 7 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const svc = new AgentService(pool);
    const result = await svc.authenticate(key);
    expect(result).toMatchObject({ agentId: 3, environmentId: 7 });
  });

  it("잘못된 키 → null", async () => {
    const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
    const svc = new AgentService(pool);
    const result = await svc.authenticate("wrong-key");
    expect(result).toBeNull();
  });
});

// ── recordHeartbeat ───────────────────────────────────────────────────────────

describe("AgentService.recordHeartbeat", () => {
  it("currentJobId 없으면 빈 객체 반환", async () => {
    const pool = makePool(async () => ({ rows: [], rowCount: 1 }));
    const svc = new AgentService(pool);
    const result = await svc.recordHeartbeat(1);
    expect(result).toEqual({});
  });

  it("currentJobId 있고 deployment 상태 cancelled → deploymentCancelled: true", async () => {
    const pool = makePool(async (sql) => {
      if (/UPDATE agents/.test(sql)) return { rows: [], rowCount: 1 };
      if (/FROM deployments/.test(sql)) return { rows: [{ status: "cancelled" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const svc = new AgentService(pool);
    const result = await svc.recordHeartbeat(1, "42");
    expect(result).toEqual({ deploymentCancelled: true });
  });

  it("currentJobId 있고 deployment 상태 deploying → deploymentCancelled 없음", async () => {
    const pool = makePool(async (sql) => {
      if (/UPDATE agents/.test(sql)) return { rows: [], rowCount: 1 };
      if (/FROM deployments/.test(sql)) return { rows: [{ status: "deploying" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const svc = new AgentService(pool);
    const result = await svc.recordHeartbeat(1, "42");
    expect(result).toEqual({});
  });

  it("currentJobId 있지만 deployment 없으면 빈 객체", async () => {
    const pool = makePool(async (sql) => {
      if (/UPDATE agents/.test(sql)) return { rows: [], rowCount: 1 };
      if (/FROM deployments/.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const svc = new AgentService(pool);
    const result = await svc.recordHeartbeat(1, "99");
    expect(result).toEqual({});
  });
});
