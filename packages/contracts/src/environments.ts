/**
 * packages/contracts/src/environments.ts — 배포 환경 (REC-01, AWS · 온프레미스)
 *   POST   /environments                → 201 CreateEnvironmentResponse (agentRegistrationToken 1회 포함)
 *   GET    /environments?projectId=<N>  → 200 Environment[] (이름순, agentRegistrationToken 없음)
 *   GET    /environments                → 200 Environment[] (projectId 생략 = 공용 연결 목록, #215)
 *   GET    /environments/:id            → 200 Environment (agentRegistrationToken 없음)
 *   DELETE /environments/:id            → 204 (빈 바디, 진행 중 배포 · 배포 기록이 있으면 409)
 *
 * projectId 없이 등록한 연결은 공용 연결(projectId=null, shared=true)이라 모든 프로젝트가 배포 때 고를 수 있다(#215).
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
  /** 생략하면 공용 연결 — 모든 프로젝트가 같이 쓴다(#215). 참조 시크릿도 공용 시크릿에서 찾는다 */
  projectId: z.number().int().positive().optional(),
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
    /** POST 응답은 number, GET 은 문자열 (PgBigIntSchema 참고). 공용 연결이면 null(#215) */
    projectId: PgBigIntSchema.nullable(),
    /** 공용 연결(프로젝트 없이 등록) 여부 — projectId === null 과 같다(#215) */
    shared: z.boolean(),
    name: z.string(),
    type: z.enum(["aws", "onprem"]),
    /** 같은 소유 범위(프로젝트 또는 공용) 안에서 종류별 기본 연결 */
    isDefault: z.boolean(),
    /** 등록한 값 그대로 (type=aws 일 때). 없으면 필드 없음 */
    awsConfig: AwsConfigSchema.strict().optional(),
    /** hostname 등 등록한 값 (type=onprem 일 때). agentRegistrationToken 은 없음(#61). 없으면 필드 없음 */
    onpremConfig: OnpremConfigPublicSchema.strict().optional(),
    agentStatus: z.string().nullable(),
    lastSeenAt: IsoDateTimeSchema.nullable(),
    /**
     * 등록된 On-Prem Agent 가 최근 90초 안에 연락했는지 (agents.last_seen_at 기준, #215).
     * Agent 가 없거나 type=aws 면 false
     */
    agentOnline: z.boolean(),
    /** 등록된 Agent 의 마지막 연락 시각. Agent 가 없거나 연락 기록이 없으면 null(#215) */
    agentLastSeenAt: IsoDateTimeSchema.nullable(),
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
