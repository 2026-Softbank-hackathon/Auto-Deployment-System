import type {
  ImageManager,
  OnpremAgentJob,
  OnpremExecutionResult,
  OnpremJobExecutor,
  RunningDeployment,
  RuntimeManager,
  TunnelProvider,
} from "./contracts.js";
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
  private readonly now: () => Date;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly activeDeployments = new Map<string, ActiveDeployment>();
  private readonly deploymentRuns = new Map<string, DeploymentRun>();

  constructor(options: ExecutorOptions) {
    this.imageManager = options.imageManager;
    this.runtimeManager = options.runtimeManager;
    this.tunnelProvider = options.tunnelProvider;
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

      if (previous && previous.resources !== running) {
        await previous.resources.cleanup();
      }
      this.activeDeployments.set(key, {
        deploymentId: job.deploymentId,
        digest: job.image.digest,
        result,
        resources: running,
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

  async shutdown(): Promise<void> {
    const deployments = [...this.activeDeployments.values()];
    this.activeDeployments.clear();
    this.jobs.clear();
    this.deploymentRuns.clear();
    await Promise.allSettled(
      deployments.flatMap((deployment) => [
        this.tunnelProvider?.stop(deployment.deploymentId) ?? Promise.resolve(),
        deployment.resources.cleanup(),
      ]),
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
