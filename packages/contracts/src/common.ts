/**
 * packages/contracts/src/common.ts
 * 여러 리소스가 같이 쓰는 스키마 — 에러 바디 · ID · 날짜 · 배포 상태 · 대상 프로필.
 */

import { z } from "zod";

// ── 공통 값 ───────────────────────────────────────────────────────────────────

/** ISO 8601 날짜 문자열 (`Date.toISOString()`), 예: "2026-09-30T03:00:00.000Z" */
export const IsoDateTimeSchema = z.string().datetime();

/** 문자열 ID — projects · deployments 계열 응답은 ID 를 `String(id)` 로 보낸다. 예: "42" */
export const IdStringSchema = z.string().regex(/^\d+$/);

/**
 * Postgres BIGINT 값 (environments · secrets 의 id/projectId, IR version 등).
 * 서비스 코드의 타입은 number 지만, DB 에서 읽은 값은 pg 드라이버가 문자열로 돌려줘서
 * 실제 응답에는 "12" 같은 문자열로 나가는 경우가 있다 (요청 값을 그대로 돌려주는 경우는 number).
 * 정리 전까지 둘 다 허용한다 — 프론트는 `Number(x)` / `String(x)` 로 맞춰 쓴다.
 */
export const PgBigIntSchema = z.union([z.number().int(), z.string().regex(/^\d+$/)]);

// ── 에러 ──────────────────────────────────────────────────────────────────────

/** 모든 4xx/5xx 응답 바디: `{ error: { code, message, hint? }, requestId }` */
export const ErrorBodySchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        hint: z.string().optional(),
      })
      .strict(),
    requestId: z.string(),
  })
  .strict();
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

/** 현재 API 가 쓰는 error.code 값 (code 필드 자체는 string — 새 코드가 생길 수 있음) */
export const API_ERROR_CODES = [
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "CONFLICT",
  "UNAUTHORIZED",
  "INTERNAL_ERROR",
  "FILE_TOO_LARGE",
  "NOT_IMPLEMENTED",
  "IR_NOT_EDITABLE",
  "IR_VERSION_CONFLICT",
  "APPROVAL_GATE_NOT_PENDING",
  "DEPLOYMENT_LOCKED",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

// ── 공통 요청 ─────────────────────────────────────────────────────────────────

/** `/:id` 경로 파라미터 (프로젝트 · 배포 · 환경 ID) */
export const IdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});
export type IdParams = z.input<typeof IdParamsSchema>;

/** `?projectId=<N>` 쿼리 (secrets · environments) */
export const ProjectIdQuerySchema = z.object({
  projectId: z.coerce.number().int().positive(),
});
export type ProjectIdQuery = z.input<typeof ProjectIdQuerySchema>;

// ── 배포 상태 · 프로필 ────────────────────────────────────────────────────────

/** v5.4.1 배포 상태 (apps/worker/src/state-machine.ts STATUSES 와 같은 목록 — 워커 테스트가 확인) */
export const DEPLOYMENT_STATUSES = [
  "received",
  "analyzing",
  "awaiting_patch_approval",
  "awaiting_target_confirmation",
  "queued",
  "building",
  "planning",
  "awaiting_plan_approval",
  "provisioning",
  "deploying",
  "verifying",
  "succeeded",
  "failed",
  "cancelled",
  "rejected",
  "rollback",
] as const;
export const DeploymentStatusSchema = z.enum(DEPLOYMENT_STATUSES);
export type DeploymentStatus = z.infer<typeof DeploymentStatusSchema>;

/** 배포 대상 프로필 (POST /deployments 의 target) */
export const TARGET_PROFILES = ["aws-ecs-basic", "onprem-docker-basic"] as const;
export const TargetProfileSchema = z.enum(TARGET_PROFILES);
export type TargetProfile = z.infer<typeof TargetProfileSchema>;

/** 승인 게이트 */
export const ApprovalGateSchema = z.enum(["target", "plan"]);
export type ApprovalGate = z.infer<typeof ApprovalGateSchema>;
