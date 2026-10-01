import type {
  AgentControlPlaneClient,
  OnpremJobExecutor,
} from "./contracts.js";

type AgentServiceOptions = {
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
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly activeExecutions = new Set<Promise<void>>();

  constructor(
    private readonly client: AgentControlPlaneClient,
    private readonly executor: OnpremJobExecutor,
    options: AgentServiceOptions = {},
  ) {
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
    let heartbeatRunning = false;
    const heartbeat = async (): Promise<void> => {
      if (heartbeatRunning || controller.signal.aborted) return;
      heartbeatRunning = true;
      try {
        const result = await this.client.sendHeartbeat(job.jobId);
        if (result.jobCancelled) controller.abort();
      } finally {
        heartbeatRunning = false;
      }
    };
    const timer = setInterval(
      () => void heartbeat().catch(() => controller.abort()),
      this.heartbeatIntervalMs,
    );

    const execution = (async () => {
      try {
        await heartbeat();
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
