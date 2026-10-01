/**
 * packages/contracts/src/deployments.ts
 *   POST  /deployments                       (multipart) → 202 CreateDeploymentResponse
 *   GET   /deployments/:id                               → 200 Deployment
 *   GET   /deployments/:id/ir                            → 200 IrVersion
 *   PATCH /deployments/:id/ir                            → 200 IrVersion
 *   POST  /deployments/:id/missing-resources             → 200 SubmitMissingResourcesResponse
 *   POST  /deployments/:id/approvals                     → 200 SubmitApprovalResponse
 *   GET   /deployments/:id/analysis-report               → 200 AnalysisReport
 *   GET   /deployments/:id/logs?step=&tail=              → 200 text/plain (string) · 로그 없으면 204 빈 바디
 *   GET   /deployments/:id/health                        → 200 DeploymentHealth
 *   GET   /deployments/:id/diagnosis                     → 200 Diagnosis
 *   GET   /deployments/:id/ai-usage                      → 200 AiUsage
 *   GET   /deployments/:id/events                        → SSE (events.ts)
 *
 * `:id` 는 IdParamsSchema (common.ts).
 */

import { z } from "zod";
import {
  ApprovalGateSchema,
  DeploymentStatusSchema,
  IdStringSchema,
  IsoDateTimeSchema,
  type TargetProfile,
  type TargetVendor,
} from "./common.js";

// ── POST /deployments (multipart/form-data) ──────────────────────────────────

/**
 * multipart 필드. Zod 로 parse 하지 않고 라우트가 직접 검사한다 (문서 · 타입용).
 * 프론트: `FormData` 에 source(zip, 최대 100MB) · project_id · target 을 넣어 보낸다.
 * target 은 벤더 (aws/onprem), 서버가 default profile 매핑.
 */
export type CreateDeploymentFields = {
  source: Blob;
  project_id: string | number;
  target: TargetVendor;
};

export const CreateDeploymentResponseSchema = z
  .object({
    deploymentId: IdStringSchema,
    status: z.literal("received"),
    /** 예: "/api/v1/deployments/42/events" */
    eventsUrl: z.string(),
  })
  .strict();
export type CreateDeploymentResponse = z.infer<typeof CreateDeploymentResponseSchema>;

// ── GET /deployments/:id ──────────────────────────────────────────────────────

export const DeploymentSchema = z
  .object({
    id: IdStringSchema,
    projectId: IdStringSchema,
    status: DeploymentStatusSchema,
    targetProfile: z.string().nullable(),
    targetEnvironmentId: IdStringSchema.nullable(),
    registryEnvironmentId: IdStringSchema.nullable(),
    publicUrl: z.string().nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    succeededAt: IsoDateTimeSchema.nullable(),
    failedAt: IsoDateTimeSchema.nullable(),
    error: z.string().nullable(),
    /** 실행 중(running) 단계. 없으면 `{ name: null, startedAt: null }` (finishedAt 없음) */
    currentStep: z.union([
      z
        .object({ name: z.string(), startedAt: IsoDateTimeSchema, finishedAt: IsoDateTimeSchema.nullable() })
        .strict(),
      z.object({ name: z.null(), startedAt: z.null() }).strict(),
    ]),
    /** 결정 대기 중인 승인. expiresAt = createdAt + 30분 */
    approvalPending: z
      .object({ gate: ApprovalGateSchema, createdAt: IsoDateTimeSchema, expiresAt: IsoDateTimeSchema })
      .strict()
      .nullable(),
  })
  .strict();
export type Deployment = z.infer<typeof DeploymentSchema>;

// ── IR ────────────────────────────────────────────────────────────────────────

/** GET · PATCH /deployments/:id/ir 응답. ir 은 IR JSON (형태는 @camellia/ir-schema 의 IrSchema) */
export const IrVersionSchema = z
  .object({
    deploymentId: IdStringSchema,
    ir: z.record(z.unknown()),
    /** 1부터 시작하는 배포 내 IR 버전 (PATCH 요청의 version 과 같은 number) */
    version: z.number().int(),
    generatedAt: IsoDateTimeSchema,
    /** "analyzer" | "ai_filled" | "analyzer_cache" | "user_edited" */
    source: z.string(),
  })
  .strict();
export type IrVersion = z.infer<typeof IrVersionSchema>;

export const PatchIrBodySchema = z.object({
  /** 현재 IR 에 deep merge 할 부분 IR (배열은 통째로 교체) */
  ir: z.record(z.string(), z.unknown()),
  /** GET /ir 로 받은 현재 version (낙관적 잠금) */
  version: z.number().int(),
});
export type PatchIrBody = z.input<typeof PatchIrBodySchema>;

// ── POST /deployments/:id/missing-resources ─────────────────────────────────

export const MissingResourceDecisionSchema = z.object({
  resource: z.string().min(1),
  action: z.enum(["exclude", "add_module"]),
  moduleId: z.string().optional(),
});
export type MissingResourceDecision = z.input<typeof MissingResourceDecisionSchema>;

