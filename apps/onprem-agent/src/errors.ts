import type { OnpremErrorCode } from "./contracts.js";

export class AgentError extends Error {
  constructor(
    public readonly code: OnpremErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AgentError("cancelled", "작업이 취소되었습니다.");
  }
}

export function normalizeAgentError(error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  return new AgentError("internal_error", "Agent 작업 실행에 실패했습니다.");
}
