/**
 * packages/contracts/src/projects.ts
 *   POST /projects                  → 201 Project
 *   GET  /projects                  → 200 ProjectList
 *   GET  /projects/:id              → 200 Project
 *   GET  /projects/:id/deployments  → 200 ProjectDeploymentList (최신순 · 커서)
 */

import { z } from "zod";
import { DeploymentStatusSchema, IdStringSchema, IsoDateTimeSchema } from "./common.js";

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

export const ProjectSchema = z
  .object({
    id: IdStringSchema,
    name: z.string(),
    /** DB 값이 null 이면 필드 자체가 없다 */
    description: z.string().optional(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type Project = z.infer<typeof ProjectSchema>;

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
