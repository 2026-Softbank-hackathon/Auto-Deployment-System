/**
 * apps/api/src/routes/project-env.ts
 * DAT-01 프로젝트 환경변수.
 *
 *   GET   /projects/:id/env                                → 200 { items: [{ name, value, updatedAt }] }
 *   PATCH /projects/:id/env  { vars: { NAME: "값" | null } } → 200 (GET 과 같은 형태). null 은 삭제
 */

import { type FastifyPluginAsync } from "fastify";
import { IdParamsSchema as ProjectIdParams, PatchProjectEnvBodySchema as PatchBody } from "@camellia/contracts";
import type { EnvVarService } from "../services/env-var-service.js";
import { toJsonSchema } from "../plugins/swagger.js";

const projectEnvRoutes: FastifyPluginAsync<{ envVarService: EnvVarService }> = async (
  fastify,
  opts,
) => {
  const svc = opts.envVarService;

  fastify.get("/:id/env", {
    schema: { tags: ["projects"], summary: "프로젝트 환경변수 목록", params: toJsonSchema(ProjectIdParams) },
  }, async (request) => {
    const { id } = ProjectIdParams.parse(request.params);
    return svc.list(id);
  });

  fastify.patch("/:id/env", {
    schema: {
      tags: ["projects"],
      summary: "프로젝트 환경변수 추가 · 수정 · 삭제 (값 null 은 삭제)",
      params: toJsonSchema(ProjectIdParams),
      body: toJsonSchema(PatchBody),
    },
  }, async (request) => {
    const { id } = ProjectIdParams.parse(request.params);
    const { vars } = PatchBody.parse(request.body);
    return svc.update(id, vars);
  });
};

export default projectEnvRoutes;
