/**
 * apps/api/src/routes/deployment-approvals.ts
 * POST /deployments/:id/approvals
 * gate=target 승인 시: env_lock 획득 + 상태 전이 queued + SSE 브로드캐스트.
 */

import { type FastifyPluginAsync } from "fastify";
import { SubmitApprovalBodySchema, type DeploymentEventData } from "@camellia/contracts";
import { ApiError } from "../plugins/error-handler.js";
import { ApprovalService } from "../services/approval-service.js";
import { type SseBroker } from "../plugins/sse-broker.js";
import { idParams, toJsonSchema } from "../plugins/swagger.js";

const deploymentApprovalsRoutes: FastifyPluginAsync<{
  approvalService: ApprovalService;
  sseBroker: SseBroker;
}> = async (fastify, opts) => {
  const { approvalService, sseBroker } = opts;

  fastify.post<{ Params: { id: string } }>("/:id/approvals", {
    schema: {
      tags: ["deployments"],
      summary: "승인 게이트 결정 (target · plan)",
      params: idParams,
      body: toJsonSchema(SubmitApprovalBodySchema),
    },
  }, async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      throw new ApiError(400, "VALIDATION_ERROR", "배포 ID는 양수 정수여야 합니다.");
    }

    const body = SubmitApprovalBodySchema.parse(request.body);

    const result = await approvalService.submit({
      deploymentId: id,
      gate: body.gate,
      decision: body.decision,
      note: body.note,
    });

    // SSE: state_changed 브로드캐스트
    sseBroker.publish(String(id), {
      event: "state_changed",
      data: {
        deploymentId: String(id),
        // from 상태는 gate에서 추론
        from: body.gate === "target" ? "awaiting_target_confirmation" : "awaiting_plan_approval",
        to: result.newStatus,
        reason: body.decision === "reject" ? (body.note ?? "사용자 거절") : undefined,
      } satisfies DeploymentEventData<"state_changed">,
    });

    return reply.status(200).send(result);
  });
};

export default deploymentApprovalsRoutes;
