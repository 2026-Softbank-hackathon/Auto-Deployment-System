/**
 * apps/api/src/services/agent-service.ts
 * Agent 등록·인증·Heartbeat 서비스 (민서 요구사항 #1·#6).
 *
 * 토큰 hash: sha256(plain) hex — bcrypt 는 overhead 크고 Agent 재사용 많음
 * 트랜잭션: register 는 BEGIN/COMMIT 안에서 토큰 consume + Agent INSERT 원자적
 */

import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "@camellia/db";
import type { AgentRuntimeReport } from "@camellia/contracts";
import { ApiError } from "../plugins/error-handler.js";

function sha256hex(plain: string): string {
  return createHash("sha256").update(plain).digest("hex");
}

export interface IssueRegistrationTokenResult {
  token: string;
  expiresAt: string; // ISO 8601
}

export interface RegisterAgentResult {
  agentId: string;
  longLivedKey: string;
  environmentId: string;
}

export interface AuthenticateResult {
  agentId: number;
  environmentId: number;
}

export class AgentService {
  constructor(private readonly pool: Pool) {}

  /** 1회용 등록 토큰 발급 (10분 유효). environment 존재 확인 포함. */
  async issueRegistrationToken(environmentId: number): Promise<IssueRegistrationTokenResult> {
    const envCheck = await this.pool.query(
      `SELECT 1 FROM environments WHERE id = $1`,
      [environmentId],
    );
    if ((envCheck.rowCount ?? 0) === 0) {
      throw new ApiError(404, "NOT_FOUND", `환경 ID ${environmentId}를 찾을 수 없습니다.`);
    }

    const plain = randomBytes(32).toString("hex");
    const hash = sha256hex(plain);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await this.pool.query(
      `INSERT INTO agent_registration_tokens (environment_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [environmentId, hash, expiresAt],
    );

    return { token: plain, expiresAt: expiresAt.toISOString() };
  }

  /** 등록 토큰 소비 → 장기 인증키 발급. 트랜잭션 안에서 원자적으로 처리. */
  async register(registrationToken: string): Promise<RegisterAgentResult> {
    const hash = sha256hex(registrationToken);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // 토큰 조회: 유효하고 미사용인 것만
      const tokenRes = await client.query<{
        id: number;
        environment_id: number;
        expires_at: Date;
        consumed_at: Date | null;
      }>(
        `SELECT id, environment_id, expires_at, consumed_at
         FROM agent_registration_tokens
         WHERE token_hash = $1
         FOR UPDATE`,
        [hash],
      );

      const tokenRow = tokenRes.rows[0];
      if (!tokenRow) {
        throw new ApiError(400, "VALIDATION_ERROR", "유효하지 않은 등록 토큰입니다.");
      }
      if (tokenRow.consumed_at !== null) {
        throw new ApiError(400, "VALIDATION_ERROR", "이미 사용된 등록 토큰입니다.");
      }
      if (new Date(tokenRow.expires_at) < new Date()) {
        throw new ApiError(400, "VALIDATION_ERROR", "만료된 등록 토큰입니다.");
      }

      // 장기 키 생성
      const longLivedKey = randomBytes(32).toString("base64url");
      const longLivedKeyHash = sha256hex(longLivedKey);

      // Agent INSERT (environment 당 1대 — UNIQUE 제약으로 보호)
      let agentRow: { id: number; environment_id: number };
      try {
        const agentRes = await client.query<{ id: number; environment_id: number }>(
          `INSERT INTO agents (environment_id, long_lived_key_hash)
           VALUES ($1, $2)
           RETURNING id, environment_id`,
          [tokenRow.environment_id, longLivedKeyHash],
        );
        agentRow = agentRes.rows[0]!;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/unique|duplicate/i.test(msg)) {
          throw new ApiError(
            409,
            "CONFLICT",
            `환경 ID ${tokenRow.environment_id}에 이미 등록된 Agent 가 있습니다.`,
          );
        }
        throw e;
      }

      // 토큰 consume
      await client.query(
        `UPDATE agent_registration_tokens
         SET consumed_at = now(), consumed_by_agent_id = $1
         WHERE id = $2`,
        [agentRow.id, tokenRow.id],
      );

      await client.query("COMMIT");

      return {
        agentId: String(agentRow.id),
        longLivedKey,
        environmentId: String(agentRow.environment_id),
      };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  /** Bearer 토큰으로 Agent 인증. 없으면 null 반환. */
  async authenticate(longLivedKey: string): Promise<AuthenticateResult | null> {
    const hash = sha256hex(longLivedKey);
    const res = await this.pool.query<{ id: number; environment_id: number }>(
      `SELECT id, environment_id FROM agents WHERE long_lived_key_hash = $1`,
      [hash],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { agentId: row.id, environmentId: row.environment_id };
  }

  /** Agent 생존 시각과 실제 런타임 목록을 갱신하고, DB가 유지 대상으로 인정한 배포를 돌려준다. */
  async recordHeartbeat(
    agentId: number,
    environmentId: number,
    runtimes: AgentRuntimeReport[],
  ): Promise<string[]> {
    await this.pool.query(
      `UPDATE agents
       SET last_seen_at = now(), runtime_inventory = $2::jsonb
       WHERE id = $1`,
      [agentId, JSON.stringify(runtimes)],
    );
    if (runtimes.length === 0) return [];
    const deploymentIds = runtimes.map((runtime) => runtime.deploymentId);
    // cleanup row가 없으면 active 후보, 아직 한 번도 실행되지 않은 미래 cleanup이면 standby다.
    // cleanup 시각 도달·claim·재시도 이후에는 desired에서 제외해 Agent 재연결 때도 정리한다.
    const desired = await this.pool.query<{ id: number | string }>(
      `SELECT deployment.id
       FROM deployments AS deployment
       LEFT JOIN onprem_agent_cleanup_jobs AS cleanup
         ON cleanup.deployment_id = deployment.id
       WHERE deployment.target_environment_id = $1
         AND deployment.id = ANY($2::bigint[])
         AND deployment.status IN ('deploying', 'verifying', 'rollback', 'succeeded')
         AND (
           cleanup.deployment_id IS NULL
           OR (
             cleanup.status = 'pending'
             AND cleanup.attempt = 0
             AND cleanup.available_at > NOW()
           )
         )
       ORDER BY deployment.id`,
      [environmentId, deploymentIds],
    );
    return desired.rows.map((row) => String(row.id));
  }
}
