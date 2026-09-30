/**
 * apps/api/src/routes/deployments.ts
 * POST /deployments (multipart), GET /deployments/:id
 */

import { type FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ApiError } from "../plugins/error-handler.js";
import { DeploymentService } from "../services/deployment-service.js";
import { idParams } from "../plugins/swagger.js";

const VALID_PROFILES = new Set(["aws-ecs-basic", "onprem-docker-basic"]);

const deploymentsRoutes: FastifyPluginAsync<{ deploymentService: DeploymentService }> = async (
  fastify,
  opts
) => {
  const svc = opts.deploymentService;

  // POST /deployments — multipart
  fastify.post("/", {
    schema: {
      tags: ["deployments"],
      summary: "소스 zip 업로드 → 배포 시작 (202)",
      consumes: ["multipart/form-data"],
      body: {
        type: "object",
        required: ["source", "project_id", "target"],
        properties: {
          source: { type: "string", format: "binary", description: "소스 zip (최대 100MB)" },
          project_id: { type: "integer", minimum: 1 },
          target: { type: "string", enum: [...VALID_PROFILES] },
        },
      },
    },
  }, async (request, reply) => {
    const data = await request.file();
    if (!data) {
      throw new ApiError(400, "VALIDATION_ERROR", "source 파일이 없습니다.", "multipart/form-data로 source 필드(zip 파일)를 포함하세요.");
    }

    // Read all parts first (file + fields mixed in stream)
    // @fastify/multipart 이면 data.fields 로 non-file 필드 접근 가능
    const fields = data.fields as Record<string, { value: string } | { value: string }[]>;

    const rawProjectId = (fields["project_id"] as { value: string } | undefined)?.value;
    const rawTarget = (fields["target"] as { value: string } | undefined)?.value;

    // Consume file buffer
    const chunks: Buffer[] = [];
    for await (const chunk of data.file) {
      chunks.push(chunk as Buffer);
    }
    const fileBuffer = Buffer.concat(chunks);

    if (fileBuffer.length === 0) {
      throw new ApiError(400, "VALIDATION_ERROR", "업로드된 파일이 비어 있습니다.");
    }
    if (fileBuffer.length > 100 * 1024 * 1024) {
      throw new ApiError(413, "FILE_TOO_LARGE", "zip 파일 크기가 100MB를 초과합니다.", "zip 파일 최대 크기는 100MB입니다.");
    }

    // Validate target profile
    const target = rawTarget ?? "";
    if (!VALID_PROFILES.has(target)) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        `target은 ${[...VALID_PROFILES].join(" 또는 ")} 중 하나여야 합니다.`,
        "올바른 target 프로필을 지정하세요."
      );
    }

    // project_id: optional — TODO auto-create if missing (P1)
    const projectIdNum = rawProjectId ? Number(rawProjectId) : null;
    if (projectIdNum !== null && (!Number.isFinite(projectIdNum) || projectIdNum <= 0)) {
      throw new ApiError(400, "VALIDATION_ERROR", "project_id는 양수 정수여야 합니다.");
    }

    // For now project_id is required until auto-create is implemented
    if (projectIdNum === null) {
      throw new ApiError(400, "VALIDATION_ERROR", "project_id 필드가 필요합니다.", "POST /projects 로 프로젝트를 먼저 생성하세요.");
    }

    const result = await svc.create({
      projectId: projectIdNum,
      targetProfile: target,
      fileBuffer,
    });

    return reply.status(202).send(result);
  });

  // GET /deployments/:id
  fastify.get<{ Params: { id: string } }>("/:id", {
    schema: { tags: ["deployments"], summary: "배포 조회", params: idParams },
  }, async (request) => {
    const id = Number(request.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      throw new ApiError(400, "VALIDATION_ERROR", "배포 ID는 양수 정수여야 합니다.");
    }
    return svc.get(id);
  });
};

export default deploymentsRoutes;
