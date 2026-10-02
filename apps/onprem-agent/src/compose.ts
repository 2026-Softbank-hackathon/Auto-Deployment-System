import { createHash } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  CommandRunner,
  OnpremAgentJob,
  RunningDeployment,
  RuntimeManager,
} from "./contracts.js";
import { AgentError, throwIfAborted } from "./errors.js";
import {
  type HealthChecker,
  LocalHealthChecker,
} from "./health.js";
import { parseOnpremAgentJob } from "./validation.js";

function quote(value: string): string {
  return JSON.stringify(value);
}

function hash(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function createComposeProjectName(job: OnpremAgentJob): string {
  parseOnpremAgentJob(job);
  const environment = hash(job.environmentId, 10);
  const digest = job.image.digest.slice("sha256:".length, "sha256:".length + 12);
  return `camellia-d${job.deploymentId}-${environment}-${digest}`;
}

export function renderComposeDocument(
  job: OnpremAgentJob,
  imageUri: string,
): string {
  parseOnpremAgentJob(job);
  const environmentEntries = Object.keys(job.environment ?? {}).sort();
  const allowedNames = new Set([
    ...job.plan.service.environmentNames,
    ...job.plan.service.secretNames,
  ]);
  for (const key of environmentEntries) {
    if (!allowedNames.has(key)) {
      throw new AgentError(
        "invalid_job",
        "Plan에 선언되지 않은 환경변수가 포함되어 있습니다.",
      );
    }
  }

  const healthUrl = `http://127.0.0.1:${job.plan.service.containerPort}${job.plan.health.path}`;
  const healthCommand =
    `wget -q -O - ${healthUrl} >/dev/null 2>&1 || ` +
    `curl -fsS ${healthUrl} >/dev/null 2>&1 || exit 1`;
  const lines = [
    'name: "camellia-onprem"',
    "services:",
    "  app:",
    `    image: ${quote(imageUri)}`,
    '    platform: "linux/amd64"',
    '    restart: "unless-stopped"',
  ];

  if (job.plan.service.command && job.plan.service.command.length > 0) {
    lines.push(
      `    command: [${job.plan.service.command.map(quote).join(", ")}]`,
    );
  }
  if (environmentEntries.length > 0) {
    lines.push("    environment:");
    for (const key of environmentEntries) lines.push(`      - ${quote(key)}`);
  }

  lines.push(
    "    ports:",
    `      - ${quote(`127.0.0.1::${job.plan.service.containerPort}`)}`,
    `    cpus: ${job.plan.runtime.cpus}`,
    `    mem_limit: ${quote(`${job.plan.runtime.memoryMiB}M`)}`,
    "    healthcheck:",
    `      test: [${quote("CMD-SHELL")}, ${quote(healthCommand)}]`,
    '      interval: "5s"',
    `      timeout: ${quote(`${job.plan.health.timeoutSeconds}s`)}`,
    "      retries: 3",
    "    labels:",
    `      ${quote("io.camellia.managed")}: ${quote("true")}`,
    `      ${quote("io.camellia.job-id")}: ${quote(job.jobId)}`,
    `      ${quote("io.camellia.deployment-id")}: ${quote(String(job.deploymentId))}`,
    `      ${quote("io.camellia.environment-id")}: ${quote(job.environmentId)}`,
    `      ${quote("io.camellia.image-digest")}: ${quote(job.image.digest)}`,
    "    deploy:",
    `      replicas: ${job.plan.runtime.replicas}`,
    "",
  );

  return lines.join("\n");
}

type DockerComposeRuntimeOptions = {
  stateRoot: string;
  healthChecker?: HealthChecker;
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parsePublishedPort(output: string): number {
  const line = output.trim().split("\n")[0] ?? "";
  const match = /:(\d+)$/.exec(line);
  const port = match ? Number(match[1]) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new AgentError(
      "compose_failed",
      "Compose 공개 포트를 확인할 수 없습니다.",
    );
  }
  return port;
}

export class DockerComposeRuntime implements RuntimeManager {
  private readonly stateRoot: string;
  private readonly healthChecker: HealthChecker;

  constructor(
    private readonly runner: CommandRunner,
    options: DockerComposeRuntimeOptions,
  ) {
    this.stateRoot = resolve(options.stateRoot);
    this.healthChecker = options.healthChecker ?? new LocalHealthChecker();
  }

  async start(
    job: OnpremAgentJob,
    imageUri: string,
    signal?: AbortSignal,
  ): Promise<RunningDeployment> {
    parseOnpremAgentJob(job);
    throwIfAborted(signal);
    const projectName = createComposeProjectName(job);
    const projectDirectory = join(this.stateRoot, projectName);
    const composePath = join(projectDirectory, "compose.yaml");
    const existed = await pathExists(composePath);
    let composeStarted = false;

    await mkdir(projectDirectory, { recursive: true, mode: 0o700 });
    if (existed) {
      await this.down(projectName, composePath).catch(() => undefined);
    }
    await writeFile(composePath, renderComposeDocument(job, imageUri), {
      encoding: "utf8",
      mode: 0o600,
    });

    const cleanup = async (): Promise<void> => {
      try {
        if (composeStarted || (await pathExists(composePath))) {
          await this.down(projectName, composePath);
        }
      } finally {
        await rm(projectDirectory, { recursive: true, force: true });
      }
    };

    try {
      await this.runCompose(
        projectName,
        composePath,
        ["up", "-d", "--remove-orphans"],
        job.environment,
        signal,
      );
      composeStarted = true;
      throwIfAborted(signal);

      const running = await this.runCompose(
        projectName,
        composePath,
        ["ps", "--status", "running", "--services"],
        undefined,
        signal,
      );
      if (!running.stdout.split(/\s+/).includes("app")) {
        throw new AgentError(
          "compose_failed",
          "Compose 컨테이너가 실행 상태가 아닙니다.",
        );
      }
      throwIfAborted(signal);

      const port = await this.runCompose(
        projectName,
        composePath,
        ["port", "app", String(job.plan.service.containerPort)],
        undefined,
        signal,
      );
      const localUrl = `http://127.0.0.1:${parsePublishedPort(port.stdout)}`;
      await this.healthChecker.waitUntilHealthy(localUrl, job, signal);
      throwIfAborted(signal);

      let cleaned = false;
      return {
        projectName,
        localUrl,
        isRunning: async () => {
          try {
            const current = await this.runCompose(
              projectName,
              composePath,
              ["ps", "--status", "running", "--services"],
            );
            return current.stdout.split(/\s+/).includes("app");
          } catch {
            return false;
          }
        },
        isHealthy: () => this.healthChecker.isHealthy(localUrl, job.plan.health),
        cleanup: async () => {
          if (cleaned) return;
          cleaned = true;
          await cleanup();
        },
      };
    } catch (error) {
      await cleanup().catch(() => undefined);
      if (error instanceof AgentError) {
        if (
          error.code === "cancelled" ||
          error.code === "health_check_failed" ||
          error.code === "compose_failed"
        ) {
          throw error;
        }
      }
      throw new AgentError("compose_failed", "Docker Compose 실행에 실패했습니다.");
    }
  }

  async restore(input: {
    projectName: string;
    localUrl: string;
    health: OnpremAgentJob["plan"]["health"];
  }): Promise<RunningDeployment | null> {
    if (!/^camellia-d\d+-[a-f0-9]{10}-[a-f0-9]{12}$/.test(input.projectName)) {
      return null;
    }
    const projectDirectory = join(this.stateRoot, input.projectName);
    const composePath = join(projectDirectory, "compose.yaml");
    if (!(await pathExists(composePath))) return null;
    const deployment: RunningDeployment = {
      projectName: input.projectName,
      localUrl: input.localUrl,
      isRunning: async () => {
        try {
          const current = await this.runCompose(
            input.projectName,
            composePath,
            ["ps", "--status", "running", "--services"],
          );
          return current.stdout.split(/\s+/).includes("app");
        } catch {
          return false;
        }
      },
      isHealthy: () => this.healthChecker.isHealthy(input.localUrl, input.health),
      cleanup: async () => {
        try {
          await this.down(input.projectName, composePath);
        } finally {
          await rm(projectDirectory, { recursive: true, force: true });
        }
      },
    };
    return (await deployment.isRunning()) ? deployment : null;
  }

  private async runCompose(
    projectName: string,
    composePath: string,
    args: string[],
    environment?: Record<string, string>,
    signal?: AbortSignal,
  ) {
    return this.runner.run({
      command: "docker",
      args: ["compose", "-p", projectName, "-f", composePath, ...args],
      env: environment ? { ...process.env, ...environment } : process.env,
      signal,
    });
  }

  private async down(projectName: string, composePath: string): Promise<void> {
    await this.runCompose(projectName, composePath, ["down", "--remove-orphans"]);
  }
}
