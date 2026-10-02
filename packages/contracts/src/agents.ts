/**
 * packages/contracts/src/agents.ts
 *   POST /environments/:id/agent-registration-token  → 등록 토큰 발급
 *   POST /agents/register                            → 장기 인증키 발급
 *   POST /agents/heartbeat                           → online 상태 유지
 */

import { z } from "zod";
import { IdStringSchema, IsoDateTimeSchema } from "./common.js";

// ── POST /environments/:id/agent-registration-token ─────────────────────────

export const IssueAgentRegistrationTokenResponseSchema = z.object({
  token: z.string(),           // plain text, 1회만 반환.
  expiresAt: IsoDateTimeSchema,
}).strict();
export type IssueAgentRegistrationTokenResponse = z.infer<typeof IssueAgentRegistrationTokenResponseSchema>;

// ── POST /agents/register ───────────────────────────────────────────────────

export const RegisterAgentBodySchema = z.object({
  registrationToken: z.string().min(1),
});
export type RegisterAgentBody = z.input<typeof RegisterAgentBodySchema>;

export const RegisterAgentResponseSchema = z.object({
  agentId: IdStringSchema,
  longLivedKey: z.string(),    // Bearer 토큰으로 쓸 긴 랜덤 문자열. 1회만 반환.
  environmentId: IdStringSchema,
}).strict();
export type RegisterAgentResponse = z.infer<typeof RegisterAgentResponseSchema>;

// ── POST /agents/heartbeat ──────────────────────────────────────────────────

export const AgentRuntimeReportSchema = z.object({
  deploymentId: IdStringSchema,
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  status: z.enum(["running", "stopped"]),
  health: z.enum(["healthy", "unhealthy", "unknown"]),
}).strict();
export type AgentRuntimeReport = z.infer<typeof AgentRuntimeReportSchema>;

export const AgentHeartbeatBodySchema = z.object({
  /** Agent 가 현재 실행 중인 Job (있으면). */
  currentJobId: IdStringSchema.optional(),
  /** Agent가 실제로 유지 중인 Compose·Tunnel 런타임 목록. */
  runtimes: z.array(AgentRuntimeReportSchema).max(100).default([]),
}).strict();
export type AgentHeartbeatBody = z.input<typeof AgentHeartbeatBodySchema>;

export const AgentHeartbeatResponseSchema = z.object({
  ok: z.literal(true),
  /** 현재 실행 중 Job 이 취소된 deployment 에 속해있으면 true. Agent 가 즉시 중단해야 함. */
  deploymentCancelled: z.boolean().optional(),
  /** Control Plane DB에서 계속 유지할 수 있는 것으로 확인된 보고 런타임. */
  desiredDeploymentIds: z.array(IdStringSchema),
}).strict();
export type AgentHeartbeatResponse = z.infer<typeof AgentHeartbeatResponseSchema>;
