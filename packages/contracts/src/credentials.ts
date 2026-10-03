/**
 * packages/contracts/src/credentials.ts — AWS 키 확인 (#209)
 *   POST /credentials/verify → 200 VerifyAwsCredentialsResult
 *
 * 받은 키로 STS GetCallerIdentity 를 불러 키가 맞는지만 본다. 키는 저장하지 않고 응답 · 로그에도 남기지 않는다.
 * 키가 틀려도 200 { valid: false, reason } — 요청 자체가 잘못된 경우(형식)만 400.
 */

import { z } from "zod";

export const VerifyAwsCredentialsBodySchema = z.object({
  accessKeyId: z.string().trim().min(1).max(128),
  secretAccessKey: z.string().trim().min(1).max(256),
  region: z.string().trim().min(1).max(32),
});
export type VerifyAwsCredentialsBody = z.input<typeof VerifyAwsCredentialsBodySchema>;

export const AwsCredentialsRejectReasonSchema = z.enum([
  /** 없는 Access Key ID (InvalidClientTokenId) */
  "INVALID_ACCESS_KEY",
  /** Secret Access Key 가 짝이 맞지 않음 (SignatureDoesNotMatch) */
  "SIGNATURE_MISMATCH",
  /** 만료된 임시 키 (ExpiredToken) */
  "EXPIRED",
  /** 그 밖에 AWS 가 거절한 경우 */
  "REJECTED",
]);
export type AwsCredentialsRejectReason = z.infer<typeof AwsCredentialsRejectReasonSchema>;

export const VerifyAwsCredentialsResultSchema = z.discriminatedUnion("valid", [
  z.object({ valid: z.literal(true), accountId: z.string(), arn: z.string() }).strict(),
  z.object({ valid: z.literal(false), reason: AwsCredentialsRejectReasonSchema }).strict(),
]);
export type VerifyAwsCredentialsResult = z.infer<typeof VerifyAwsCredentialsResultSchema>;
