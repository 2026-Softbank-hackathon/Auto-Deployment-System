export type AgentConfig = {
  agentId: string;
  registrationToken: string;
  stateDirectory: string;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  cancellationPollIntervalMs: number;
};

function requireValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} 설정이 필요합니다.`);
  return value;
}

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
  const agentId = requireValue(environment, "ONPREM_AGENT_ID");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(agentId)) {
    throw new Error("ONPREM_AGENT_ID 형식이 올바르지 않습니다.");
  }
  const registrationToken = requireValue(
    environment,
    "ONPREM_AGENT_REGISTRATION_TOKEN",
  );
  if (registrationToken.length < 16) {
    throw new Error("ONPREM_AGENT_REGISTRATION_TOKEN이 너무 짧습니다.");
  }

  return {
    agentId,
    registrationToken,
    stateDirectory:
      environment.ONPREM_AGENT_STATE_DIR ?? ".camellia/onprem-agent",
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
