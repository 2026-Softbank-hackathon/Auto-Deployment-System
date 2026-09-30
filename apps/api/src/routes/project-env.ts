/**
 * apps/api/src/routes/project-env.ts
 * DAT-01 프로젝트 환경변수.
 *
 *   GET   /projects/:id/env                                → 200 { items: [{ name, value, updatedAt }] }
 *   PATCH /projects/:id/env  { vars: { NAME: "값" | null } } → 200 (GET 과 같은 형태). null 은 삭제
 */

import { type FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { EnvVarService } from "../services/env-var-service.js";

const ProjectIdParams = z.object({
  id: z.coerce.number().int().positive(),
});

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const PatchBody = z.object({
  vars: z
    .record(z.string().max(4096).nullable())
    .refine((vars) => Object.keys(vars).length > 0, "변경할 환경변수가 없습니다.")
    .refine(
      (vars) => Object.keys(vars).every((name) => name.length <= 128 && ENV_NAME.test(name)),
      "환경변수 이름은 영문·숫자·언더바만 쓸 수 있고 숫자로 시작할 수 없습니다.",
    ),
});

const projectEnvRoutes: FastifyPluginAsync<{ envVarService: EnvVarService }> = async (
  fastify,
  opts,
) => {
  const svc = opts.envVarService;

  fastify.get("/:id/env", async (request) => {
    const { id } = ProjectIdParams.parse(request.params);
    return svc.list(id);
  });

  fastify.patch("/:id/env", async (request) => {
    const { id } = ProjectIdParams.parse(request.params);
    const { vars } = PatchBody.parse(request.body);
    return svc.update(id, vars);
  });
};

export default projectEnvRoutes;
