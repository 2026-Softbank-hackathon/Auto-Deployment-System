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
 * Postgres BIGINT 값 (environments · secrets 의 id/projectId 등).
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
  "TARGET_ENVIRONMENT_REQUIRED",
  "AWS_REGISTRY_ENVIRONMENT_REQUIRED",
  "PROJECT_DEPLOYMENT_IN_PROGRESS",
  "PROJECT_DELETING",
  "SUBDOMAIN_TAKEN",
  "ADDRESS_CHANGE_IN_PROGRESS",
  "ADDRESS_CHANGE_STATIC_UNSUPPORTED",
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

/**
 * `?projectId=<N>` 생략 가능 쿼리 (secrets · environments, #215).
 * 생략하면 공용 연결(프로젝트 없이 등록한 연결 · 시크릿) 대상.
 */
export const OptionalProjectIdQuerySchema = z.object({
  projectId: z.coerce.number().int().positive().optional(),
});
export type OptionalProjectIdQuery = z.input<typeof OptionalProjectIdQuerySchema>;

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
export const TARGET_PROFILES = ["aws-ecs-basic", "aws-lambda-basic", "onprem-docker-basic"] as const;
export const TargetProfileSchema = z.enum(TARGET_PROFILES);
export type TargetProfile = z.infer<typeof TargetProfileSchema>;

/** POST /deployments 요청의 target — 사용자는 벤더까지만 선택, 서버가 default profile 매핑 */
export const TARGET_VENDORS = ["aws", "onprem"] as const;
export const TargetVendorSchema = z.enum(TARGET_VENDORS);
export type TargetVendor = z.infer<typeof TargetVendorSchema>;

/**
 * 배포 형태 — 기본은 컨테이너, 서버리스(AWS Lambda)는 고급 설정에서 고를 때만.
 * 앱(프로젝트)에 저장돼 재배포 · 롤백 · 환경 전환이 같은 형태를 유지한다. 온프레미스는 형태와 관계없이 컨테이너.
 */
export const DEPLOY_MODES = ["container", "serverless"] as const;
export const DeployModeSchema = z.enum(DEPLOY_MODES);
export type DeployMode = z.infer<typeof DeployModeSchema>;

/** 승인 게이트. patch = 코드 수정안(SQLite → PostgreSQL, #277) */
export const ApprovalGateSchema = z.enum(["patch", "target", "plan"]);
export type ApprovalGate = z.infer<typeof ApprovalGateSchema>;
