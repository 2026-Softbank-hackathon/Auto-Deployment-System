/**
 * apps/api/src/routes/deployment-missing.ts
 * POST /deployments/:id/missing-resources
 * awaiting_target_confirmation 상태에서만 유효.
 * 결정을 IR의 missing_resources_decisions에 병합해 새 ir_versions row 생성.
 */

import { type FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ApiError } from "../plugins/error-handler.js";
import type { Pool } from "@camellia/db";
import { IrSchema } from "@camellia/ir-schema";
import { type SseBroker } from "../plugins/sse-broker.js";
import { idParams, toJsonSchema } from "../plugins/swagger.js";

const MissingResourceDecisionSchema = z.object({
  resource: z.string().min(1),
  action: z.enum(["exclude", "add_module"]),
  moduleId: z.string().optional(),
});

const SubmitMissingResourcesBodySchema = z.object({
  decisions: z.array(MissingResourceDecisionSchema).min(1),
});

const deploymentMissingRoutes: FastifyPluginAsync<{
  pool: Pool;
  sseBroker: SseBroker;
}> = async (fastify, opts) => {
  const { pool, sseBroker } = opts;

  fastify.post<{ Params: { id: string } }>("/:id/missing-resources", {
    schema: {
      tags: ["deployments"],
      summary: "누락 리소스 결정 제출 (awaiting_target_confirmation)",
      params: idParams,
      body: toJsonSchema(SubmitMissingResourcesBodySchema),
    },
  }, async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      throw new ApiError(400, "VALIDATION_ERROR", "배포 ID는 양수 정수여야 합니다.");
    }

    const body = SubmitMissingResourcesBodySchema.parse(request.body);

    // 1. 배포 상태 확인
    const depRes = await pool.query<{ status: string }>(
      `SELECT status FROM deployments WHERE id = $1`,
      [id]
    );
    const dep = depRes.rows[0];
    if (!dep) {
      throw new ApiError(404, "NOT_FOUND", `배포 ID ${id}를 찾을 수 없습니다.`);
    }
    if (dep.status !== "awaiting_target_confirmation") {
      throw new ApiError(
        409,
        "CONFLICT",
        `missing-resources 결정은 awaiting_target_confirmation 상태에서만 가능합니다. 현재 상태: ${dep.status}`,
        "awaiting_target_confirmation 상태에서 다시 시도하세요."
      );
    }

    // 2. 최신 IR 조회
    const irRes = await pool.query<{ id: number; ir_json: Record<string, unknown> }>(
      `SELECT id, ir_json FROM ir_versions
       WHERE deployment_id = $1
       ORDER BY id DESC LIMIT 1`,
      [id]
    );
    const irRow = irRes.rows[0];
    if (!irRow) {
      throw new ApiError(404, "NOT_FOUND", `배포 ID ${id}의 IR이 없습니다.`);
    }

    // 3. missing_resources_decisions 병합
    const currentIr = irRow.ir_json as Record<string, unknown>;
    const existingDecisions = (currentIr["missing_resources_decisions"] as unknown[] | undefined) ?? [];

    const decisionMap = new Map<string, unknown>();
    for (const d of existingDecisions) {
      const dd = d as { resource_name: string };
      decisionMap.set(dd.resource_name, d);
    }

    const now = new Date().toISOString();
    for (const decision of body.decisions) {
      decisionMap.set(decision.resource, {
        resource_name: decision.resource,
        decision: decision.action,
        module_id: decision.moduleId,
        decided_at: now,
      });
    }

    const updatedIr: Record<string, unknown> = {
      ...currentIr,
      missing_resources_decisions: Array.from(decisionMap.values()),
    };

    // 4. IrSchema 검증
    const parsed = IrSchema.safeParse(updatedIr);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new ApiError(400, "VALIDATION_ERROR", `IR 스키마 오류: ${msg}`);
    }

    // 5. 새 ir_versions row 삽입
    await pool.query(
      `INSERT INTO ir_versions (deployment_id, ir_json, source)
       VALUES ($1, $2, 'user_edited')`,
      [id, JSON.stringify(parsed.data)]
    );

    // 6. remaining 계산 (decision이 없는 missing resource 수)
    const allDecisions = Array.from(decisionMap.values()) as Array<{ decision?: string }>;
    const remaining = allDecisions.filter((d) => !d.decision || d.decision === "pending").length;
    const resolved = body.decisions.length;

    // SSE 브로드캐스트
    sseBroker.publish(String(id), {
      event: "missing_resources_updated",
      data: { deploymentId: String(id), resolved, remaining },
    });

    return reply.status(200).send({
      deploymentId: String(id),
      resolved,
      remaining,
      updatedIr: parsed.data,
    });
  });
};

export default deploymentMissingRoutes;
