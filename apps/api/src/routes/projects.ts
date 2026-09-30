/**
 * apps/api/src/routes/projects.ts
 * POST /projects, GET /projects, GET /projects/:id, GET /projects/:id/deployments
 */

import { type FastifyPluginAsync } from "fastify";
import {
  CreateProjectBodySchema,
  IdParamsSchema as ProjectIdParamsSchema,
  ListProjectDeploymentsQuerySchema as ListDeploymentsQuerySchema,
  ListProjectsQuerySchema,
} from "@camellia/contracts";
import { ProjectService } from "../services/project-service.js";
import { toJsonSchema } from "../plugins/swagger.js";

const projectsRoutes: FastifyPluginAsync<{ projectService: ProjectService }> = async (
  fastify,
  opts
) => {
  const svc = opts.projectService;

  // POST /projects
  fastify.post("/", {
    schema: { tags: ["projects"], summary: "프로젝트 생성", body: toJsonSchema(CreateProjectBodySchema) },
  }, async (request, reply) => {
    const body = CreateProjectBodySchema.parse(request.body);
    const project = await svc.create(body);
    return reply.status(201).send(project);
  });

  // GET /projects
  fastify.get("/", {
    schema: { tags: ["projects"], summary: "프로젝트 목록", querystring: toJsonSchema(ListProjectsQuerySchema) },
  }, async (request) => {
    const query = ListProjectsQuerySchema.parse(request.query);
    return svc.list({ limit: query.limit, cursor: query.cursor });
  });

  // GET /projects/:id
  fastify.get<{ Params: { id: string } }>("/:id", {
    schema: { tags: ["projects"], summary: "프로젝트 조회", params: toJsonSchema(ProjectIdParamsSchema) },
  }, async (request) => {
    const id = Number(request.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      const { ApiError } = await import("../plugins/error-handler.js");
      throw new ApiError(400, "VALIDATION_ERROR", "프로젝트 ID는 양수 정수여야 합니다.");
    }
    return svc.get(id);
  });

  // GET /projects/:id/deployments — 배포 이력 (LOG-01 / API-22)
  fastify.get("/:id/deployments", {
    schema: {
      tags: ["projects"],
      summary: "프로젝트 배포 이력 (최신순 · 커서 페이지네이션)",
      params: toJsonSchema(ProjectIdParamsSchema),
      querystring: toJsonSchema(ListDeploymentsQuerySchema),
    },
  }, async (request) => {
    const { id } = ProjectIdParamsSchema.parse(request.params);
    const query = ListDeploymentsQuerySchema.parse(request.query);
    return svc.listDeployments(id, query);
  });
};

export default projectsRoutes;
