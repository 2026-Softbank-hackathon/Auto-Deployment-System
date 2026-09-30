/**
 * packages/contracts/src/secrets.ts — 시크릿 (DAT-02). 값은 암호화 저장, 응답에 없음
 *   POST   /secrets                      → 201 Secret
 *   GET    /secrets?projectId=<N>        → 200 Secret[] (이름순)
 *   DELETE /secrets/:name?projectId=<N>  → 204 (빈 바디)
 */

import { z } from "zod";
import { IsoDateTimeSchema, PgBigIntSchema } from "./common.js";

// ── 요청 ──────────────────────────────────────────────────────────────────────

export const CreateSecretBodySchema = z.object({
  projectId: z.number().int().positive(),
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
    /** POST 응답은 number, GET 목록은 문자열 (PgBigIntSchema 참고) */
    projectId: PgBigIntSchema,
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type Secret = z.infer<typeof SecretSchema>;

export const SecretListSchema = z.array(SecretSchema);
export type SecretList = z.infer<typeof SecretListSchema>;
