/**
 * packages/contracts/src/env.ts — 프로젝트 환경변수 (DAT-01, 평문 설정값)
 *   GET   /projects/:id/env                                  → 200 EnvVarList
 *   PATCH /projects/:id/env  { vars: { NAME: "값" | null } } → 200 EnvVarList (null 은 삭제)
 */

import { z } from "zod";
import { IsoDateTimeSchema } from "./common.js";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 플랫폼이 자동 주입하는 환경변수 이름 목록.
 * IR에 선언되어 있으면 user env_vars 등록 없이도 플랫폼이 결정한 값으로 채운다.
 * provision 핸들러와 analysis-report 서비스 양쪽에서 공유한다.
 */
export const PLATFORM_INJECTED_ENV_NAMES = ["PORT", "DEPLOY_TARGET", "NODE_ENV", "AWS_REGION"] as const;

// ── 요청 ──────────────────────────────────────────────────────────────────────

export const PatchProjectEnvBodySchema = z.object({
  vars: z
    .record(z.string().max(4096).nullable())
    .refine((vars) => Object.keys(vars).length > 0, "변경할 환경변수가 없습니다.")
    .refine(
      (vars) => Object.keys(vars).every((name) => name.length <= 128 && ENV_NAME.test(name)),
      "환경변수 이름은 영문·숫자·언더바만 쓸 수 있고 숫자로 시작할 수 없습니다.",
    ),
});
export type PatchProjectEnvBody = z.input<typeof PatchProjectEnvBodySchema>;

// ── 응답 ──────────────────────────────────────────────────────────────────────

export const EnvVarSchema = z
  .object({
    name: z.string(),
    value: z.string(),
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type EnvVar = z.infer<typeof EnvVarSchema>;

/** 이름순 */
export const EnvVarListSchema = z.object({ items: z.array(EnvVarSchema) }).strict();
export type EnvVarList = z.infer<typeof EnvVarListSchema>;
