/**
 * apps/api/src/routes/secrets.ts
 * API-28/29/30 (DAT-02) 시크릿 CRUD.
 *
 *   POST   /secrets                 { name, value, projectId } → 201 { name, projectId, createdAt }
 *   GET    /secrets?projectId=<N>   → 200 [{ name, projectId, createdAt }]  (value 없음)
 *   DELETE /secrets/:name?projectId=<N> → 204
 */

import { type FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ApiError } from "../plugins/error-handler.js";
import type { SecretService } from "../services/secret-service.js";
import { toJsonSchema } from "../plugins/swagger.js";

const CreateBody = z.object({
  projectId: z.number().int().positive(),
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._-]+$/, "영숫자·점·언더바·하이픈만 허용"),
  value: z.string().min(1),
});

const ProjectIdQuery = z.object({
  projectId: z.coerce.number().int().positive(),
});

const secretsRoutes: FastifyPluginAsync<{ secretService: SecretService }> = async (
  fastify,
  opts,
) => {
  const svc = opts.secretService;

  fastify.post("/", {
    schema: { tags: ["secrets"], summary: "시크릿 저장 (값은 암호화 저장, 응답에 없음)", body: toJsonSchema(CreateBody) },
  }, async (request, reply) => {
    const body = CreateBody.parse(request.body);
    const dto = await svc.create(body);
    return reply.status(201).send(dto);
  });

  fastify.get("/", {
    schema: { tags: ["secrets"], summary: "시크릿 목록 (값 제외)", querystring: toJsonSchema(ProjectIdQuery) },
  }, async (request) => {
    const q = ProjectIdQuery.parse(request.query);
    return svc.list(q);
  });

  fastify.delete<{ Params: { name: string } }>("/:name", {
    schema: {
      tags: ["secrets"],
      summary: "시크릿 삭제",
      params: toJsonSchema(z.object({ name: z.string().min(1) })),
      querystring: toJsonSchema(ProjectIdQuery),
    },
  }, async (request, reply) => {
    const q = ProjectIdQuery.parse(request.query);
    if (!request.params.name) {
      throw new ApiError(400, "VALIDATION_ERROR", "시크릿 name 이 필요합니다.");
    }
    await svc.delete({ projectId: q.projectId, name: request.params.name });
    return reply.status(204).send();
  });
};

export default secretsRoutes;
