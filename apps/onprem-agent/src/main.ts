import { loadAgentConfig } from "./config.js";
import { StructuredLogger } from "./logger.js";

const logger = new StructuredLogger();

try {
  const config = loadAgentConfig();
  logger.info("agent.config.validated", { agentId: config.agentId });
  logger.error("agent.control_plane_not_configured", {
    agentId: config.agentId,
    message:
      "서버 Agent API 경로가 확정되지 않아 실제 Control Plane Client는 아직 연결하지 않았습니다.",
  });
  process.exitCode = 1;
} catch (error) {
  logger.error("agent.configuration_failed", {
    message: error instanceof Error ? error.message : "설정 검증에 실패했습니다.",
  });
  process.exitCode = 1;
}
