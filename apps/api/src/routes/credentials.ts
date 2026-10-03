/**
 * apps/api/src/routes/credentials.ts
 * AWS 키 확인 (#209). 연결을 등록하기 전에 화면이 먼저 부른다.
 *
 *   POST /api/v1/credentials/verify { accessKeyId, secretAccessKey, region }
 *     → 200 { valid: true, accountId, arn } | { valid: false, reason }
 */

import { type FastifyPluginAsync } from "fastify";
import { VerifyAwsCredentialsBodySchema } from "@camellia/contracts";
import type { AwsCredentialVerifier } from "../services/aws-credential-verifier.js";
import { toJsonSchema } from "../plugins/swagger.js";

const credentialsRoutes: FastifyPluginAsync<{ verifyAwsCredentials: AwsCredentialVerifier }> = async (fastify, opts) => {
  fastify.post("/verify", {
    schema: { tags: ["credentials"], summary: "AWS 키 확인 (STS GetCallerIdentity, 저장하지 않음)", body: toJsonSchema(VerifyAwsCredentialsBodySchema) },
  }, async (request) => {
    const body = VerifyAwsCredentialsBodySchema.parse(request.body);
    return opts.verifyAwsCredentials(body);
  });
};

export default credentialsRoutes;
