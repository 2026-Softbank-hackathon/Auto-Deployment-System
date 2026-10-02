import type {
  AgentRuntimeReport,
  ImageManager,
  OnpremAgentJob,
  OnpremExecutionResult,
  OnpremJobExecutor,
  RunningDeployment,
  RuntimeManager,
  TunnelProvider,
} from "./contracts.js";
import type {
  PersistedRuntime,
  RuntimeStateStore,
} from "./runtime-state-store.js";
import {
  AgentError,
  normalizeAgentError,
  throwIfAborted,
} from "./errors.js";
import { parseOnpremAgentJob } from "./validation.js";

type ExecutorOptions = {
  imageManager: ImageManager;
  runtimeManager: RuntimeManager;
  tunnelProvider?: TunnelProvider;
  stateStore?: RuntimeStateStore;
  now?: () => Date;
};

type JobRecord = {
  attempt: number;
  promise: Promise<OnpremExecutionResult>;
};

type ActiveDeployment = {
  deploymentId: number;
  digest: string;
  result: Extract<OnpremExecutionResult, { status: "ready_for_verify" }>;
  resources: RunningDeployment;
  persisted: PersistedRuntime;
};

type DeploymentRun = {
  digest: string;
  promise: Promise<OnpremExecutionResult>;
};

function deploymentKey(job: OnpremAgentJob): string {
  return `${job.deploymentId}:${job.environmentId}`;
}

function extractLoopbackPort(localUrl: string): number {
  let url: URL;
  try {
    url = new URL(localUrl);
  } catch {
    throw new AgentError("tunnel_failed", "로컬 endpoint가 올바르지 않습니다.");
  }
  const localPort = Number(url.port);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !Number.isSafeInteger(localPort) ||
    localPort < 1 ||
    localPort > 65_535 ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new AgentError("tunnel_failed", "로컬 endpoint가 올바르지 않습니다.");
  }
  return localPort;
}

function cloneResultForJob(
  result: OnpremExecutionResult,
  job: OnpremAgentJob,
): OnpremExecutionResult {
  return {
    ...result,
    deploymentId: job.deploymentId,
    environmentId: job.environmentId,
    jobId: job.jobId,
  };
}

export class DockerOnpremJobExecutor implements OnpremJobExecutor {
  private readonly imageManager: ImageManager;
  private readonly runtimeManager: RuntimeManager;
  private readonly tunnelProvider?: TunnelProvider;
  private readonly stateStore?: RuntimeStateStore;
  private readonly now: () => Date;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly activeDeployments = new Map<string, ActiveDeployment>();
  private readonly deploymentRuns = new Map<string, DeploymentRun>();

  constructor(options: ExecutorOptions) {
    this.imageManager = options.imageManager;
    this.runtimeManager = options.runtimeManager;
    this.tunnelProvider = options.tunnelProvider;
    this.stateStore = options.stateStore;
    this.now = options.now ?? (() => new Date());
  }

  async execute(
    input: OnpremAgentJob,
    options: { signal?: AbortSignal } = {},
  ): Promise<OnpremExecutionResult> {
    let job: OnpremAgentJob;
    try {
      job = parseOnpremAgentJob(input);
    } catch (error) {
      return this.failureResult(input, normalizeAgentError(error), this.now());
    }

    const existingJob = this.jobs.get(job.jobId);
    if (existingJob && existingJob.attempt >= job.attempt) {
      return existingJob.promise;
    }
    if (existingJob) {
      const previous = await existingJob.promise;
      if (previous.status === "ready_for_verify" || previous.errorCode === "cancelled") {
        return previous;
      }
    }

    if (options.signal?.aborted) {
      const cancelled = Promise.resolve(
        this.failureResult(
          job,
          new AgentError("cancelled", "작업이 취소되었습니다."),
          this.now(),
        ),
      );
      this.jobs.set(job.jobId, { attempt: job.attempt, promise: cancelled });
      return cancelled;
    }

    const key = deploymentKey(job);
    const active = this.activeDeployments.get(key);
    if (active?.digest === job.image.digest) {
      if (await this.isDeploymentRunning(active)) {
        const current = Promise.resolve(cloneResultForJob(active.result, job));
        this.jobs.set(job.jobId, { attempt: job.attempt, promise: current });
        return current;
      }
      await this.tunnelProvider?.stop(active.deploymentId).catch(() => undefined);
      await active.resources.cleanup().catch(() => undefined);
      await this.stateStore?.remove(active.deploymentId).catch(() => undefined);
      this.activeDeployments.delete(key);
    }

    const inFlight = this.deploymentRuns.get(key);
    if (inFlight?.digest === job.image.digest) {
      const current = inFlight.promise.then((result) =>
        cloneResultForJob(result, job),
      );
      this.jobs.set(job.jobId, { attempt: job.attempt, promise: current });
      return current;
    }

    const predecessor = inFlight?.promise.catch(() => undefined);
    const execution: Promise<OnpremExecutionResult> = (
      predecessor ?? Promise.resolve()
    ).then(async () => {
      const latest = this.activeDeployments.get(key);
      if (latest?.digest === job.image.digest) {
        if (await this.isDeploymentRunning(latest)) {
          return cloneResultForJob(latest.result, job);
        }
        await this.tunnelProvider?.stop(latest.deploymentId).catch(() => undefined);
        await latest.resources.cleanup().catch(() => undefined);
        await this.stateStore?.remove(latest.deploymentId).catch(() => undefined);
        this.activeDeployments.delete(key);
      }
      return this.perform(job, options.signal);
    });
    this.jobs.set(job.jobId, { attempt: job.attempt, promise: execution });
    this.deploymentRuns.set(key, { digest: job.image.digest, promise: execution });
    void execution.finally(() => {
      if (this.deploymentRuns.get(key)?.promise === execution) {
        this.deploymentRuns.delete(key);
      }
    });
    return execution;
  }

