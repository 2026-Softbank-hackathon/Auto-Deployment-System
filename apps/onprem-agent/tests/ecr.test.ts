import { describe, expect, it } from "vitest";
import type {
  AgentControlPlaneClient,
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "../src/contracts.js";
import { EcrImageManager } from "../src/ecr.js";
import { AgentError } from "../src/errors.js";
import { FakeControlPlaneClient } from "../src/fakes.js";
import { createJob } from "./fixtures.js";

class RecordingRunner implements CommandRunner {
  readonly requests: CommandRequest[] = [];

  constructor(
    private readonly responder: (
      request: CommandRequest,
      index: number,
    ) => Promise<CommandResult>,
  ) {}

  async run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    return this.responder(request, this.requests.length - 1);
  }
}

function createClient(): AgentControlPlaneClient {
  const client = new FakeControlPlaneClient();
  client.setEcrCredential("job-001", {
    registry: "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com",
    username: "AWS",
    password: "top-secret-password",
    expiresAt: "2026-10-02T00:00:00.000Z",
  });
  return client;
}

describe("ECR image 준비", () => {
  it("비밀번호를 stdin으로만 전달하고 login → pull → inspect → logout 순서를 지킨다", async () => {
    const job = createJob();
    const imageUri = `${job.image.repositoryUri}@${job.image.digest}`;
    const runner = new RecordingRunner(async (request) => ({
      stdout: request.args[0] === "inspect" ? JSON.stringify([imageUri]) : "",
      stderr: "",
    }));
    const manager = new EcrImageManager(createClient(), runner, {
      now: () => new Date("2026-10-01T00:00:00.000Z"),
    });

    await expect(manager.prepare(job)).resolves.toEqual({
      imageUri,
      runningDigest: job.image.digest,
    });

    expect(runner.requests.map((request) => request.args[0])).toEqual([
      "login",
      "pull",
      "inspect",
      "logout",
    ]);
    expect(runner.requests[0]).toMatchObject({
      command: "docker",
      args: [
        "login",
        "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com",
        "--username",
        "AWS",
        "--password-stdin",
      ],
      stdin: "top-secret-password",
    });
    expect(JSON.stringify(runner.requests[0]?.args)).not.toContain(
      "top-secret-password",
    );
    expect(runner.requests[1]?.args).toEqual([
      "pull",
      "--platform",
      job.image.platform,
      imageUri,
    ]);
  });

  it("pull 실패 시에도 logout한다", async () => {
    const runner = new RecordingRunner(async (request) => {
      if (request.args[0] === "pull") throw new Error("pull failed");
      return { stdout: "", stderr: "" };
    });
    const manager = new EcrImageManager(createClient(), runner, {
      now: () => new Date("2026-10-01T00:00:00.000Z"),
    });

    await expect(manager.prepare(createJob())).rejects.toMatchObject({
      code: "image_pull_failed",
    });
    expect(runner.requests.at(-1)?.args[0]).toBe("logout");
  });

  it("취소 시에도 logout하고 cancelled로 정규화한다", async () => {
    const runner = new RecordingRunner(async (request) => {
      if (request.args[0] === "pull") {
        throw new AgentError("cancelled", "cancelled");
      }
      return { stdout: "", stderr: "" };
    });
    const manager = new EcrImageManager(createClient(), runner, {
      now: () => new Date("2026-10-01T00:00:00.000Z"),
    });

    await expect(manager.prepare(createJob())).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(runner.requests.at(-1)?.args[0]).toBe("logout");
  });

  it("inspect 결과의 digest가 다르면 거부한다", async () => {
    const runner = new RecordingRunner(async (request) => ({
      stdout:
        request.args[0] === "inspect"
          ? JSON.stringify([
              `${createJob().image.repositoryUri}@sha256:${"b".repeat(64)}`,
            ])
          : "",
      stderr: "",
    }));
    const manager = new EcrImageManager(createClient(), runner, {
      now: () => new Date("2026-10-01T00:00:00.000Z"),
    });

    await expect(manager.prepare(createJob())).rejects.toMatchObject({
      code: "digest_mismatch",
    });
    expect(runner.requests.at(-1)?.args[0]).toBe("logout");
  });
});
