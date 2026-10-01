import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BuildError, CommandExecutionError } from "./errors.js";
import { NodeCommandRunner } from "./command-runner.js";
import {
  DEFAULT_BUILD_PLATFORM,
  type BuildRequest,
  type BuildResult,
  type CommandRunner,
} from "./types.js";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

export type BuildHandlerOptions = {
  runner?: CommandRunner;
  temporaryRoot?: string;
};

export class BuildHandler {
  private readonly runner: CommandRunner;
  private readonly temporaryRoot: string;

  constructor(options: BuildHandlerOptions = {}) {
    this.runner = options.runner ?? new NodeCommandRunner();
    this.temporaryRoot = options.temporaryRoot ?? os.tmpdir();
  }

  async build(request: BuildRequest): Promise<BuildResult> {
    const workspaceCandidate = path.resolve(request.workspacePath);
    await requireDirectory(workspaceCandidate);
    const workspacePath = await fs.realpath(workspaceCandidate);
    const contextCandidate = resolveInsideWorkspace(
      workspacePath,
      request.plan.context || ".",
    );
    await requireDirectory(contextCandidate);
    const contextPath = await canonicalizeInsideWorkspace(
      workspacePath,
      contextCandidate,
    );

    const repository = validateRepository(request.image.repository);
    const tag = validateTag(request.image.tag);
    const taggedRef = `${repository}:${tag}`;
    const platform = request.platform ?? DEFAULT_BUILD_PLATFORM;

    let digest: string;
    let strategy: BuildResult["strategy"];

    if (request.plan.dockerfile) {
      const dockerfileCandidate = resolveInsideWorkspace(
        workspacePath,
        request.plan.dockerfile,
      );
      await requireFile(dockerfileCandidate, "DOCKERFILE_NOT_FOUND");
      const dockerfilePath = await canonicalizeInsideWorkspace(
        workspacePath,
        dockerfileCandidate,
      );
      digest = await this.buildDockerfile({
        contextPath,
        dockerfilePath,
        taggedRef,
        platform,
      });
      strategy = "dockerfile";
    } else if (request.plan.buildpack === "railpack") {
      digest = await this.buildRailpack({ contextPath, taggedRef, platform });
      strategy = "railpack";
    } else {
      throw new BuildError(
        "INVALID_BUILD_REQUEST",
        "Dockerfile 또는 railpack build 설정이 필요합니다.",
      );
    }

    const imageDigest = validateDigest(digest);
    return {
      strategy,
      platform,
      image: {
        repository,
        tag,
        digest: imageDigest,
        taggedRef,
        immutableRef: `${repository}@${imageDigest}`,
      },
    };
  }