  private async isDeploymentRunning(
    deployment: ActiveDeployment,
  ): Promise<boolean> {
    if (!(await deployment.resources.isRunning())) return false;
    if (!this.tunnelProvider?.isRunning) return true;
    try {
      return await this.tunnelProvider.isRunning(deployment.deploymentId);
    } catch {
      return false;
    }
  }

  private async perform(
    job: OnpremAgentJob,
    signal?: AbortSignal,
  ): Promise<OnpremExecutionResult> {
    const startedAt = this.now();
    const key = deploymentKey(job);
    const previous = this.activeDeployments.get(key);
    let running: RunningDeployment | undefined;
    let tunnelStarted = false;
    let preparedDigest: string | undefined;
    let localUrl: string | undefined;

    try {
      throwIfAborted(signal);
      const prepared = await this.imageManager.prepare(job, signal);
      preparedDigest = prepared.runningDigest;
      throwIfAborted(signal);
      running = await this.runtimeManager.start(job, prepared.imageUri, signal);
      localUrl = running.localUrl;
      throwIfAborted(signal);

      if (!this.tunnelProvider) {
        throw new AgentError(
          "tunnel_not_configured",
          "Tunnel Provider가 설정되지 않았습니다.",
        );
      }
      let tunnel;
      try {
        tunnel = await this.tunnelProvider.start({
          jobId: job.jobId,
          deploymentId: job.deploymentId,
          environmentId: job.environmentId,
          localPort: extractLoopbackPort(running.localUrl),
        }, { signal });
        tunnelStarted = true;
      } catch (error) {
        if (normalizeAgentError(error).code === "cancelled") throw error;
        throw new AgentError("tunnel_failed", "Tunnel 시작에 실패했습니다.");
      }
      throwIfAborted(signal);
      if (!/^https:\/\/[^\s/]+(?:\/.*)?$/.test(tunnel.endpoint)) {
        throw new AgentError(
          "tunnel_failed",
          "Tunnel endpoint가 올바르지 않습니다.",
        );
      }

      const result: Extract<
        OnpremExecutionResult,
        { status: "ready_for_verify" }
      > = {
        deploymentId: job.deploymentId,
        environmentId: job.environmentId,
        jobId: job.jobId,
        status: "ready_for_verify",
        imageUri: prepared.imageUri,
        runningDigest: prepared.runningDigest,
        localUrl: running.localUrl,
        endpoint: tunnel.endpoint,
        startedAt: startedAt.toISOString(),
        finishedAt: this.now().toISOString(),
      };

      const persisted: PersistedRuntime = {
        jobId: job.jobId,
        deploymentId: job.deploymentId,
        environmentId: job.environmentId,
        digest: job.image.digest,
        imageUri: prepared.imageUri,
        projectName: running.projectName,
        localUrl: running.localUrl,
        endpoint: tunnel.endpoint,
        health: job.plan.health,
      };

      if (previous && previous.resources !== running) {
        await previous.resources.cleanup();
      }
      await this.stateStore?.save(persisted);
      this.activeDeployments.set(key, {
        deploymentId: job.deploymentId,
        digest: job.image.digest,
        result,
        resources: running,
        persisted,
      });
      return result;
    } catch (error) {
      const normalized = normalizeAgentError(error);
      if (tunnelStarted && this.tunnelProvider) {
        await this.tunnelProvider.stop(job.deploymentId).catch(() => undefined);
      }
      if (running) await running.cleanup().catch(() => undefined);
      return this.failureResult(job, normalized, startedAt, {
        runningDigest: preparedDigest,
        localUrl,
      });
    }
  }

