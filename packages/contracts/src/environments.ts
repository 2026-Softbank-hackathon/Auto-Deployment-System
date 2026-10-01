/**
 * packages/contracts/src/environments.ts — 배포 환경 (REC-01, AWS · 온프레미스)
 *   POST   /environments                → 201 CreateEnvironmentResponse (agentRegistrationToken 1회 포함)
 *   GET    /environments?projectId=<N>  → 200 Environment[] (이름순, agentRegistrationToken 없음)
 *   GET    /environments/:id            → 200 Environment (agentRegistrationToken 없음)
 *   DELETE /environments/:id            → 204 (빈 바디, 진행 중 배포 있으면 409)
 *
 * agentRegistrationToken 은 On-Prem Agent 등록용 인증값이라 생성 응답에서만 1회
 * 그대로 돌려주고, 목록/단건 조회 응답에서는 제거한다(#61).
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

/** 목록/단건 조회 응답용 — agentRegistrationToken 제거 */
export const OnpremConfigPublicSchema = OnpremConfigSchema.omit({
  agentRegistrationToken: true,
});
export type OnpremConfigPublic = z.infer<typeof OnpremConfigPublicSchema>;

export const CreateEnvironmentBodySchema = z.object({
  projectId: z.number().int().positive(),
  name: z.string().min(1).max(128),
  type: z.enum(["aws", "onprem"]),
  isDefault: z.boolean().optional(),
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
    isDefault: z.boolean(),
    /** 등록한 값 그대로 (type=aws 일 때). 없으면 필드 없음 */
    awsConfig: AwsConfigSchema.strict().optional(),
    /** hostname 등 등록한 값 (type=onprem 일 때). agentRegistrationToken 은 없음(#61). 없으면 필드 없음 */
    onpremConfig: OnpremConfigPublicSchema.strict().optional(),
    agentStatus: z.string().nullable(),
    lastSeenAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type Environment = z.infer<typeof EnvironmentSchema>;

export const EnvironmentListSchema = z.array(EnvironmentSchema);
export type EnvironmentList = z.infer<typeof EnvironmentListSchema>;

/**
 * POST /environments 응답 전용. type=onprem 일 때 agentRegistrationToken을
 * 이 생성 응답에서만 1회 그대로 돌려준다 — 이후 목록/단건 조회에서는
 * EnvironmentSchema(onpremConfig 에 token 없음)를 사용한다.
 */
export const CreateEnvironmentResponseSchema = EnvironmentSchema.extend({
  onpremConfig: OnpremConfigSchema.strict().optional(),
});
export type CreateEnvironmentResponse = z.infer<typeof CreateEnvironmentResponseSchema>;