export const SubmitMissingResourcesBodySchema = z.object({
  decisions: z.array(MissingResourceDecisionSchema).min(1),
});
export type SubmitMissingResourcesBody = z.input<typeof SubmitMissingResourcesBodySchema>;

export const SubmitMissingResourcesResponseSchema = z
  .object({
    deploymentId: IdStringSchema,
    resolved: z.number().int(),
    remaining: z.number().int(),
    updatedIr: z.record(z.unknown()),
  })
  .strict();
export type SubmitMissingResourcesResponse = z.infer<typeof SubmitMissingResourcesResponseSchema>;

// ── POST /deployments/:id/approvals ──────────────────────────────────────────

export const SubmitApprovalBodySchema = z.object({
  gate: ApprovalGateSchema,
  decision: z.enum(["approve", "reject"]),
  note: z.string().max(500).optional(),
});
export type SubmitApprovalBody = z.input<typeof SubmitApprovalBodySchema>;

export const SubmitApprovalResponseSchema = z
  .object({
    deploymentId: IdStringSchema,
    gate: ApprovalGateSchema,
    decision: z.enum(["approve", "reject"]),
    /** approve: target → queued, plan → provisioning / reject: failed */
    newStatus: DeploymentStatusSchema,
    /** gate=target 일 때만 있음 (env_lock 획득 여부) */
    lockAcquired: z.boolean().optional(),
  })
  .strict();
export type SubmitApprovalResponse = z.infer<typeof SubmitApprovalResponseSchema>;

// ── GET /deployments/:id/analysis-report ─────────────────────────────────────

export const AnalysisReportSchema = z
  .object({
    /** 주의: 이 응답은 deploymentId 가 number */
    deploymentId: z.number().int(),
    detectedStack: z.array(z.string()),
    services: z.array(z.unknown()),
    resources: z.array(z.unknown()),
    warnings: z.array(z.unknown()),
    unresolved: z.array(z.unknown()),
    irValid: z.boolean(),
    irErrors: z.array(z.unknown()).nullable(),
    migrationTool: z.string().nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type AnalysisReport = z.infer<typeof AnalysisReportSchema>;

// ── GET /deployments/:id/logs ─────────────────────────────────────────────────

export const LOG_STEPS = ["analyze", "build", "provision", "verify"] as const;

/** 응답은 JSON 이 아니라 text/plain 문자열. 로그가 없으면 204 (빈 바디). stream=true 는 400 NOT_IMPLEMENTED */
export const DeploymentLogsQuerySchema = z.object({
  step: z.enum(LOG_STEPS),
  tail: z.coerce.number().int().positive().optional(),
  stream: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .optional()
    .default(false)
    .transform((v) => v === true || v === "true"),
});
export type DeploymentLogsQuery = z.input<typeof DeploymentLogsQuerySchema>;

// ── GET /deployments/:id/health ───────────────────────────────────────────────

export const HealthCheckSchema = z
  .object({
    attempt: z.number().int(),
    timestamp: IsoDateTimeSchema,
    statusCode: z.number().int().optional(),
    latencyMs: z.number().int().optional(),
    passed: z.boolean(),
    error: z.string().optional(),
  })
  .strict();
export type HealthCheck = z.infer<typeof HealthCheckSchema>;

export const DeploymentHealthSchema = z
  .object({
    deploymentId: IdStringSchema,
    status: z.enum(["checking", "passed", "failed"]),
    checks: z.array(HealthCheckSchema),
    consecutivePassed: z.number().int(),
    requiredPasses: z.literal(3),
    /** public URL 이 없으면 빈 문자열 */
    targetUrl: z.string(),
  })
  .strict();
export type DeploymentHealth = z.infer<typeof DeploymentHealthSchema>;

// ── GET /deployments/:id/diagnosis ────────────────────────────────────────────

export const PatchCandidateSchema = z
  .object({
    description: z.string(),
    /** unified diff */
    diff: z.string(),
  })
  .strict();
export type PatchCandidate = z.infer<typeof PatchCandidateSchema>;

export const DiagnosisSchema = z
  .object({
    /** 주의: 이 응답은 deploymentId 가 number */
    deploymentId: z.number().int(),
    failedStep: z.string().nullable(),
    summary: z.string(),
    patchCandidates: z.array(PatchCandidateSchema),
    generatedAt: IsoDateTimeSchema,
  })
  .strict();
export type Diagnosis = z.infer<typeof DiagnosisSchema>;

// ── GET /deployments/:id/ai-usage ─────────────────────────────────────────────

export const AiUsageBreakdownSchema = z
  .object({
    model: z.string(),
    tokenIn: z.number(),
    tokenOut: z.number(),
    costUsd: z.number(),
  })
  .strict();
export type AiUsageBreakdown = z.infer<typeof AiUsageBreakdownSchema>;

export const AiUsageSchema = z
  .object({
    /** 주의: 이 응답은 deploymentId 가 number */
    deploymentId: z.number().int(),
    totalTokenIn: z.number(),
    totalTokenOut: z.number(),
    totalCostUsd: z.number(),
    breakdown: z.array(AiUsageBreakdownSchema),
  })
  .strict();
export type AiUsage = z.infer<typeof AiUsageSchema>;
