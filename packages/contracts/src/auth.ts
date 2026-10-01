/**
 * packages/contracts/src/auth.ts — API-01 세션 인증
 *   POST /auth/session  { apiKey } → 201 { token, expiresAt, userId }
 */

import { z } from "zod";
import { IsoDateTimeSchema } from "./common.js";

export const CreateSessionBodySchema = z
  .object({
    apiKey: z.string().min(1),
  })
  .strict();
export type CreateSessionBody = z.input<typeof CreateSessionBodySchema>;

export const SessionResponseSchema = z
  .object({
    token: z.string().min(1),
    expiresAt: IsoDateTimeSchema,
    userId: z.string().min(1),
  })
  .strict();
export type SessionResponse = z.infer<typeof SessionResponseSchema>;
