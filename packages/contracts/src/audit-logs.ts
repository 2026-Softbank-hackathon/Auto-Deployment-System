/**
 * packages/contracts/src/audit-logs.ts
 * LOG-03 감사 로그 API 계약 (GET /api/v1/audit-logs).
 */

import { z } from "zod";
import { IsoDateTimeSchema } from "./common.js";

// ── 단일 감사 로그 항목 ────────────────────────────────────────────────────────

export const AuditLogSchema = z.object({
  id: z.string(),                          // BIGSERIAL → string
  actorType: z.enum(["session", "agent", "system"]),
  actorId: z.string().nullable(),          // session_id or agent_id (system 이면 null)
  action: z.string(),                      // e.g., "POST /deployments"
  resourceType: z.string().nullable(),     // e.g., "deployment"
  resourceId: z.string().nullable(),       // e.g., "42"
  statusCode: z.number().int(),
  requestId: z.string(),
  metadata: z.record(z.unknown()).nullable(),
  createdAt: IsoDateTimeSchema,
}).strict();
export type AuditLog = z.infer<typeof AuditLogSchema>;

// ── GET /api/v1/audit-logs 쿼리 파라미터 ─────────────────────────────────────

export const AuditLogsQuerySchema = z.object({
  /** actor_type:actor_id 형식. 예: "session:abc123" */
  actor: z.string().optional(),
  /** resource_type:resource_id 형식. 예: "deployment:42" */
  resource: z.string().optional(),
  /** action prefix 필터. 예: "POST" */
  action: z.string().optional(),
  /** 최대 반환 수 (기본 50, 최대 200) */
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** 커서 (이전 응답의 nextCursor) */
  cursor: z.string().optional(),
}).strict();
export type AuditLogsQuery = z.input<typeof AuditLogsQuerySchema>;

// ── GET /api/v1/audit-logs 응답 ───────────────────────────────────────────────

export const AuditLogListResponseSchema = z.object({
  items: z.array(AuditLogSchema),
  nextCursor: z.string().nullable(),
}).strict();
export type AuditLogListResponse = z.infer<typeof AuditLogListResponseSchema>;
