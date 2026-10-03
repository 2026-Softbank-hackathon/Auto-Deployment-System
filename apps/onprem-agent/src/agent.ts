import type {
  AgentControlPlaneClient,
  OnpremJobExecutor,
} from "./contracts.js";

type AgentServiceOptions = {
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  retryInitialMs?: number;
  retryMaxMs?: number;
  leaseDurationMs?: number;
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
  private readonly retryInitialMs: number;
  private readonly retryMaxMs: number;
  private readonly leaseDurationMs: number;
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly activeExecutions = new Set<Promise<void>>();

  constructor(
    private readonly client: AgentControlPlaneClient,
    private readonly executor: OnpremJobExecutor,
    options: AgentServiceOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 2_000;
    this.retryInitialMs = options.retryInitialMs ?? 1_000;
    this.retryMaxMs = options.retryMaxMs ?? 30_000;
    this.leaseDurationMs = options.leaseDurationMs ?? 90_000;
  }

  async sendHeartbeat(currentJobId?: string): Promise<void> {
    const runtimes = await this.executor.inventory?.() ?? [];
    const result = await this.client.sendHeartbeat(currentJobId, runtimes);
    if (result.desiredDeploymentIds) {
      await this.executor.reconcile?.(result.desiredDeploymentIds);
    }
  }

  async pollOnce(): Promise<boolean> {
    const cleanupJob = await this.client.claimCleanupJob();
    if (cleanupJob) {
      const startedAt = new Date().toISOString();
      try {
        await this.executor.cleanup?.(cleanupJob.deploymentId);
        await this.client.reportCleanupResult(cleanupJob.jobId, {
          ...cleanupJob,
          status: "succeeded",
          startedAt,
          finishedAt: new Date().toISOString(),
        });
      } catch (error) {
        await this.client.reportCleanupResult(cleanupJob.jobId, {
          ...cleanupJob,
          status: "failed",
          errorCode: "cleanup_failed",
          errorMessage: error instanceof Error ? error.message.slice(0, 500) : "cleanup failed",
          startedAt,
          finishedAt: new Date().toISOString(),
        });
      }
      return true;
    }

    const job = await this.client.claimJob();
    if (!job) return false;

    const controller = new AbortController();
    this.activeControllers.set(job.jobId, controller);
    let heartbeatRunning = false;
    let lastLeaseRenewedAt = Date.now();
    const heartbeat = async (): Promise<void> => {
      if (heartbeatRunning || controller.signal.aborted) return;
      heartbeatRunning = true;
      try {
        const runtimes = await this.executor.inventory?.() ?? [];
        const result = await this.client.sendHeartbeat(job.jobId, runtimes);
        lastLeaseRenewedAt = Date.now();
        if (result.desiredDeploymentIds) {
          await this.executor.reconcile?.(result.desiredDeploymentIds);
        }
        if (result.jobCancelled) controller.abort();
      } catch (error) {
        if (Date.now() - lastLeaseRenewedAt >= this.leaseDurationMs) {
          controller.abort(error);
        }
      } finally {
        heartbeatRunning = false;
      }
    };
    const timer = setInterval(
      () => void heartbeat(),
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
    let retryDelay = this.retryInitialMs;
    let restored = false;
    try {
      while (!signal.aborted) {
        try {
          if (!restored) {
            await this.executor.restore?.();
            restored = true;
          }
          const now = Date.now();
          if (now - lastHeartbeat >= this.heartbeatIntervalMs) {
            await this.sendHeartbeat();
            lastHeartbeat = now;
          }
          if (signal.aborted) break;
          const claimed = await this.pollOnce();
          retryDelay = this.retryInitialMs;
          if (!claimed) {
            await wait(this.pollIntervalMs, signal).catch(() => undefined);
          }
        } catch {
          if (signal.aborted) break;
          await wait(retryDelay, signal).catch(() => undefined);
          retryDelay = Math.min(this.retryMaxMs, retryDelay * 2);
        }
      }
    } finally {
      await this.shutdown();
    }
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
