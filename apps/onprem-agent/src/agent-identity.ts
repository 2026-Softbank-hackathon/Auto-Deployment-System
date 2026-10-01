import type {
  AgentCredential,
  AgentCredentialStore,
} from "./credential-store.js";

type Fetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

type RegisterAgentResponse = {
  agentId: string;
  environmentId: string;
  longLivedKey: string;
};

export type AgentHeartbeatResult = {
  deploymentCancelled?: boolean;
};

function normalizeControlPlaneUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Control Plane URL이 올바르지 않습니다.");
  }
  const loopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Control Plane URL이 올바르지 않습니다.");
  }
  return url.origin;
}

function isRegisterAgentResponse(value: unknown): value is RegisterAgentResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 3 &&
    typeof candidate.agentId === "string" &&
    /^\d+$/.test(candidate.agentId) &&
    typeof candidate.environmentId === "string" &&
    /^\d+$/.test(candidate.environmentId) &&
    typeof candidate.longLivedKey === "string" &&
    candidate.longLivedKey.length > 0
  );
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("Control Plane 응답 형식이 올바르지 않습니다.");
  }
}

export class AgentIdentityHttpClient {
  readonly controlPlaneUrl: string;

  constructor(
    controlPlaneUrl: string,
    private readonly fetchRequest: Fetch = fetch,
  ) {
    this.controlPlaneUrl = normalizeControlPlaneUrl(controlPlaneUrl);
  }

  async register(
    registrationToken: string,
    signal?: AbortSignal,
  ): Promise<AgentCredential> {
    let response: Response;
    try {
      response = await this.fetchRequest(
        `${this.controlPlaneUrl}/api/v1/agents/register`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ registrationToken }),
          signal,
        },
      );
    } catch {
      throw new Error("Agent 등록 요청에 실패했습니다.");
    }
    if (response.status !== 201) {
      throw new Error(`Agent 등록에 실패했습니다. (HTTP ${response.status})`);
    }
    const body = await responseJson(response);
    if (!isRegisterAgentResponse(body)) {
      throw new Error("Agent 등록 응답 형식이 올바르지 않습니다.");
    }
    return {
      controlPlaneUrl: this.controlPlaneUrl,
      agentId: body.agentId,
      environmentId: body.environmentId,
      agentKey: body.longLivedKey,
    };
  }

  async sendHeartbeat(
    credential: AgentCredential,
    currentJobId?: string,
    signal?: AbortSignal,
  ): Promise<AgentHeartbeatResult> {
    if (credential.controlPlaneUrl !== this.controlPlaneUrl) {
      throw new Error("저장된 Agent 인증정보의 Control Plane이 일치하지 않습니다.");
    }
    let response: Response;
    try {
      response = await this.fetchRequest(
        `${this.controlPlaneUrl}/api/v1/agents/heartbeat`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${credential.agentKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(currentJobId ? { currentJobId } : {}),
          signal,
        },
      );
    } catch {
      throw new Error("Agent Heartbeat 요청에 실패했습니다.");
    }
    if (response.status !== 200) {
      throw new Error(`Agent Heartbeat에 실패했습니다. (HTTP ${response.status})`);
    }
    const body = await responseJson(response);
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      (body as Record<string, unknown>).ok !== true ||
      ("deploymentCancelled" in body &&
        typeof (body as Record<string, unknown>).deploymentCancelled !== "boolean")
    ) {
      throw new Error("Agent Heartbeat 응답 형식이 올바르지 않습니다.");
    }
    const deploymentCancelled = (body as Record<string, unknown>)
      .deploymentCancelled;
    return deploymentCancelled === undefined
      ? {}
      : { deploymentCancelled: deploymentCancelled as boolean };
  }
}

export async function ensureAgentCredential(input: {
  store: AgentCredentialStore;
  client: AgentIdentityHttpClient;
  registrationToken?: string;
  signal?: AbortSignal;
}): Promise<AgentCredential> {
  const stored = await input.store.load();
  if (stored) return stored;
  if (!input.registrationToken) {
    throw new Error("최초 등록에는 ONPREM_AGENT_REGISTRATION_TOKEN이 필요합니다.");
  }
  // 1회용 토큰 소비 후 저장 실패하는 경우를 줄이기 위해 로컬 저장소를 먼저 준비한다.
  await input.store.prepare();
  const credential = await input.client.register(
    input.registrationToken,
    input.signal,
  );
  await input.store.save(credential);
  return credential;
}
