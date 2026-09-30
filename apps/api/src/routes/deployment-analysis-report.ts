/**
 * apps/api/src/routes/deployment-analysis-report.ts
 * GET /deployments/:id/analysis-report (API-19)
 * ANL-07. 분석 완료 후 서비스·리소스·경고·미결 항목 조회.
 */

import { type FastifyPluginAsync } from "fastify";
import { ApiError } from "../plugins/error-handler.js";
import type { AnalysisReportService } from "../services/analysis-report-service.js";
import { idParams } from "../plugins/swagger.js";

const deploymentAnalysisReportRoutes: FastifyPluginAsync<{
  analysisReportService: AnalysisReportService;
}> = async (fastify, opts) => {
  const svc = opts.analysisReportService;

  fastify.get<{ Params: { id: string } }>(
    "/:id/analysis-report",
    { schema: { tags: ["deployments"], summary: "분석 리포트 조회", params: idParams } },
    async (request) => {
      const id = Number(request.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "배포 ID는 양수 정수여야 합니다.",
        );
      }
      return svc.get(id);
    },
  );
};

export default deploymentAnalysisReportRoutes;
