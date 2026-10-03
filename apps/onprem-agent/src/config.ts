import { homedir } from "node:os";
import { join, win32 } from "node:path";

export type AgentConfig = {
  controlPlaneUrl?: string;
  registrationToken?: string;
  stateDirectory: string;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
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

/** macOS는 ~/Library/Application Support, Windows는 %LOCALAPPDATA% 아래. 설치 스크립트도 같은 위치를 쓴다. */
export function defaultStateDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return win32.join(
      environment.LOCALAPPDATA ?? win32.join(homedir(), "AppData", "Local"),
      "Camellia",
      "onprem-agent",
    );
  }
  return join(homedir(), "Library", "Application Support", "Camellia", "onprem-agent");
}

export function loadAgentConfig(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): AgentConfig {
  const registrationToken = environment.ONPREM_AGENT_REGISTRATION_TOKEN;
  if (registrationToken !== undefined && registrationToken.length < 16) {
    throw new Error("ONPREM_AGENT_REGISTRATION_TOKEN이 너무 짧습니다.");
  }

  return {
    controlPlaneUrl: environment.ONPREM_CONTROL_PLANE_URL,
    registrationToken,
    stateDirectory:
      environment.ONPREM_AGENT_STATE_DIR ?? defaultStateDirectory(environment, platform),
    pollIntervalMs: positiveInteger(
      environment,
      "ONPREM_AGENT_POLL_INTERVAL_MS",
      2_000,
    ),
    heartbeatIntervalMs: positiveInteger(
      environment,
      "ONPREM_AGENT_HEARTBEAT_INTERVAL_MS",
      2_000,
    ),
  };
}
