import { homedir } from "node:os";
import { join } from "node:path";

export type AgentConfig = {
  controlPlaneUrl?: string;
  registrationToken?: string;
  stateDirectory: string;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  cancellationPollIntervalMs: number;
};

function positiveInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} 설정은 양의 정수여야 합니다.`);
  }
  return value;
}

export function loadAgentConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AgentConfig {
  const registrationToken = environment.ONPREM_AGENT_REGISTRATION_TOKEN;
  if (registrationToken !== undefined && registrationToken.length < 16) {
    throw new Error("ONPREM_AGENT_REGISTRATION_TOKEN이 너무 짧습니다.");
  }

  return {
    controlPlaneUrl: environment.ONPREM_CONTROL_PLANE_URL,
    registrationToken,
    stateDirectory:
      environment.ONPREM_AGENT_STATE_DIR ??
      join(homedir(), "Library", "Application Support", "Camellia", "onprem-agent"),
    pollIntervalMs: positiveInteger(
      environment,
      "ONPREM_AGENT_POLL_INTERVAL_MS",
      2_000,
    ),
    heartbeatIntervalMs: positiveInteger(
      environment,
      "ONPREM_AGENT_HEARTBEAT_INTERVAL_MS",
      15_000,
    ),
    cancellationPollIntervalMs: positiveInteger(
      environment,
      "ONPREM_AGENT_CANCELLATION_POLL_INTERVAL_MS",
      1_000,
    ),
  };
}
