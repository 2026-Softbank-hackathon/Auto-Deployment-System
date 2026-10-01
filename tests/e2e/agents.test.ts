/**
 * tests/e2e/agents.test.ts
 *
 * Agent 등록·인증 + Heartbeat — 실 Postgres E2E 테스트
 *
 * 검증 포인트:
 *   1. 등록 토큰 발급 + 소비 흐름 (트랜잭션 원자성, token consume, last_seen_at 갱신)
 *   2. UNIQUE 제약 catch — 같은 environment 에 두 번째 register → 409
 *   3. FOR UPDATE 락 — 동시 register 두 번 → 하나만 성공
 *   4. sha256 hash lookup — longLivedKey 로 heartbeat → 200 + DB last_seen_at 갱신
 *   5. 만료 토큰 거부 → 400
 *   6. 이미 consumed 토큰 재사용 → 400
 */

import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import PgBoss from "pg-boss";
import { createPool, type Pool } from "@camellia/db";
import { LocalStorage } from "@camellia/storage";
import { buildServer } from "../../apps/api/src/server.js";
import type { FastifyInstance } from "fastify";

// setup.ts globalSetup 이 DATABASE_URL 을 camellia_e2e 로 교체한다.
const E2E_DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgres://camellia:camellia@localhost:5433/camellia";

function sha256hex(plain: string): string {
  return createHash("sha256").update(plain).digest("hex");
}

const describeWithPostgres =
  process.env["SKIP_E2E"] === "true" ? describe.skip : describe;

