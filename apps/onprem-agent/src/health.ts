import type { OnpremAgentJob } from "./contracts.js";
import { AgentError, throwIfAborted } from "./errors.js";

export interface HealthChecker {
  waitUntilHealthy(
    localUrl: string,
    job: OnpremAgentJob,
    signal?: AbortSignal,
  ): Promise<void>;
}

type LocalHealthCheckerOptions = {
  attempts?: number;
  intervalMs?: number;
  fetcher?: typeof fetch;
};

export class LocalHealthChecker implements HealthChecker {
  private readonly attempts: number;
  private readonly intervalMs: number;
  private readonly fetcher: typeof fetch;

  constructor(options: LocalHealthCheckerOptions = {}) {
    this.attempts = options.attempts ?? 8;
    this.intervalMs = options.intervalMs ?? 1_000;
    this.fetcher = options.fetcher ?? fetch;
  }

  async waitUntilHealthy(
    localUrl: string,
    job: OnpremAgentJob,
    signal?: AbortSignal,
  ): Promise<void> {
    const target = new URL(job.plan.health.path, `${localUrl}/`).toString();

    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      throwIfAborted(signal);
      const timeout = AbortSignal.timeout(job.plan.health.timeoutSeconds * 1_000);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const response = await this.fetcher(target, { signal: combined });
        if (response.status === job.plan.health.expectedStatus) return;
      } catch (error) {
        if (signal?.aborted) throwIfAborted(signal);
        void error;
      }

      if (attempt < this.attempts) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, this.intervalMs);
          const abort = (): void => {
            clearTimeout(timer);
            reject(new AgentError("cancelled", "작업이 취소되었습니다."));
          };
          signal?.addEventListener("abort", abort, { once: true });
        });
      }
    }

    throw new AgentError(
      "health_check_failed",
      "로컬 endpoint 헬스체크에 실패했습니다.",
    );
  }
}
