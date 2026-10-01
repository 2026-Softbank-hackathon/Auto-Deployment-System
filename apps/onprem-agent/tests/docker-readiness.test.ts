import { describe, expect, it } from "vitest";
import type { CommandRequest, CommandResult, CommandRunner } from "../src/contracts.js";
import { DockerPrerequisiteChecker } from "../src/docker-readiness.js";

class RecordingRunner implements CommandRunner {
  readonly requests: CommandRequest[] = [];

  constructor(private readonly failureAt?: number) {}

  async run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    if (this.failureAt === this.requests.length) throw new Error("failed");
    return { stdout: "ok", stderr: "" };
  }
}

describe("DockerPrerequisiteChecker", () => {
  it("Docker daemon과 Compose v2를 순서대로 확인한다", async () => {
    const runner = new RecordingRunner();
    const checker = new DockerPrerequisiteChecker(runner);

    await checker.assertReady();

    expect(runner.requests).toEqual([
      { command: "docker", args: ["info", "--format", "{{.ServerVersion}}"] },
      { command: "docker", args: ["compose", "version", "--short"] },
      { command: "cloudflared", args: ["--version"] },
    ]);
  });

  it("Docker daemon이 준비되지 않으면 명확한 오류를 반환한다", async () => {
    const checker = new DockerPrerequisiteChecker(new RecordingRunner(1));

    await expect(checker.assertReady()).rejects.toMatchObject({
      code: "internal_error",
      message: "Docker daemon을 사용할 수 없습니다.",
    });
  });

  it("cloudflared가 없으면 명확한 오류를 반환한다", async () => {
    const checker = new DockerPrerequisiteChecker(new RecordingRunner(3));

    await expect(checker.assertReady()).rejects.toMatchObject({
      code: "tunnel_not_configured",
      message: "cloudflared를 사용할 수 없습니다.",
    });
  });
});
