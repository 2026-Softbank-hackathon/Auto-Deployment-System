/**
 * apps/api/src/routes/projects.ts
 * POST /projects, GET /projects, GET /projects/:id
 */

import { type FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ProjectService } from "../services/project-service.js";

const CreateProjectBodySchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});

const ListProjectsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const projectsRoutes: FastifyPluginAsync<{ projectService: ProjectService }> = async (
  fastify,
  opts
) => {
  const svc = opts.projectService;

  // POST /projects
  fastify.post("/", async (request, reply) => {
    const body = CreateProjectBodySchema.parse(request.body);
    const project = await svc.create(body);
    return reply.status(201).send(project);
  });

  // GET /projects
  fastify.get("/", async (request) => {
    const query = ListProjectsQuerySchema.parse(request.query);
    return svc.list({ limit: query.limit, cursor: query.cursor });
  });

  // GET /projects/:id
  fastify.get<{ Params: { id: string } }>("/:id", async (request) => {
    const id = Number(request.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      const { ApiError } = await import("../plugins/error-handler.js");
      throw new ApiError(400, "VALIDATION_ERROR", "프로젝트 ID는 양수 정수여야 합니다.");
    }
    return svc.get(id);
  });
};

export default projectsRoutes;
