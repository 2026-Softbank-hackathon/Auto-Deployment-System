/**
 * packages/contracts/src/secrets.ts — 시크릿 (DAT-02). 값은 암호화 저장, 응답에 없음
 *   POST   /secrets                      → 201 Secret
 *   GET    /secrets?projectId=<N>        → 200 Secret[] (이름순)
 *   DELETE /secrets/:name?projectId=<N>  → 204 (빈 바디)
 *
 * projectId 를 생략하면(요청 바디 · 쿼리 모두) 공용 시크릿 — 공용 연결이 참조한다(#215).
 */

import { z } from "zod";
import { IsoDateTimeSchema, PgBigIntSchema } from "./common.js";

// ── 요청 ──────────────────────────────────────────────────────────────────────

export const CreateSecretBodySchema = z.object({
  /** 생략하면 공용 시크릿(#215) */
  projectId: z.number().int().positive().optional(),
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._-]+$/, "영숫자·점·언더바·하이픈만 허용"),
  value: z.string().min(1),
});
export type CreateSecretBody = z.input<typeof CreateSecretBodySchema>;

export const SecretNameParamsSchema = z.object({ name: z.string().min(1) });
export type SecretNameParams = z.input<typeof SecretNameParamsSchema>;

// ── 응답 ──────────────────────────────────────────────────────────────────────

export const SecretSchema = z
  .object({
    name: z.string(),
    /** POST 응답은 number, GET 목록은 문자열 (PgBigIntSchema 참고). 공용 시크릿이면 null(#215) */
    projectId: PgBigIntSchema.nullable(),
    /** 공용 시크릿 여부 — projectId === null 과 같다(#215) */
    shared: z.boolean(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type Secret = z.infer<typeof SecretSchema>;

export const SecretListSchema = z.array(SecretSchema);
export type SecretList = z.infer<typeof SecretListSchema>;
