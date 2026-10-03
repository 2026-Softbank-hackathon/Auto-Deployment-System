/**
 * apps/api/src/services/aws-credential-verifier.ts — AWS 키 확인 (#209)
 *
 * STS GetCallerIdentity 는 권한이 하나도 없는 키도 성공하므로, 키가 맞는지만 깔끔하게 가린다.
 * 키 값은 이 호출에만 쓰고 저장 · 로그에 남기지 않는다.
 */

import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import type { AwsCredentialsRejectReason, VerifyAwsCredentialsBody, VerifyAwsCredentialsResult } from "@camellia/contracts";
import { ApiError } from "../plugins/error-handler.js";

export type AwsCredentialVerifier = (input: Required<VerifyAwsCredentialsBody>) => Promise<VerifyAwsCredentialsResult>;

/** AWS 가 키를 거절할 때 주는 오류 이름. 이 밖의 오류(네트워크 · 리전 오타 등)는 키 문제로 보지 않는다. */
const REJECT_REASONS: Record<string, AwsCredentialsRejectReason> = {
  InvalidClientTokenId: "INVALID_ACCESS_KEY",
  UnrecognizedClientException: "INVALID_ACCESS_KEY",
  SignatureDoesNotMatch: "SIGNATURE_MISMATCH",
  IncompleteSignature: "SIGNATURE_MISMATCH",
  ExpiredToken: "EXPIRED",
  ExpiredTokenException: "EXPIRED",
  AccessDenied: "REJECTED",
  InvalidAccessKeyId: "INVALID_ACCESS_KEY",
};

/** 화면이 기다리는 시간 — 넘기면 확인하지 못한 것으로 본다 */
const VERIFY_TIMEOUT_MS = 10_000;

export const verifyAwsCredentialsWithSts: AwsCredentialVerifier = async ({ accessKeyId, secretAccessKey, region }) => {
  const client = new STSClient({ region, credentials: { accessKeyId, secretAccessKey }, maxAttempts: 2 });
  try {
    const identity = await client.send(new GetCallerIdentityCommand({}), { abortSignal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) });
    return { valid: true, accountId: identity.Account ?? "", arn: identity.Arn ?? "" };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const reason = REJECT_REASONS[name];
    if (reason) return { valid: false, reason };
    // 키가 맞는지 판단할 수 없는 경우 — 키는 메시지에 넣지 않는다
    throw new ApiError(502, "AWS_VERIFY_UNAVAILABLE", `AWS 에 키를 확인하지 못했습니다 (${name || "알 수 없는 오류"}). 잠시 뒤 다시 시도해 주세요.`);
  } finally {
    client.destroy();
  }
};
