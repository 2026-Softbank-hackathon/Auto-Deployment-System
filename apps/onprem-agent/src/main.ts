import { AgentIdentityHttpClient, ensureAgentCredential } from "./agent-identity.js";
import { loadAgentConfig } from "./config.js";
import { NodeCommandRunner } from "./command-runner.js";
import { FileAgentCredentialStore } from "./credential-store.js";
import { DockerPrerequisiteChecker } from "./docker-readiness.js";
import { StructuredLogger } from "./logger.js";

const logger = new StructuredLogger();

async function main(): Promise<void> {
  try {
    const config = loadAgentConfig();
    const registrationToken = config.registrationToken;
    delete process.env.ONPREM_AGENT_REGISTRATION_TOKEN;

    const credentialStore = new FileAgentCredentialStore(config.stateDirectory);
    const storedCredential = await credentialStore.load();
    const controlPlaneUrl =
      storedCredential?.controlPlaneUrl ?? config.controlPlaneUrl;
    if (!controlPlaneUrl) {
      throw new Error(
        "최초 등록에는 ONPREM_CONTROL_PLANE_URL이 필요합니다.",
      );
    }
    const identityClient = new AgentIdentityHttpClient(controlPlaneUrl);
    const credential =
      storedCredential ??
      (await ensureAgentCredential({
        store: credentialStore,
        client: identityClient,
        registrationToken,
      }));
    await identityClient.sendHeartbeat(credential);
    logger.info("agent.identity.authenticated", {
      agentId: credential.agentId,
      environmentId: credential.environmentId,
    });

    if (process.argv.includes("--register-only")) {
      logger.info("agent.registration.completed", {
        agentId: credential.agentId,
        environmentId: credential.environmentId,
      });
      return;
    }

    await new DockerPrerequisiteChecker(new NodeCommandRunner()).assertReady();
    logger.error("agent.control_plane_not_configured", {
      agentId: credential.agentId,
      message:
        "서버 Job claim API가 확정되지 않아 실제 작업 수신은 아직 연결하지 않았습니다.",
    });
    process.exitCode = 1;
  } catch (error) {
    logger.error("agent.configuration_failed", {
      message:
        error instanceof Error ? error.message : "설정 검증에 실패했습니다.",
    });
    process.exitCode = 1;
  }
}

void main();
