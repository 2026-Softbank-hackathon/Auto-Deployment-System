import type { OnpremDockerDeploymentPlan } from "@camellia/adapters";

export type OnpremErrorCode =
  | "invalid_job"
  | "ecr_auth_failed"
  | "image_pull_failed"
  | "digest_mismatch"
  | "compose_failed"
  | "health_check_failed"
  | "tunnel_not_configured"
  | "tunnel_failed"
  | "cancelled"
  | "internal_error";

export type OnpremAgentJob = {
  jobId: string;
  attempt: number;
  deploymentId: number;
  environmentId: string;
  plan: OnpremDockerDeploymentPlan;
  image: {
    repositoryUri: string;
    digest: string;
    platform: "linux/amd64";
    registryType: "ecr";
    region: string;
  };
  environment?: Record<string, string>;
};

export type EcrCredential = {
  registry: string;
  username: "AWS";
  password: string;
  expiresAt: string;
};

export type OnpremExecutionResult =
  | {
      deploymentId: number;
      environmentId: string;
      jobId: string;
      status: "ready_for_verify";
      imageUri: string;
      runningDigest: string;
      localUrl: string;
      endpoint: string;
      startedAt: string;
      finishedAt: string;
    }
  | {
      deploymentId: number;
      environmentId: string;
      jobId: string;
      status: "failed";
      imageUri: string;
      runningDigest?: string;
      localUrl?: string;
      errorCode: OnpremErrorCode;
      errorMessage: string;
      startedAt: string;
      finishedAt: string;
    };

export interface AgentControlPlaneClient {
  claimJob(): Promise<OnpremAgentJob | null>;
  getEcrCredential(jobId: string): Promise<EcrCredential>;
  prepareTunnel(
    input: TunnelStartInput,
    options?: { signal?: AbortSignal },
  ): Promise<TunnelSession>;
  isJobCancelled(jobId: string): Promise<boolean>;
  reportResult(jobId: string, result: OnpremExecutionResult): Promise<void>;
  sendHeartbeat(): Promise<void>;
}

export interface OnpremJobExecutor {
  execute(
    job: OnpremAgentJob,
    options?: { signal?: AbortSignal },
  ): Promise<OnpremExecutionResult>;
  shutdown?(): Promise<void>;
}

export type TunnelStartInput = {
  jobId: string;
  deploymentId: number;
  environmentId: string;
  localPort: number;
};

export type TunnelResult = {
  endpoint: string;
  tunnelId?: string;
};

export interface TunnelProvider {
  start(
    input: TunnelStartInput,
    options?: { signal?: AbortSignal },
  ): Promise<TunnelResult>;
  stop(deploymentId: number): Promise<void>;
  isRunning?(deploymentId: number): Promise<boolean>;
}

export type TunnelSession = {
  tunnelId: string;
  token: string;
  hostname: string;
};

export interface TunnelSessionProvider {
  prepare(
    input: TunnelStartInput,
    options?: { signal?: AbortSignal },
  ): Promise<TunnelSession>;
}

export type CommandRequest = {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  signal?: AbortSignal;
};

export type CommandResult = {
  stdout: string;
  stderr: string;
};

export interface CommandRunner {
  run(request: CommandRequest): Promise<CommandResult>;
}

export interface BackgroundProcess {
  isRunning(): boolean;
  waitForExit(): Promise<void>;
  stop(): Promise<void>;
}

export interface BackgroundProcessRunner {
  start(request: CommandRequest): Promise<BackgroundProcess>;
}

export interface TunnelReadinessChecker {
  waitUntilReady(
    url: string,
    process: BackgroundProcess,
    signal?: AbortSignal,
  ): Promise<void>;
}

export type PreparedImage = {
  imageUri: string;
  runningDigest: string;
};

export interface ImageManager {
  prepare(job: OnpremAgentJob, signal?: AbortSignal): Promise<PreparedImage>;
}

export type RunningDeployment = {
  projectName: string;
  localUrl: string;
  isRunning(): Promise<boolean>;
  cleanup(): Promise<void>;
};

export interface RuntimeManager {
  start(
    job: OnpremAgentJob,
    imageUri: string,
    signal?: AbortSignal,
  ): Promise<RunningDeployment>;
}
