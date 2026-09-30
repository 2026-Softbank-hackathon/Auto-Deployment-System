/**
 * apps/api/src/plugins/error-handler.ts
 * 공통 에러 응답 형식: { error: { code, message, hint }, requestId }
 * v5.4.1 hint 원칙 준수.
 */

import { type FastifyPluginAsync, type FastifyError } from "fastify";
import fp from "fastify-plugin";
import { ZodError } from "zod";
import { getRequestId } from "./request-id.js";

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly hint?: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function buildErrorBody(
  code: string,
  message: string,
  requestId: string,
  hint?: string
) {
  return {
    error: {
      code,
      message,
      ...(hint !== undefined ? { hint } : {}),
    },
    requestId,
  };
}

const errorHandlerPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.setErrorHandler((error, request, reply) => {
    const requestId = getRequestId(request);
    const log = request.log ?? fastify.log;

    // ZodError → 400 VALIDATION_ERROR
    if (error instanceof ZodError) {
      const message = error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      log.warn({ requestId, issues: error.issues }, "validation error");
      return reply.status(400).send(
        buildErrorBody(
          "VALIDATION_ERROR",
          message,
          requestId,
          "요청 바디/쿼리 필드를 확인한 뒤 수정하세요."
        )
      );
    }

    // Our ApiError
    if (error instanceof ApiError) {
      if (error.statusCode >= 500) {
        log.error({ requestId, err: error }, "api error");
      } else {
        log.warn({ requestId, code: error.code }, error.message);
      }
      return reply
        .status(error.statusCode)
        .send(buildErrorBody(error.code, error.message, requestId, error.hint));
    }

    // Fastify built-in validation error (statusCode 400)
    const fe = error as FastifyError;
    if (fe.statusCode === 400) {
      log.warn({ requestId }, fe.message);
      return reply.status(400).send(
        buildErrorBody(
          "VALIDATION_ERROR",
          fe.message,
          requestId,
          "요청 필드를 확인하세요."
        )
      );
    }

    if (fe.statusCode === 404) {
      return reply.status(404).send(
        buildErrorBody("NOT_FOUND", "리소스를 찾을 수 없습니다.", requestId, "ID를 확인하세요.")
      );
    }

    // Unexpected
    log.error({ requestId, err: error }, "unhandled error");
    return reply.status(500).send(
      buildErrorBody(
        "INTERNAL_ERROR",
        "서버 내부 오류가 발생했습니다.",
        requestId,
        `requestId(${requestId})를 포함해 팀에 신고하세요.`
      )
    );
  });
};

export default fp(errorHandlerPlugin, { name: "error-handler" });
