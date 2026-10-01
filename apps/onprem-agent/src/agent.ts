import type {
  AgentControlPlaneClient,
  OnpremJobExecutor,
} from "./contracts.js";

type AgentServiceOptions = {
  cancellationPollIntervalMs?: number;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
};

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export class AgentService {
  private readonly cancellationPollIntervalMs: number;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly activeExecutions = new Set<Promise<void>>();

  constructor(
    private readonly client: AgentControlPlaneClient,
    private readonly executor: OnpremJobExecutor,
    options: AgentServiceOptions = {},
  ) {
    this.cancellationPollIntervalMs =
      options.cancellationPollIntervalMs ?? 1_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
  }

  async sendHeartbeat(): Promise<void> {
    await this.client.sendHeartbeat();
  }

  async pollOnce(): Promise<boolean> {
    const job = await this.client.claimJob();
    if (!job) return false;

    const controller = new AbortController();
    this.activeControllers.set(job.jobId, controller);
    let cancellationCheckRunning = false;
    const checkCancellation = async (): Promise<void> => {
      if (cancellationCheckRunning || controller.signal.aborted) return;
      cancellationCheckRunning = true;
      try {
        if (await this.client.isJobCancelled(job.jobId)) controller.abort();
      } finally {
        cancellationCheckRunning = false;
      }
    };
    const timer = setInterval(
      () => void checkCancellation().catch(() => undefined),
      this.cancellationPollIntervalMs,
    );

    const execution = (async () => {
      try {
        await checkCancellation();
        const result = await this.executor.execute(job, {
          signal: controller.signal,
        });
        await this.client.reportResult(job.jobId, result);
      } finally {
        clearInterval(timer);
        this.activeControllers.delete(job.jobId);
      }
    })();
    const tracked = execution.then(() => undefined);
    this.activeExecutions.add(tracked);
    try {
      await tracked;
    } finally {
      this.activeExecutions.delete(tracked);
    }
    return true;
  }

  async run(signal: AbortSignal): Promise<void> {
    let lastHeartbeat = 0;
    while (!signal.aborted) {
      const now = Date.now();
      if (now - lastHeartbeat >= this.heartbeatIntervalMs) {
        await this.sendHeartbeat();
        lastHeartbeat = now;
      }
      const claimed = await this.pollOnce();
      if (!claimed) {
        await wait(this.pollIntervalMs, signal).catch(() => undefined);
      }
    }
    await this.shutdown();
  }

  async shutdown(): Promise<void> {
    for (const controller of this.activeControllers.values()) {
      controller.abort();
    }
    await Promise.allSettled([...this.activeExecutions]);
    await this.executor.shutdown?.();
  }
}

export function installShutdownHandlers(controller: AbortController): () => void {
  const shutdown = (): void => controller.abort();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return () => {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
  };
}