  async restore(): Promise<void> {
    if (!this.stateStore || !this.runtimeManager.restore) return;
    const records = await this.stateStore.load();
    let firstError: unknown;
    for (const persisted of records) {
      const key = `${persisted.deploymentId}:${persisted.environmentId}`;
      if (this.activeDeployments.has(key)) continue;
      try {
        const resources = await this.runtimeManager.restore({
          projectName: persisted.projectName,
          localUrl: persisted.localUrl,
          health: persisted.health,
        });
        if (!resources) {
          await this.stateStore.remove(persisted.deploymentId);
          continue;
        }
        if (!this.tunnelProvider) throw new Error("Tunnel Provider가 설정되지 않았습니다.");
        const tunnel = await this.tunnelProvider.start({
          jobId: persisted.jobId,
          deploymentId: persisted.deploymentId,
          environmentId: persisted.environmentId,
          localPort: extractLoopbackPort(persisted.localUrl),
        });
        const timestamp = this.now().toISOString();
        this.activeDeployments.set(key, {
          deploymentId: persisted.deploymentId,
          digest: persisted.digest,
          resources,
          persisted,
          result: {
            deploymentId: persisted.deploymentId,
            environmentId: persisted.environmentId,
            jobId: persisted.jobId,
            status: "ready_for_verify",
            imageUri: persisted.imageUri,
            runningDigest: persisted.digest,
            localUrl: persisted.localUrl,
            endpoint: tunnel.endpoint,
            startedAt: timestamp,
            finishedAt: timestamp,
          },
        });
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  }

  async inventory(): Promise<AgentRuntimeReport[]> {
    const reports = await Promise.all(
      [...this.activeDeployments.values()].map(async (deployment) => {
        const containerRunning = await deployment.resources.isRunning().catch(() => false);
        const tunnelRunning = this.tunnelProvider?.isRunning
          ? await this.tunnelProvider.isRunning(deployment.deploymentId).catch(() => false)
          : true;
        const running = containerRunning && tunnelRunning;
        const healthy = running && deployment.resources.isHealthy
          ? await deployment.resources.isHealthy().catch(() => false)
          : undefined;
        return {
          deploymentId: String(deployment.deploymentId),
          digest: deployment.digest,
          status: running ? "running" as const : "stopped" as const,
          health: healthy === undefined
            ? "unknown" as const
            : healthy
              ? "healthy" as const
              : "unhealthy" as const,
        };
      }),
    );
    return reports.sort(
      (left, right) => Number(left.deploymentId) - Number(right.deploymentId),
    );
  }

  async reconcile(desiredDeploymentIds: string[]): Promise<void> {
    const desired = new Set(desiredDeploymentIds);
    const obsolete = [...this.activeDeployments.entries()].filter(
      ([, deployment]) => !desired.has(String(deployment.deploymentId)),
    );
    await Promise.all(
      obsolete.map(async ([key, deployment]) => {
        await this.tunnelProvider?.stop(deployment.deploymentId).catch(() => undefined);
        await deployment.resources.cleanup().catch(() => undefined);
        await this.stateStore?.remove(deployment.deploymentId).catch(() => undefined);
        this.activeDeployments.delete(key);
      }),
    );
  }

  async shutdown(): Promise<void> {
    const deployments = [...this.activeDeployments.values()];
    this.activeDeployments.clear();
    this.jobs.clear();
    this.deploymentRuns.clear();
    await Promise.allSettled(
      deployments.map(
        (deployment) =>
          this.tunnelProvider?.stop(deployment.deploymentId) ?? Promise.resolve(),
      ),
    );
  }

  private failureResult(
    job: Partial<OnpremAgentJob>,
    error: AgentError,
    startedAt: Date,
    details: { runningDigest?: string; localUrl?: string } = {},
  ): OnpremExecutionResult {
    const repositoryUri = job.image?.repositoryUri ?? "";
    const digest = job.image?.digest ?? "";
    return {
      deploymentId: job.deploymentId ?? 0,
      environmentId: job.environmentId ?? "",
      jobId: job.jobId ?? "",
      status: "failed",
      imageUri:
        repositoryUri && digest ? `${repositoryUri}@${digest}` : repositoryUri,
      ...(details.runningDigest
        ? { runningDigest: details.runningDigest }
        : {}),
      ...(details.localUrl ? { localUrl: details.localUrl } : {}),
      errorCode: error.code,
      errorMessage: error.message,
      startedAt: startedAt.toISOString(),
      finishedAt: this.now().toISOString(),
    };
  }
}
