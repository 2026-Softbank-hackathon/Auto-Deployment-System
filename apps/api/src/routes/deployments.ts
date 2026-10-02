/**
 * apps/api/src/routes/deployments.ts
 * POST /deployments (multipart), GET /deployments/:id
 */

import { type FastifyPluginAsync } from "fastify";
import { ApiError } from "../plugins/error-handler.js";
import {
  TARGET_VENDORS,
  type TargetVendor,
  CancelDeploymentBodySchema,
  RedeployBodySchema,
} from "@camellia/contracts";
import { DeploymentService } from "../services/deployment-service.js";
import { idParams, toJsonSchema } from "../plugins/swagger.js";

const VALID_VENDORS = new Set<string>(TARGET_VENDORS);

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
        required: ["source", "project_id"],
        properties: {
          source: { type: "string", format: "binary", description: "소스 zip (최대 100MB)" },
          project_id: { type: "integer", minimum: 1 },
          target: {
            type: "string",
            enum: [...VALID_VENDORS],
            description: "environment_id 가 없으면 필수. 프로젝트 기본 연결 → 공용 기본 연결 순으로 고름",
          },
          environment_id: {
            type: "integer",
            minimum: 1,
            description: "배포할 연결 (공용 연결 또는 이 프로젝트 연결). 연결 type 이 target 을 정함 (#215)",
          },
        },
      },
    },
  }, async (request, reply) => {
    let fileBuffer: Buffer | undefined;
    let rawProjectId: string | undefined;
    let rawTarget: string | undefined;
    let rawEnvironmentId: string | undefined;
    for await (const part of request.parts()) {
      if (part.type === "file") {
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) chunks.push(chunk as Buffer);
        fileBuffer = Buffer.concat(chunks);
      } else if (part.fieldname === "project_id") {
        rawProjectId = rawProjectId === undefined && typeof part.value === "string" ? part.value : "";
      } else if (part.fieldname === "target") {
        rawTarget = rawTarget === undefined && typeof part.value === "string" ? part.value : "";
      } else if (part.fieldname === "environment_id") {
        rawEnvironmentId =
          rawEnvironmentId === undefined && typeof part.value === "string" ? part.value : "";
      }
    }
    if (!fileBuffer) {
      throw new ApiError(400, "VALIDATION_ERROR", "source 파일이 없습니다.", "multipart/form-data로 source 필드(zip 파일)를 포함하세요.");
    }
    if (fileBuffer.length === 0) {
      throw new ApiError(400, "VALIDATION_ERROR", "업로드된 파일이 비어 있습니다.");
    }
    if (fileBuffer.length > 100 * 1024 * 1024) {
      throw new ApiError(413, "FILE_TOO_LARGE", "zip 파일 크기가 100MB를 초과합니다.", "zip 파일 최대 크기는 100MB입니다.");
    }

    // environment_id: optional (#215) — 있으면 연결 type 이 target 을 정한다
    let environmentId: number | undefined;
    if (rawEnvironmentId !== undefined) {
      environmentId = Number(rawEnvironmentId);
      if (!/^\d+$/.test(rawEnvironmentId) || !Number.isSafeInteger(environmentId) || environmentId <= 0) {
        throw new ApiError(400, "VALIDATION_ERROR", "environment_id는 양수 정수여야 합니다.");
      }
    }

    // Validate target vendor (environment_id 가 있으면 생략 가능)
    if (rawTarget !== undefined || environmentId === undefined) {
      const target = rawTarget ?? "";
      if (!VALID_VENDORS.has(target)) {
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "target 은 aws 또는 onprem 이어야 합니다.",
          "올바른 target 벤더를 지정하거나 environment_id 로 연결을 고르세요."
        );
      }
    }

    // project_id: required
    const projectIdNum = rawProjectId ? Number(rawProjectId) : null;
    if (projectIdNum !== null && (!Number.isFinite(projectIdNum) || projectIdNum <= 0)) {
      throw new ApiError(400, "VALIDATION_ERROR", "project_id는 양수 정수여야 합니다.");
    }
    if (projectIdNum === null) {
      throw new ApiError(400, "VALIDATION_ERROR", "project_id 필드가 필요합니다.", "POST /projects 로 프로젝트를 먼저 생성하세요.");
    }

    // vendor → profile ID 매핑은 서비스가 최종 연결 type 으로 한다
    const result = await svc.create({
      projectId: projectIdNum,
      ...(rawTarget !== undefined ? { targetVendor: rawTarget as TargetVendor } : {}),
      ...(environmentId !== undefined ? { environmentId } : {}),
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

  // POST /deployments/:id/redeploy
  fastify.post<{ Params: { id: string }; Body: unknown }>("/:id/redeploy", {
    schema: {
      tags: ["deployments"],
      summary: "이전 소스 · IR 그대로 재배포 (분석 · target 승인 skip)",
      params: idParams,
      body: {
        type: "object",
        properties: {
          targetEnvironmentId: { type: "string", pattern: "^\\d+$", description: "환경 override (없으면 소스 배포 환경 그대로). 다른 종류 환경이면 프로필 · Registry 재선정" },
        },
      },
    },
  }, async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      throw new ApiError(400, "VALIDATION_ERROR", "배포 ID는 양수 정수여야 합니다.");
    }

    const parsed = RedeployBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError(400, "VALIDATION_ERROR", parsed.error.errors[0]?.message ?? "잘못된 요청");
    }

    const targetEnvironmentId = parsed.data.targetEnvironmentId
      ? Number(parsed.data.targetEnvironmentId)
      : undefined;

    const result = await svc.redeploy(id, { targetEnvironmentId });
    return reply.status(202).send(result);
  });

  // POST /deployments/:id/cancel — 진행 중 배포 취소
  fastify.post<{ Params: { id: string } }>("/:id/cancel", {
    schema: {
      tags: ["deployments"],
      summary: "진행 중 배포 취소 (cancelled 전이 + env_lock 해제, 200)",
      params: idParams,
      body: toJsonSchema(CancelDeploymentBodySchema),
    },
  }, async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      throw new ApiError(400, "VALIDATION_ERROR", "배포 ID는 양수 정수여야 합니다.");
    }

    const parsed = CancelDeploymentBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError(400, "VALIDATION_ERROR", parsed.error.errors[0]?.message ?? "잘못된 요청");
    }

    const result = await svc.cancel(id, parsed.data.reason);
    return reply.status(200).send(result);
  });
};

export default deploymentsRoutes;
