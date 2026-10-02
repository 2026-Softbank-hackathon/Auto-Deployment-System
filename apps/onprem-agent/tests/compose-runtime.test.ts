import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "../src/contracts.js";
import {
  createComposeProjectName,
  DockerComposeRuntime,
} from "../src/compose.js";
import type { HealthChecker } from "../src/health.js";
import { createJob } from "./fixtures.js";

class ComposeRunner implements CommandRunner {
  readonly requests: CommandRequest[] = [];

  async run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    if (request.args.includes("port")) {
      return { stdout: "127.0.0.1:49152\n", stderr: "" };
    }
    if (request.args.includes("ps")) {
      return { stdout: "app\n", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  }
}

const healthy: HealthChecker = {
  async waitUntilHealthy() {},
  async isHealthy() {
    return true;
  },
};

describe("DockerComposeRuntime", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("실패 재시도 전 같은 job project의 불완전한 리소스를 먼저 정리한다", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "camellia-agent-test-"));
    directories.push(stateRoot);
    const job = createJob();
    const projectName = createComposeProjectName(job);
    const projectDirectory = join(stateRoot, projectName);
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(join(projectDirectory, "compose.yaml"), "services: {}\n");
    const runner = new ComposeRunner();
    const runtime = new DockerComposeRuntime(runner, {
      stateRoot,
      healthChecker: healthy,
    });

    const deployment = await runtime.start(job, "local/test:latest");

    const actions = runner.requests.map((request) =>
      request.args.find((argument) =>
        ["down", "up", "ps", "port"].includes(argument),
      ),
    );
    expect(actions.slice(0, 4)).toEqual(["down", "up", "ps", "port"]);
    expect(runner.requests.find((request) => request.args.includes("up"))?.env).toMatchObject({
      APP_MESSAGE: "do-not-log-this",
    });
    expect(
      JSON.stringify(
        runner.requests.find((request) => request.args.includes("up"))?.args,
      ),
    ).not.toContain("do-not-log-this");

    await deployment.cleanup();
    expect(
      runner.requests.filter((request) => request.args.includes("down")),
    ).toHaveLength(2);
  });
});
