import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeCommandRunner } from "../src/command-runner.js";
import { DockerComposeRuntime } from "../src/compose.js";
import { LocalHealthChecker } from "../src/health.js";
import type { OnpremAgentJob, RunningDeployment } from "../src/contracts.js";
import { createJob } from "./fixtures.js";

const enabled = process.env.RUN_DOCKER_INTEGRATION === "1";
const fixtureDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "http-app",
);
const imageName = `camellia-onprem-agent-test:${process.pid}`;

function integrationJob(
  deploymentId: number,
  environmentId: string,
  jobId: string,
): OnpremAgentJob {
  const base = createJob();
  return createJob({
    deploymentId,
    environmentId,
    jobId,
    plan: {
      ...base.plan,
      service: {
        ...base.plan.service,
        command: ["node", "/app/server.mjs"],
      },
    },
  });
}

describe.skipIf(!enabled)("Docker Compose 통합", () => {
  const runner = new NodeCommandRunner();
  const deployments: RunningDeployment[] = [];
  let stateRoot = "";

  beforeAll(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), "camellia-onprem-integration-"));
    await runner.run({
      command: "docker",
      args: [
        "build",
        "--platform",
        "linux/amd64",
        "-t",
        imageName,
        fixtureDirectory,
      ],
    });
  });

  afterAll(async () => {
    await Promise.allSettled(deployments.map((deployment) => deployment.cleanup()));
    await runner
      .run({ command: "docker", args: ["image", "rm", "-f", imageName] })
      .catch(() => undefined);
    if (stateRoot) await rm(stateRoot, { recursive: true, force: true });
  });

  it("서로 다른 Deployment의 포트·Compose 리소스를 격리하고 개별 정리한다", async () => {
    const runtime = new DockerComposeRuntime(runner, {
      stateRoot,
    });
    const first = await runtime.start(
      integrationJob(101, "integration-a", "integration-job-a"),
      imageName,
    );
    deployments.push(first);
    const second = await runtime.start(
      integrationJob(102, "integration-b", "integration-job-b"),
      imageName,
    );
    deployments.push(second);

    expect(first.projectName).not.toBe(second.projectName);
    expect(first.localUrl).not.toBe(second.localUrl);
    await expect(fetch(`${first.localUrl}/health`)).resolves.toMatchObject({
      status: 200,
    });
    await expect(fetch(`${second.localUrl}/health`)).resolves.toMatchObject({
      status: 200,
    });

    await first.cleanup();
    expect(await first.isRunning()).toBe(false);
    await expect(fetch(`${second.localUrl}/health`)).resolves.toMatchObject({
      status: 200,
    });
  });

  it("헬스체크 실패 시 해당 job의 Compose 리소스만 정리한다", async () => {
    const runtime = new DockerComposeRuntime(runner, {
      stateRoot,
      healthChecker: new LocalHealthChecker({ attempts: 1, intervalMs: 1 }),
    });
    const job = integrationJob(103, "integration-failure", "integration-job-failure");
    job.plan.health.path = "/missing";

    await expect(runtime.start(job, imageName)).rejects.toMatchObject({
      code: "health_check_failed",
    });
    const remaining = await runner.run({
      command: "docker",
      args: [
        "ps",
        "-q",
        "--filter",
        `label=io.camellia.job-id=${job.jobId}`,
      ],
    });
    expect(remaining.stdout.trim()).toBe("");
  });
});
