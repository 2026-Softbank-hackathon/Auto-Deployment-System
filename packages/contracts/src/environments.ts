/**
 * packages/contracts/src/environments.ts — 배포 환경 (REC-01, AWS · 온프레미스)
 *   POST   /environments                → 201 Environment
 *   GET    /environments?projectId=<N>  → 200 Environment[] (이름순)
 *   GET    /environments/:id            → 200 Environment
 *   DELETE /environments/:id            → 204 (빈 바디, 진행 중 배포 있으면 409)
 */

import { z } from "zod";
import { IsoDateTimeSchema, PgBigIntSchema } from "./common.js";

// ── 요청 ──────────────────────────────────────────────────────────────────────

/** AWS 자격증명은 시크릿 이름으로만 참조 (access_key) 하거나 assume_role 로 지정 */
export const AwsConfigSchema = z.object({
  credentialsType: z.enum(["access_key", "assume_role"]),
  accessKeyIdSecretName: z.string().optional(),
  secretAccessKeySecretName: z.string().optional(),
  roleArn: z.string().optional(),
  externalId: z.string().optional(),
  region: z.string().min(1),
});
export type AwsConfig = z.infer<typeof AwsConfigSchema>;

export const OnpremConfigSchema = z.object({
  agentRegistrationToken: z.string().min(1),
  hostname: z.string().min(1),
});
export type OnpremConfig = z.infer<typeof OnpremConfigSchema>;

export const CreateEnvironmentBodySchema = z.object({
  projectId: z.number().int().positive(),
  name: z.string().min(1).max(128),
  type: z.enum(["aws", "onprem"]),
  awsConfig: AwsConfigSchema.optional(),
  onpremConfig: OnpremConfigSchema.optional(),
});
export type CreateEnvironmentBody = z.input<typeof CreateEnvironmentBodySchema>;

// ── 응답 ──────────────────────────────────────────────────────────────────────

export const EnvironmentSchema = z
  .object({
    /** DB 에서 읽은 값이라 실제로는 문자열 (PgBigIntSchema 참고) */
    id: PgBigIntSchema,
    /** POST 응답은 number, GET 은 문자열 (PgBigIntSchema 참고) */
    projectId: PgBigIntSchema,
    name: z.string(),
    type: z.enum(["aws", "onprem"]),
    /** 등록한 값 그대로 (type=aws 일 때). 없으면 필드 없음 */
    awsConfig: AwsConfigSchema.strict().optional(),
    /** 등록한 값 그대로 (type=onprem 일 때, agentRegistrationToken 포함). 없으면 필드 없음 */
    onpremConfig: OnpremConfigSchema.strict().optional(),
    agentStatus: z.string().nullable(),
    lastSeenAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type Environment = z.infer<typeof EnvironmentSchema>;

export const EnvironmentListSchema = z.array(EnvironmentSchema);
export type EnvironmentList = z.infer<typeof EnvironmentListSchema>;
