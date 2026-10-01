import { AgentIdentityHttpClient, ensureAgentCredential } from "./agent-identity.js";
import { AgentService, installShutdownHandlers } from "./agent.js";
import { NodeBackgroundProcessRunner } from "./background-process.js";
import { DockerComposeRuntime } from "./compose.js";
import { loadAgentConfig } from "./config.js";
import { NodeCommandRunner } from "./command-runner.js";
import { AgentControlPlaneHttpClient } from "./control-plane-client.js";
import { FileAgentCredentialStore } from "./credential-store.js";
import { DockerPrerequisiteChecker } from "./docker-readiness.js";
import { EcrImageManager } from "./ecr.js";
import { DockerOnpremJobExecutor } from "./executor.js";
import { StructuredLogger } from "./logger.js";
import { CloudflaredTunnelProvider } from "./tunnel.js";
import { join } from "node:path";

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
    const controlPlaneClient = new AgentControlPlaneHttpClient(credential);
    await controlPlaneClient.sendHeartbeat();
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

    const commandRunner = new NodeCommandRunner();
    await new DockerPrerequisiteChecker(commandRunner).assertReady();
    const tunnelProvider = new CloudflaredTunnelProvider({
      sessions: controlPlaneClient,
      processes: new NodeBackgroundProcessRunner(),
    });
    const executor = new DockerOnpremJobExecutor({
      imageManager: new EcrImageManager(controlPlaneClient, commandRunner),
      runtimeManager: new DockerComposeRuntime(commandRunner, {
        stateRoot: join(config.stateDirectory, "deployments"),
      }),
      tunnelProvider,
    });
    const service = new AgentService(controlPlaneClient, executor, {
      pollIntervalMs: config.pollIntervalMs,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
    });
    const shutdown = new AbortController();
    const removeShutdownHandlers = installShutdownHandlers(shutdown);
    logger.info("agent.started", {
      agentId: credential.agentId,
      environmentId: credential.environmentId,
    });
    try {
      await service.run(shutdown.signal);
    } finally {
      removeShutdownHandlers();
    }
  } catch (error) {
    logger.error("agent.configuration_failed", {
      message:
        error instanceof Error ? error.message : "설정 검증에 실패했습니다.",
    });
    process.exitCode = 1;
  }
}

void main();
