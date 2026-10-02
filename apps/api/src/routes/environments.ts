/**
 * apps/api/src/routes/environments.ts
 * API-23~26 (REC-01) 환경 CRUD.
 *
 *   POST   /environments                      → 201 { id, name, type, ..., createdAt }
 *   GET    /environments?projectId=<N>        → 200 [환경 목록]
 *   GET    /environments                      → 200 [공용 연결 목록] (#215)
 *   GET    /environments/:id                  → 200 { ... }
 *   DELETE /environments/:id                  → 204 (진행 중 배포 · 배포 기록 있으면 409)
 *
 * POST 바디에 projectId 를 생략하면 공용 연결 — 모든 프로젝트가 배포 때 고를 수 있다(#215).
 */

import { type FastifyPluginAsync } from "fastify";
import {
  CreateEnvironmentBodySchema as CreateBody,
  OptionalProjectIdQuerySchema as ProjectIdQuery,
} from "@camellia/contracts";
import { ApiError } from "../plugins/error-handler.js";
import type { EnvironmentService } from "../services/environment-service.js";
import { idParams, toJsonSchema } from "../plugins/swagger.js";

const environmentsRoutes: FastifyPluginAsync<{ environmentService: EnvironmentService }> = async (
  fastify,
  opts,
) => {
  const svc = opts.environmentService;

  fastify.post("/", {
    schema: { tags: ["environments"], summary: "배포 환경 등록 (AWS · 온프레미스)", body: toJsonSchema(CreateBody) },
  }, async (request, reply) => {
    const body = CreateBody.parse(request.body);
    const dto = await svc.create(body);
    return reply.status(201).send(dto);
  });

  fastify.get("/", {
    schema: { tags: ["environments"], summary: "배포 환경 목록", querystring: toJsonSchema(ProjectIdQuery) },
  }, async (request) => {
    const q = ProjectIdQuery.parse(request.query);
    return svc.list(q);
  });

  fastify.get<{ Params: { id: string } }>("/:id", {
    schema: { tags: ["environments"], summary: "배포 환경 조회", params: idParams },
  }, async (request) => {
    const id = Number(request.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      throw new ApiError(400, "VALIDATION_ERROR", "환경 ID 는 양수 정수여야 합니다.");
    }
    return svc.get(id);
  });

  fastify.delete<{ Params: { id: string } }>("/:id", {
    schema: { tags: ["environments"], summary: "배포 환경 삭제 (진행 중 배포 있으면 409)", params: idParams },
  }, async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      throw new ApiError(400, "VALIDATION_ERROR", "환경 ID 는 양수 정수여야 합니다.");
    }
    await svc.delete(id);
    return reply.status(204).send();
  });
};

export default environmentsRoutes;
