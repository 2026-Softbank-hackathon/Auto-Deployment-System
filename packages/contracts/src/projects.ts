/**
 * packages/contracts/src/projects.ts
 *   POST /projects                  → 201 Project
 *   GET  /projects                  → 200 ProjectList
 *   GET  /projects/:id              → 200 Project
 *   GET  /projects/:id/deployments  → 200 ProjectDeploymentList (최신순 · 커서)
 *   DELETE /projects/:id            → 202 DeleteProjectResponse (리소스 정리를 시작, #247)
 */

import { z } from "zod";
import {
  DeploymentStatusSchema,
  IdStringSchema,
  IsoDateTimeSchema,
  TargetVendorSchema,
} from "./common.js";

// ── 요청 ──────────────────────────────────────────────────────────────────────

export const CreateProjectBodySchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});
export type CreateProjectBody = z.input<typeof CreateProjectBodySchema>;

export const ListProjectsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListProjectsQuery = z.input<typeof ListProjectsQuerySchema>;

export const ListProjectDeploymentsQuerySchema = z.object({
  cursor: z.string().regex(/^\d+$/, "cursor는 배포 ID(숫자)여야 합니다.").transform(Number).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.string().min(1).optional(),
});
export type ListProjectDeploymentsQuery = z.input<typeof ListProjectDeploymentsQuerySchema>;

// ── 응답 ──────────────────────────────────────────────────────────────────────

/** 배포 대상 환경의 종류. 환경 없이 만든 옛 배포는 null */
const DeploymentEnvironmentTypeSchema = TargetVendorSchema.nullable();

/**
 * 지금 프로젝트 주소(service-{projectId}.{domain})로 서비스 중인 배포.
 * 가장 최근에 성공(succeeded)한 배포 하나 — 성공한 배포가 없으면 Project.live 가 null.
 */
export const ProjectLiveDeploymentSchema = z
  .object({
    deploymentId: IdStringSchema,
    environmentId: IdStringSchema.nullable(),
    environmentType: DeploymentEnvironmentTypeSchema,
    environmentName: z.string().nullable(),
    /** 프로젝트 공유 주소. 서버에 플랫폼 도메인 설정이 없으면 null */
    publicUrl: z.string().nullable(),
    succeededAt: IsoDateTimeSchema.nullable(),
  })
  .strict();
export type ProjectLiveDeployment = z.infer<typeof ProjectLiveDeploymentSchema>;

/** 상태와 상관없이 가장 최근에 만든 배포. 배포가 없으면 Project.latest 가 null */
export const ProjectLatestDeploymentSchema = z
  .object({
    deploymentId: IdStringSchema,
    status: DeploymentStatusSchema,
    environmentType: DeploymentEnvironmentTypeSchema,
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type ProjectLatestDeployment = z.infer<typeof ProjectLatestDeploymentSchema>;

/** 앱 삭제 진행 상태 — 정리가 끝나면 프로젝트 자체가 사라진다 */
export const PROJECT_DELETION_STATUSES = ["deleting", "failed"] as const;
export const ProjectDeletionStatusSchema = z.enum(PROJECT_DELETION_STATUSES);
export type ProjectDeletionStatus = z.infer<typeof ProjectDeletionStatusSchema>;

/**
 * 자동으로 정리하지 못해 사용자가 직접 해야 하는 일.
 * ONPREM_MANUAL_CLEANUP: 온프레미스에서 돌던 컨테이너는 Agent 가 지우지 못해 직접 내려야 한다.
 */
export const PROJECT_DELETION_WARNINGS = ["ONPREM_MANUAL_CLEANUP"] as const;
export const ProjectDeletionWarningSchema = z.enum(PROJECT_DELETION_WARNINGS);
export type ProjectDeletionWarning = z.infer<typeof ProjectDeletionWarningSchema>;

export const ProjectDeletionSchema = z
  .object({
    status: ProjectDeletionStatusSchema,
    requestedAt: IsoDateTimeSchema,
    /** status=failed 일 때 실패 이유 (오류 코드 + 상세). 진행 중이면 null */
    error: z.string().nullable(),
    warnings: z.array(ProjectDeletionWarningSchema),
  })
  .strict();
export type ProjectDeletion = z.infer<typeof ProjectDeletionSchema>;

export const ProjectSchema = z
  .object({
    id: IdStringSchema,
    name: z.string(),
    /** DB 값이 null 이면 필드 자체가 없다 */
    description: z.string().optional(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    /** 지금 서비스 중인 배포 (POST /projects 응답은 항상 null) */
    live: ProjectLiveDeploymentSchema.nullable(),
    /** 가장 최근 배포 (POST /projects 응답은 항상 null) */
    latest: ProjectLatestDeploymentSchema.nullable(),
    /** 삭제 요청 상태. 삭제 요청이 없으면 null */
    deletion: ProjectDeletionSchema.nullable(),
  })
  .strict();
export type Project = z.infer<typeof ProjectSchema>;

/** DELETE /projects/:id 202 — 정리 작업을 큐에 넣었다. 진행 상황은 GET /projects 의 deletion 으로 본다 */
export const DeleteProjectResponseSchema = z
  .object({
    projectId: IdStringSchema,
    deletion: ProjectDeletionSchema,
  })
  .strict();
export type DeleteProjectResponse = z.infer<typeof DeleteProjectResponseSchema>;

export const ProjectListSchema = z
  .object({
    items: z.array(ProjectSchema),
    nextCursor: IdStringSchema.nullable(),
    /** 전체 개수가 아니라 이번 페이지 items 개수 */
    total: z.number().int(),
  })
  .strict();
export type ProjectList = z.infer<typeof ProjectListSchema>;

export const ProjectDeploymentSchema = z
  .object({
    id: IdStringSchema,
    status: DeploymentStatusSchema,
    targetProfile: z.string().nullable(),
    publicUrl: z.string().nullable(),
    sourceVersion: z
      .object({ id: IdStringSchema, sha256: z.string().nullable() })
      .strict()
      .nullable(),
    createdAt: IsoDateTimeSchema,
    succeededAt: IsoDateTimeSchema.nullable(),
    failedAt: IsoDateTimeSchema.nullable(),
    /** 배포 대상 환경. 환경 없이 만든 옛 배포는 셋 다 null */
    environmentId: IdStringSchema.nullable(),
    environmentType: DeploymentEnvironmentTypeSchema,
    environmentName: z.string().nullable(),
    /** 지금 프로젝트 주소로 서비스 중인 배포(Project.live)면 true — 이력에서 하나만 true */
    isLive: z.boolean(),
  })
  .strict();
export type ProjectDeployment = z.infer<typeof ProjectDeploymentSchema>;

export const ProjectDeploymentListSchema = z
  .object({
    items: z.array(ProjectDeploymentSchema),
    nextCursor: IdStringSchema.nullable(),
  })
  .strict();
export type ProjectDeploymentList = z.infer<typeof ProjectDeploymentListSchema>;
