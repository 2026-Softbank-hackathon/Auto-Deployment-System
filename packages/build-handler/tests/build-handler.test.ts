import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BuildHandler,
  CommandExecutionError,
  type CommandRequest,
  type CommandResult,
  type CommandRunner,
} from "../src/index.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

class FakeRunner implements CommandRunner {
  readonly calls: CommandRequest[] = [];

  constructor(
    private readonly execute: (
      request: CommandRequest,
    ) => Promise<CommandResult> = async () => ({ stdout: "", stderr: "" }),
  ) {}

  async run(request: CommandRequest): Promise<CommandResult> {
    this.calls.push(request);
    return this.execute(request);
  }
}

describe("BuildHandler", () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "camellia-test-"));
  });

  afterEach(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  it("builds and pushes a Dockerfile image and returns its immutable digest", async () => {
    await fs.writeFile(path.join(workspacePath, "Dockerfile"), "FROM scratch\n");
    const runner = new FakeRunner(async (request) => {
      const metadataIndex = request.args.indexOf("--metadata-file");
      expect(metadataIndex).toBeGreaterThan(-1);
      const metadataPath = request.args[metadataIndex + 1]!;
      await fs.writeFile(
        metadataPath,
        JSON.stringify({ "containerimage.digest": DIGEST }),
      );
      return { stdout: "", stderr: "" };
    });

    const result = await new BuildHandler({ runner }).build({
      workspacePath,
      plan: { context: ".", dockerfile: "Dockerfile" },
      image: { repository: "registry.example.com/camellia/demo", tag: "v1" },
    });

    expect(result).toEqual({
      strategy: "dockerfile",
      platform: "linux/amd64",
      image: {
        repository: "registry.example.com/camellia/demo",
        tag: "v1",
        digest: DIGEST,
        taggedRef: "registry.example.com/camellia/demo:v1",
        immutableRef: `registry.example.com/camellia/demo@${DIGEST}`,
      },
    });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.command).toBe("docker");
    expect(runner.calls[0]?.args).toEqual(
      expect.arrayContaining([
        "buildx",
        "build",
        "--platform",
        "linux/amd64",
        "--push",
      ]),
    );
  });

  it("uses Railpack and parses the Docker push digest", async () => {
    const canonicalWorkspacePath = await fs.realpath(workspacePath);
    const runner = new FakeRunner(async (request) => {
      if (request.command === "docker") {
        return {
          stdout: `latest: digest: ${DIGEST} size: 1234\n`,
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });

    const result = await new BuildHandler({ runner }).build({
      workspacePath,
      plan: { context: ".", buildpack: "railpack" },
      image: { repository: "registry.example.com/camellia/demo", tag: "v2" },
    });

    expect(result.strategy).toBe("railpack");
    expect(result.image.digest).toBe(DIGEST);
    expect(runner.calls.map((call) => call.command)).toEqual([
      "railpack",
      "docker",
    ]);
    expect(runner.calls[0]?.args).toEqual([
      "build",
      "--name",
      "registry.example.com/camellia/demo:v2",
      "--platform",
      "linux/amd64",
      canonicalWorkspacePath,
    ]);
  });

  it("passes an isolated Docker command environment to every build command", async () => {
    const runner = new FakeRunner(async (request) => {
      if (request.command === "docker") {
        return { stdout: `digest: ${DIGEST}`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const commandEnvironment = {
      PATH: process.env["PATH"],
      DOCKER_CONFIG: "/tmp/camellia-docker-config",
    };

    await new BuildHandler({ runner }).build({
      workspacePath,
      plan: { context: ".", buildpack: "railpack" },
      image: { repository: "registry.example.com/camellia/demo", tag: "v3" },
      commandEnvironment,
    });

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls.every((call) => call.env === commandEnvironment)).toBe(
      true,
    );
  });

  it("rejects a context path outside the workspace", async () => {
    const runner = new FakeRunner();
    await expect(
      new BuildHandler({ runner }).build({
        workspacePath,
        plan: { context: "../outside", dockerfile: "Dockerfile" },
        image: { repository: "example/demo", tag: "v1" },
      }),
    ).rejects.toMatchObject({
      code: "BUILD_PATH_OUTSIDE_WORKSPACE",
    });
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects a Dockerfile symlink that resolves outside the workspace", async () => {
    const externalDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "camellia-external-"),
    );
    const externalDockerfile = path.join(externalDirectory, "Dockerfile");
    await fs.writeFile(externalDockerfile, "FROM scratch\n");
    await fs.symlink(externalDockerfile, path.join(workspacePath, "Dockerfile"));
    const runner = new FakeRunner();

    try {
      await expect(
        new BuildHandler({ runner }).build({
          workspacePath,
          plan: { context: ".", dockerfile: "Dockerfile" },
          image: { repository: "example/demo", tag: "v1" },
        }),
      ).rejects.toMatchObject({
        code: "BUILD_PATH_OUTSIDE_WORKSPACE",
      });
      expect(runner.calls).toHaveLength(0);
    } finally {
      await fs.rm(externalDirectory, { recursive: true, force: true });
    }
  });

  it("rejects a missing Dockerfile before running Docker", async () => {
    const runner = new FakeRunner();
    await expect(
      new BuildHandler({ runner }).build({
        workspacePath,
        plan: { context: ".", dockerfile: "Dockerfile" },
        image: { repository: "example/demo", tag: "v1" },
      }),
    ).rejects.toMatchObject({
      code: "DOCKERFILE_NOT_FOUND",
    });
    expect(runner.calls).toHaveLength(0);
  });

  it("normalizes an unavailable build tool without exposing command output", async () => {
    await fs.writeFile(path.join(workspacePath, "Dockerfile"), "FROM scratch\n");
    const runner = new FakeRunner(async () => {
      throw new CommandExecutionError("docker", null, true);
    });

    await expect(
      new BuildHandler({ runner }).build({
        workspacePath,
        plan: { context: ".", dockerfile: "Dockerfile" },
        image: { repository: "example/demo", tag: "v1" },
      }),
    ).rejects.toMatchObject({
      code: "BUILD_TOOL_UNAVAILABLE",
      details: { command: "docker" },
    });
  });

  it("rejects missing or invalid image digests", async () => {
    const runner = new FakeRunner(async () => ({ stdout: "pushed", stderr: "" }));
    await expect(
      new BuildHandler({ runner }).build({
        workspacePath,
        plan: { context: ".", buildpack: "railpack" },
        image: { repository: "example/demo", tag: "v1" },
      }),
    ).rejects.toMatchObject({
      code: "IMAGE_DIGEST_MISSING",
    });
  });
});
