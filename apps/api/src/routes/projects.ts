/**
 * apps/api/src/routes/projects.ts
 * POST /projects, GET /projects, GET /projects/:id, GET /projects/:id/deployments,
 * DELETE /projects/:id (앱 삭제 — 리소스 정리를 시작, #247),
 * GET /projects/subdomain-availability (앱 주소 확인, #300),
 * PATCH /projects/:id/subdomain (앱 주소 변경, #301)
 */

import { type FastifyPluginAsync } from "fastify";
import {
  CreateProjectBodySchema,
  IdParamsSchema as ProjectIdParamsSchema,
  ListProjectDeploymentsQuerySchema as ListDeploymentsQuerySchema,
  ListProjectsQuerySchema,
  SubdomainAvailabilityQuerySchema,
  UpdateProjectSubdomainBodySchema,
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

  // GET /projects/subdomain-availability — 새 앱 · 주소 변경 입력란의 실시간 확인 (#300)
  fastify.get("/subdomain-availability", {
    schema: {
      tags: ["projects"],
      summary: "앱 주소 사용 가능 여부 (형식 · 예약어 · 다른 앱 사용 중)",
      querystring: toJsonSchema(SubdomainAvailabilityQuerySchema),
    },
  }, async (request) => {
    const { name } = SubdomainAvailabilityQuerySchema.parse(request.query);
    return svc.subdomainAvailability(name);
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

  // DELETE /projects/:id — 202 로 받고 teardown 워커가 정리한 뒤 프로젝트를 지운다 (#247)
  fastify.delete("/:id", {
    schema: {
      tags: ["projects"],
      summary: "앱 삭제 (AWS 리소스 · 공개 주소 · 배포 기록 정리)",
      params: toJsonSchema(ProjectIdParamsSchema),
    },
  }, async (request, reply) => {
    const { id } = ProjectIdParamsSchema.parse(request.params);
    const result = await svc.requestDeletion(id);
    return reply.status(202).send(result);
  });

  // PATCH /projects/:id/subdomain — 202 주소 변경 작업 시작 · 200 바로 바꿈 (#301)
  fastify.patch("/:id/subdomain", {
    schema: {
      tags: ["projects"],
      summary: "앱 주소 변경 (새 주소 연결 · 검증 뒤 전환)",
      params: toJsonSchema(ProjectIdParamsSchema),
      body: toJsonSchema(UpdateProjectSubdomainBodySchema),
    },
  }, async (request, reply) => {
    const { id } = ProjectIdParamsSchema.parse(request.params);
    const { subdomain } = UpdateProjectSubdomainBodySchema.parse(request.body);
    const result = await svc.requestSubdomainChange(id, subdomain);
    return reply.status(result.accepted ? 202 : 200).send(result.project);
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