describeWithPostgres("Agent 등록·인증 + Heartbeat 실 Postgres E2E", () => {
  let pool: Pool;
  let boss: PgBoss;
  let server: FastifyInstance;
  let storageTmp: string;

  let projectId: number;
  let environmentId: number;

  // ── suite setup / teardown ─────────────────────────────────────────────────

  beforeAll(async () => {
    pool = createPool(E2E_DATABASE_URL);
    boss = new PgBoss({ connectionString: E2E_DATABASE_URL });
    storageTmp = await fs.mkdtemp(path.join(os.tmpdir(), "camellia-agents-e2e-"));
    const storage = new LocalStorage({ rootDir: storageTmp });

    server = await buildServer({
      pool,
      boss,
      storage,
      nodeEnv: "test",
      logger: false,
      enablePgListener: false,
    });

    // boss.start() 는 pg-boss 내부 테이블 생성에 필요.
    // 테스트 대상 경로(agents)에서는 실제로 boss 를 쓰지 않으므로 실패해도 무시.
    await boss.start().catch(() => {});
    await server.ready();

    // project + environment 생성 (suite 전체에서 공유)
    const projRes = await pool.query<{ id: string }>(
      `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
      [`agents-e2e-${crypto.randomUUID()}`],
    );
    projectId = Number(projRes.rows[0]!.id);

    const envRes = await pool.query<{ id: string }>(
      `INSERT INTO environments (project_id, name, type) VALUES ($1, $2, 'onprem') RETURNING id`,
      [projectId, `agents-e2e-env-${crypto.randomUUID()}`],
    );
    environmentId = Number(envRes.rows[0]!.id);
  });

  afterAll(async () => {
    // project CASCADE → environments, agents, agent_registration_tokens 모두 삭제
    if (projectId) {
      await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
    }
    await server?.close();
    await boss?.stop({ graceful: false });
    await pool?.end();
    await fs.rm(storageTmp, { recursive: true, force: true });
  });

  // ── per-test cleanup ───────────────────────────────────────────────────────

  afterEach(async () => {
    await pool.query(
      `DELETE FROM deployments WHERE project_id = $1`,
      [projectId],
    );
    // agents 와 agent_registration_tokens 는 FK 관계이므로 tokens 를 먼저 삭제
    await pool.query(
      `DELETE FROM agent_registration_tokens WHERE environment_id = $1`,
      [environmentId],
    );
    await pool.query(
      `DELETE FROM agents WHERE environment_id = $1`,
      [environmentId],
    );
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  async function issueToken(): Promise<{ token: string; expiresAt: string }> {
    const res = await server.inject({
      method: "POST",
      url: `/api/v1/environments/${environmentId}/agent-registration-token`,
    });
    if (res.statusCode !== 201) {
      throw new Error(`토큰 발급 실패: ${res.statusCode} ${res.body}`);
    }
    return res.json<{ token: string; expiresAt: string }>();
  }

  async function register(token: string): Promise<{ statusCode: number; body: string }> {
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/agents/register",
      payload: { registrationToken: token },
    });
    return { statusCode: res.statusCode, body: res.body };
  }

  // ── 테스트 1: 등록 토큰 발급 → register → heartbeat 전체 흐름 ──────────────

  it("등록 토큰 발급 → register (트랜잭션) → heartbeat 전체 흐름", async () => {
    // 1. 토큰 발급
    const { token } = await issueToken();
    expect(typeof token).toBe("string");

    // 2. register
    const regRes = await server.inject({
      method: "POST",
      url: "/api/v1/agents/register",
      payload: { registrationToken: token },
    });
    expect(regRes.statusCode).toBe(201);
    const { longLivedKey, agentId, environmentId: retEnvId } = regRes.json<{
      longLivedKey: string;
      agentId: string;
      environmentId: string;
    }>();
    expect(typeof longLivedKey).toBe("string");
    expect(String(retEnvId)).toBe(String(environmentId));

    // 3. DB 직접 조회 — 토큰이 consume 됐는지 확인
    const tokenHash = sha256hex(token);
    const tokenRows = await pool.query<{ consumed_at: Date | null; consumed_by_agent_id: number | null }>(
      `SELECT consumed_at, consumed_by_agent_id FROM agent_registration_tokens WHERE token_hash = $1`,
      [tokenHash],
    );
    expect(tokenRows.rows).toHaveLength(1);
    expect(tokenRows.rows[0]!.consumed_at).not.toBeNull();
    expect(String(tokenRows.rows[0]!.consumed_by_agent_id)).toBe(agentId);

    // 4. DB 직접 조회 — agents 테이블에 long_lived_key_hash 저장됐는지 확인
    const keyHash = sha256hex(longLivedKey);
    const agentRows = await pool.query<{ id: number; long_lived_key_hash: string }>(
      `SELECT id, long_lived_key_hash FROM agents WHERE id = $1`,
      [Number(agentId)],
    );
    expect(agentRows.rows).toHaveLength(1);
    expect(agentRows.rows[0]!.long_lived_key_hash).toBe(keyHash);

    // 5. heartbeat
    const hbRes = await server.inject({
      method: "POST",
      url: "/api/v1/agents/heartbeat",
      headers: { authorization: `Bearer ${longLivedKey}` },
      payload: {},
    });
    expect(hbRes.statusCode).toBe(200);
    const hbBody = hbRes.json<{ ok: boolean }>();
    expect(hbBody.ok).toBe(true);

    // 6. DB 직접 조회 — last_seen_at 갱신됐는지 확인
    const seenRows = await pool.query<{ last_seen_at: Date | null }>(
      `SELECT last_seen_at FROM agents WHERE id = $1`,
      [Number(agentId)],
    );
    expect(seenRows.rows[0]!.last_seen_at).not.toBeNull();
  });

  // ── 테스트 2: 같은 environment 에 두 번째 register → 409 CONFLICT ────────────

  it("같은 environment 에 두 번째 register 시도 → 409 CONFLICT (UNIQUE 제약)", async () => {
    // 첫 번째 등록 성공
    const { token: token1 } = await issueToken();
    const reg1 = await server.inject({
      method: "POST",
      url: "/api/v1/agents/register",
      payload: { registrationToken: token1 },
    });
    expect(reg1.statusCode).toBe(201);

    // 두 번째 토큰 발급 후 register → 이미 Agent 존재 → 409
    const { token: token2 } = await issueToken();
    const reg2 = await server.inject({
      method: "POST",
      url: "/api/v1/agents/register",
      payload: { registrationToken: token2 },
    });
    expect(reg2.statusCode).toBe(409);
    const body = reg2.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("CONFLICT");
  });

  // ── 테스트 3: FOR UPDATE 락 — 동시 register 두 번 → 하나만 성공 ────────────

  it("동시 register 두 번 (race) → 하나만 성공하고 하나는 4xx", async () => {
    // 두 개의 토큰을 미리 발급 (순차)
    const { token: tokenA } = await issueToken();
    const { token: tokenB } = await issueToken();

    // 동시에 register 두 번 실행
    const [resA, resB] = await Promise.all([
      server.inject({
        method: "POST",
        url: "/api/v1/agents/register",
        payload: { registrationToken: tokenA },
      }),
      server.inject({
        method: "POST",
        url: "/api/v1/agents/register",
        payload: { registrationToken: tokenB },
      }),
    ]);

    const statuses = [resA.statusCode, resB.statusCode].sort();
    // 201 하나, 409 하나 (FOR UPDATE + UNIQUE 제약으로 두 번째는 충돌)
    expect(statuses).toEqual([201, 409]);

    // DB 에 Agent 정확히 1개만 남아있어야 함
    const agentCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM agents WHERE environment_id = $1`,
      [environmentId],
    );
    expect(Number(agentCount.rows[0]!.count)).toBe(1);
  });

  // ── 테스트 4: 만료 토큰 거부 → 400 ────────────────────────────────────────

  it("만료된 토큰 (11분 전 발급) → 400 VALIDATION_ERROR", async () => {
    const { token } = await issueToken();
    const tokenHash = sha256hex(token);

    // expires_at 을 과거로 강제 설정
    await pool.query(
      `UPDATE agent_registration_tokens SET expires_at = now() - interval '11 minutes' WHERE token_hash = $1`,
      [tokenHash],
    );

    const res = await register(token);
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  // ── 테스트 5: 이미 consumed 토큰 재사용 → 400 ──────────────────────────────

  it("이미 consumed 된 토큰 재사용 → 400 VALIDATION_ERROR", async () => {
    const { token } = await issueToken();

    // 첫 번째 register: 성공
    const first = await register(token);
    expect(first.statusCode).toBe(201);

    // 두 번째 register (같은 토큰): consumed_at 이 이미 설정됨 → 400
    const second = await register(token);
    expect(second.statusCode).toBe(400);
    const body = JSON.parse(second.body) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  // ── 테스트 6: 잘못된 Bearer 토큰으로 heartbeat → 401 ───────────────────────

  it("존재하지 않는 longLivedKey 로 heartbeat → 401 UNAUTHORIZED", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/agents/heartbeat",
      headers: { authorization: "Bearer invalid-key-that-does-not-exist" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it("Job claim 후 heartbeat가 실제 lease를 갱신하고 취소를 반환한다", async () => {
    const { token } = await issueToken();
    const registration = await server.inject({
      method: "POST",
      url: "/api/v1/agents/register",
      payload: { registrationToken: token },
    });
    const { longLivedKey, agentId } = registration.json<{
      longLivedKey: string;
      agentId: string;
    }>();
    const deployment = await pool.query<{ id: string }>(
      `INSERT INTO deployments(project_id, status, target_environment_id)
       VALUES ($1, 'deploying', $2)
       RETURNING id`,
      [projectId, environmentId],
    );
    const deploymentId = Number(deployment.rows[0]!.id);
    await pool.query(
      `INSERT INTO onprem_agent_jobs(
         job_id, deployment_id, environment_id, status, payload
       ) VALUES ($1, $2, $3, 'pending', $4::jsonb)`,
      [
        String(deploymentId),
        deploymentId,
        environmentId,
        JSON.stringify({
          jobId: String(deploymentId),
          attempt: 1,
          deploymentId,
          environmentId: String(environmentId),
          plan: { target: "onprem" },
          image: { digest: `sha256:${"a".repeat(64)}` },
        }),
      ],
    );

    const claimed = await server.inject({
      method: "POST",
      url: "/api/v1/agents/jobs/claim",
      headers: { authorization: `Bearer ${longLivedKey}` },
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json<{ job: { jobId: string } }>().job.jobId).toBe(
      String(deploymentId),
    );

    const beforeHeartbeat = await pool.query<{
      status: string;
      lease_owner_id: string;
      lease_expires_at: Date;
    }>(
      `SELECT status, lease_owner_id, lease_expires_at
       FROM onprem_agent_jobs WHERE job_id = $1`,
      [String(deploymentId)],
    );
    expect(beforeHeartbeat.rows[0]!.status).toBe("claimed");
    expect(String(beforeHeartbeat.rows[0]!.lease_owner_id)).toBe(agentId);

    const heartbeat = await server.inject({
      method: "POST",
      url: "/api/v1/agents/heartbeat",
      headers: { authorization: `Bearer ${longLivedKey}` },
      payload: { currentJobId: String(deploymentId) },
    });
    expect(heartbeat.statusCode).toBe(200);
    expect(heartbeat.json()).toEqual({ ok: true });

    const afterHeartbeat = await pool.query<{
      status: string;
      lease_expires_at: Date;
    }>(
      `SELECT status, lease_expires_at
       FROM onprem_agent_jobs WHERE job_id = $1`,
      [String(deploymentId)],
    );
    expect(afterHeartbeat.rows[0]!.status).toBe("running");
    expect(afterHeartbeat.rows[0]!.lease_expires_at.getTime()).toBeGreaterThanOrEqual(
      beforeHeartbeat.rows[0]!.lease_expires_at.getTime(),
    );

    await pool.query(`UPDATE deployments SET status = 'cancelled' WHERE id = $1`, [
      deploymentId,
    ]);
    const cancelled = await server.inject({
      method: "POST",
      url: "/api/v1/agents/heartbeat",
      headers: { authorization: `Bearer ${longLivedKey}` },
      payload: { currentJobId: String(deploymentId) },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toEqual({ ok: true, deploymentCancelled: true });
  });
});