  private async buildDockerfile(input: {
    contextPath: string;
    dockerfilePath: string;
    taggedRef: string;
    platform: string;
  }): Promise<string> {
    const temporaryDirectory = await fs.mkdtemp(
      path.join(this.temporaryRoot, "camellia-build-"),
    );
    const metadataPath = path.join(temporaryDirectory, "metadata.json");

    try {
      await this.runBuildCommand({
        command: "docker",
        args: [
          "buildx",
          "build",
          "--platform",
          input.platform,
          "--file",
          input.dockerfilePath,
          "--tag",
          input.taggedRef,
          "--push",
          "--metadata-file",
          metadataPath,
          input.contextPath,
        ],
        cwd: input.contextPath,
      });

      let metadata: Record<string, unknown>;
      try {
        metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as Record<
          string,
          unknown
        >;
      } catch {
        throw new BuildError(
          "IMAGE_DIGEST_MISSING",
          "Buildx metadata를 읽을 수 없습니다.",
        );
      }

      const digest = metadata["containerimage.digest"];
      if (typeof digest !== "string") {
        throw new BuildError(
          "IMAGE_DIGEST_MISSING",
          "Buildx 결과에 image digest가 없습니다.",
        );
      }
      return digest;
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  private async buildRailpack(input: {
    contextPath: string;
    taggedRef: string;
    platform: string;
  }): Promise<string> {
    await this.runBuildCommand({
      command: "railpack",
      args: [
        "build",
        "--name",
        input.taggedRef,
        "--platform",
        input.platform,
        input.contextPath,
      ],
      cwd: input.contextPath,
    });

    const pushed = await this.runBuildCommand({
      command: "docker",
      args: ["push", input.taggedRef],
      cwd: input.contextPath,
    });
    const digest = extractPushDigest(`${pushed.stdout}\n${pushed.stderr}`);
    if (!digest) {
      throw new BuildError(
        "IMAGE_DIGEST_MISSING",
        "Registry push 결과에서 image digest를 찾을 수 없습니다.",
      );
    }
    return digest;
  }

  private async runBuildCommand(
    request: Parameters<CommandRunner["run"]>[0],
  ) {
    try {
      return await this.runner.run(request);
    } catch (error) {
      if (error instanceof CommandExecutionError) {
        throw new BuildError(
          error.unavailable
            ? "BUILD_TOOL_UNAVAILABLE"
            : "BUILD_COMMAND_FAILED",
          error.message,
          {
            command: error.command,
            ...(error.exitCode === null ? {} : { exitCode: error.exitCode }),
          },
        );
      }
      throw error;
    }
  }
}

function resolveInsideWorkspace(workspacePath: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new BuildError(
      "BUILD_PATH_OUTSIDE_WORKSPACE",
      "빌드 경로는 workspace 내부의 상대 경로여야 합니다.",
    );
  }

  const resolved = path.resolve(workspacePath, relativePath);
  const relative = path.relative(workspacePath, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new BuildError(
      "BUILD_PATH_OUTSIDE_WORKSPACE",
      "빌드 경로가 workspace 외부를 가리킵니다.",
    );
  }
  return resolved;
}

async function canonicalizeInsideWorkspace(
  workspacePath: string,
  targetPath: string,
): Promise<string> {
  const canonicalPath = await fs.realpath(targetPath);
  const relative = path.relative(workspacePath, canonicalPath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new BuildError(
      "BUILD_PATH_OUTSIDE_WORKSPACE",
      "빌드 경로의 실제 대상이 workspace 외부를 가리킵니다.",
    );
  }
  return canonicalPath;
}

async function requireDirectory(directoryPath: string): Promise<void> {
  try {
    const stats = await fs.stat(directoryPath);
    if (stats.isDirectory()) return;
  } catch {
    // Normalized below.
  }
  throw new BuildError(
    "BUILD_CONTEXT_NOT_FOUND",
    "빌드 context 디렉터리를 찾을 수 없습니다.",
  );
}

async function requireFile(
  filePath: string,
  code: "DOCKERFILE_NOT_FOUND",
): Promise<void> {
  try {
    const stats = await fs.stat(filePath);
    if (stats.isFile()) return;
  } catch {
    // Normalized below.
  }
  throw new BuildError(code, "Dockerfile을 찾을 수 없습니다.");
}

function validateRepository(repository: string): string {
  const normalized = repository.trim();
  if (
    normalized.length === 0 ||
    normalized.includes("@") ||
    /\s/.test(normalized)
  ) {
    throw new BuildError(
      "INVALID_BUILD_REQUEST",
      "유효한 image repository가 필요합니다.",
    );
  }
  return normalized.replace(/\/$/, "");
}

function validateTag(tag: string): string {
  if (!TAG_PATTERN.test(tag)) {
    throw new BuildError(
      "INVALID_BUILD_REQUEST",
      "유효한 container image tag가 필요합니다.",
    );
  }
  return tag;
}

function validateDigest(digest: string): `sha256:${string}` {
  if (!DIGEST_PATTERN.test(digest)) {
    throw new BuildError(
      "IMAGE_DIGEST_INVALID",
      "Registry가 유효한 sha256 image digest를 반환하지 않았습니다.",
    );
  }
  return digest as `sha256:${string}`;
}

function extractPushDigest(output: string): string | null {
  return output.match(/\bdigest:\s*(sha256:[0-9a-f]{64})\b/i)?.[1] ?? null;
}
