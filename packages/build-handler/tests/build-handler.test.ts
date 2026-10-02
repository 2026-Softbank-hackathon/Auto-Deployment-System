import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BuildHandler,
  CommandExecutionError,
  LAMBDA_WEB_ADAPTER_IMAGE,
  LAMBDA_WEB_ADAPTER_VERSION,
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
      lambdaWebAdapter: LAMBDA_WEB_ADAPTER_VERSION,
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
        "--provenance=false",
        "--push",
      ]),
    );
  });

  it("adds the Lambda Web Adapter as the last layer of the user Dockerfile before the single push", async () => {
    const original = "FROM alpine:3.24 AS runtime\nUSER node\nCMD [\"node\", \"server.js\"]";
    await fs.mkdir(path.join(workspacePath, "docker"));
    await fs.writeFile(path.join(workspacePath, "docker", "app.Dockerfile"), original);
    await fs.writeFile(path.join(workspacePath, "docker", "app.Dockerfile.dockerignore"), "node_modules\n");
    let builtDockerfile = "";
    let builtIgnore = "";
    let fileArgument = "";
    const runner = new FakeRunner(async (request) => {
      fileArgument = request.args[request.args.indexOf("--file") + 1]!;
      builtDockerfile = await fs.readFile(fileArgument, "utf8");
      builtIgnore = await fs.readFile(`${fileArgument}.dockerignore`, "utf8");
      const metadataPath = request.args[request.args.indexOf("--metadata-file") + 1]!;
      await fs.writeFile(metadataPath, JSON.stringify({ "containerimage.digest": DIGEST }));
      return { stdout: "", stderr: "" };
    });

    await new BuildHandler({ runner }).build({
      workspacePath,
      plan: { context: ".", dockerfile: "docker/app.Dockerfile" },
      image: { repository: "registry.example.com/camellia/demo", tag: "v1" },
    });

    expect(runner.calls).toHaveLength(1);
    expect(path.dirname(fileArgument)).not.toBe(await fs.realpath(path.join(workspacePath, "docker")));
    expect(builtDockerfile.startsWith(`${original}\n`)).toBe(true);
    const lines = builtDockerfile.trimEnd().split("\n");
    expect(lines.at(-1)).toBe(
      `COPY --from=${LAMBDA_WEB_ADAPTER_IMAGE} /lambda-adapter /opt/extensions/lambda-adapter`,
    );
    expect(builtIgnore).toBe("node_modules\n");
    // context 는 그대로 사용자 소스 폴더
    expect(runner.calls[0]?.args.at(-1)).toBe(await fs.realpath(workspacePath));
    // 임시 Dockerfile 은 빌드 후 지운다
    await expect(fs.access(fileArgument)).rejects.toThrow();
    // 사용자 Dockerfile 은 바꾸지 않는다
    expect(await fs.readFile(path.join(workspacePath, "docker", "app.Dockerfile"), "utf8")).toBe(original);
  });

  it("builds Railpack locally, then adds the Lambda Web Adapter layer and pushes once", async () => {
    const canonicalWorkspacePath = await fs.realpath(workspacePath);
    let wrapperDockerfile = "";
    const runner = new FakeRunner(async (request) => {
      if (request.command === "docker" && request.args[0] === "buildx") {
        const fileArgument = request.args[request.args.indexOf("--file") + 1]!;
        wrapperDockerfile = await fs.readFile(fileArgument, "utf8");
        const metadataPath = request.args[request.args.indexOf("--metadata-file") + 1]!;
        await fs.writeFile(metadataPath, JSON.stringify({ "containerimage.digest": DIGEST }));
      }
      return { stdout: "", stderr: "" };
    });

    const result = await new BuildHandler({ runner }).build({
      workspacePath,
      plan: { context: ".", buildpack: "railpack" },
      image: { repository: "registry.example.com/camellia/demo", tag: "v2" },
    });

    expect(result.strategy).toBe("railpack");
    expect(result.lambdaWebAdapter).toBe(LAMBDA_WEB_ADAPTER_VERSION);
    expect(result.image.digest).toBe(DIGEST);
    expect(runner.calls.map((call) => [call.command, call.args[0]])).toEqual([
      ["railpack", "build"],
      ["docker", "buildx"],
      ["docker", "image"],
    ]);
    const localImage = runner.calls[0]!.args[2]!;
    expect(localImage).toMatch(/^camellia-railpack:[0-9a-f]{16}$/);
    expect(runner.calls[0]?.args).toEqual([
      "build",
      "--name",
      localImage,
      "--platform",
      "linux/amd64",
      canonicalWorkspacePath,
    ]);
    expect(wrapperDockerfile).toBe(
      `FROM ${localImage}\nCOPY --from=${LAMBDA_WEB_ADAPTER_IMAGE} /lambda-adapter /opt/extensions/lambda-adapter\n`,
    );
    expect(runner.calls[1]?.args).toEqual(
      expect.arrayContaining([
        "--platform",
        "linux/amd64",
        "--provenance=false",
        "--tag",
        "registry.example.com/camellia/demo:v2",
        "--push",
      ]),
    );
    // 로컬 중간 이미지 태그는 지운다
    expect(runner.calls[2]?.args).toEqual(["image", "rm", localImage]);
  });

  it("passes an isolated Docker command environment to every build command", async () => {
    const runner = new FakeRunner(async (request) => {
      if (request.command === "docker" && request.args[0] === "buildx") {
        const metadataPath = request.args[request.args.indexOf("--metadata-file") + 1]!;
        await fs.writeFile(metadataPath, JSON.stringify({ "containerimage.digest": DIGEST }));
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

    expect(runner.calls).toHaveLength(3);
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
