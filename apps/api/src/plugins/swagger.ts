/**
 * apps/api/src/plugins/swagger.ts
 * UI-01 OpenAPI 문서. GET /docs → Swagger UI, GET /docs/json → OpenAPI 3 문서.
 *
 * 라우트 schema 는 문서 전용이다. 입력 검증은 지금처럼 핸들러의 Zod parse 가 하고
 * (ZodError → 400 VALIDATION_ERROR), Fastify(ajv) 검증은 no-op 으로 꺼서
 * 타입 변환 · 필드 제거 · 에러 메시지가 바뀌지 않게 한다.
 * 응답(response) schema 는 선언하지 않는다 — 선언하면 직렬화 시 필드가 잘릴 수 있다.
 */

import { type FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { type ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { IdParamsSchema } from "@camellia/contracts";

/** Zod 스키마(입력 형태) → OpenAPI 3 JSON Schema. 라우트 schema 의 params/querystring/body 에 사용. */
export function toJsonSchema(schema: ZodTypeAny) {
  return zodToJsonSchema(schema, { target: "openApi3", $refStrategy: "none" });
}

/** `/:id` 경로 파라미터 (배포 · 환경 ID) 문서용 */
export const idParams = toJsonSchema(IdParamsSchema);

const swaggerPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.setValidatorCompiler(() => () => true);

  await fastify.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "camellia API",
        description: "AI 원클릭 멀티 환경 배포 시스템 API",
        version: "0.1.0",
      },
      tags: [
        { name: "projects", description: "프로젝트 · 배포 이력 · 환경변수" },
        { name: "deployments", description: "배포 생성 · 진행 상태 · IR · 승인 · 로그" },
        { name: "secrets", description: "클라우드 시크릿" },
        { name: "environments", description: "배포 환경 (AWS · 온프레미스)" },
        { name: "system", description: "헬스 체크" },
      ],
      components: {
        securitySchemes: {
          apiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
        },
      },
      security: [{ apiKey: [] }],
    },
    // prefix + "/" 라우트(`/api/v1/projects/`)를 `/api/v1/projects` 로 표기
    transform: ({ schema, url }) => ({ schema, url: url.length > 1 ? url.replace(/\/$/, "") : url }),
  });

  await fastify.register(swaggerUi, { routePrefix: "/docs" });
};

export default fp(swaggerPlugin, { name: "swagger" });
