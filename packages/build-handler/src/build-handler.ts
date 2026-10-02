import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BuildError, CommandExecutionError } from "./errors.js";
import { NodeCommandRunner } from "./command-runner.js";
import type { StaticSiteBuildPlan } from "@camellia/adapters";
import {
  normalizeStaticSite,
  renderStaticSiteDockerfile,
  renderStaticSiteDockerignore,
} from "./static-site.js";
import {
  LAMBDA_WEB_ADAPTER_COPY,
  LAMBDA_WEB_ADAPTER_VERSION,
} from "./lambda-web-adapter.js";
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

    if (request.plan.staticSite) {
      const site = normalizeStaticSite(request.plan.staticSite);
      if (!site.buildCommand && site.outputDir !== ".") {
        const servedCandidate = resolveInsideWorkspace(contextPath, site.outputDir);
        await requireDirectory(servedCandidate);
        await canonicalizeInsideWorkspace(workspacePath, servedCandidate);
      }
      digest = await this.buildStaticSite({
        contextPath,
        site,
        taggedRef,
        platform,
        commandEnvironment: request.commandEnvironment,
      });
      strategy = "dockerfile";
    } else if (request.plan.dockerfile) {
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
        commandEnvironment: request.commandEnvironment,
      });
      strategy = "dockerfile";
    } else if (request.plan.buildpack === "railpack") {
      digest = await this.buildRailpack({
        contextPath,
        taggedRef,
        platform,
        commandEnvironment: request.commandEnvironment,
      });
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
      lambdaWebAdapter: LAMBDA_WEB_ADAPTER_VERSION,
      image: {
        repository,
        tag,
        digest: imageDigest,
        taggedRef,
        immutableRef: `${repository}@${imageDigest}`,
      },
    };
  }

  /**
   * 정적 사이트 (#273): 플랫폼이 만든 Dockerfile 로 nginx 이미지를 빌드한다.
   * Dockerfile · 전용 dockerignore 는 사용자 소스 밖 임시 폴더에 두고 끝나면 지운다.
   * 빌드는 일반 Dockerfile 과 같은 길(buildDockerfile)이라 Lambda Web Adapter 레이어도 같이 붙는다 (nginx 실행에는 영향 없음).
   */
  private async buildStaticSite(input: {
    contextPath: string;
    site: StaticSiteBuildPlan;
    taggedRef: string;
    platform: string;
    commandEnvironment?: NodeJS.ProcessEnv;
  }): Promise<string> {
    const directory = await fs.mkdtemp(path.join(this.temporaryRoot, "camellia-static-"));
    try {
      const dockerfilePath = path.join(directory, "Dockerfile");
      await fs.writeFile(dockerfilePath, renderStaticSiteDockerfile(input.site));
      await fs.writeFile(`${dockerfilePath}.dockerignore`, renderStaticSiteDockerignore(input.site));
      return await this.buildDockerfile({
        contextPath: input.contextPath,
        dockerfilePath,
        taggedRef: input.taggedRef,
        platform: input.platform,
        commandEnvironment: input.commandEnvironment,
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  /**
   * 사용자 Dockerfile 끝에 Lambda Web Adapter COPY 한 줄을 붙인 사본으로 빌드해 한 번만 push 한다.
   * 마지막 stage 에 레이어 하나가 더해질 뿐이라 CMD · USER · EXPOSE 등 실행 설정은 그대로다.
   * 사본은 소스 밖 임시 폴더에 두고, Dockerfile 전용 ignore 파일(<Dockerfile>.dockerignore)이 있으면 같이 옮긴다.
   */
  private async buildDockerfile(input: {
    contextPath: string;
    dockerfilePath: string;
    taggedRef: string;
    platform: string;
    commandEnvironment?: NodeJS.ProcessEnv;
  }): Promise<string> {
    const original = await fs.readFile(input.dockerfilePath, "utf8");
    return this.withTemporaryDirectory(async (directory) => {
      const dockerfilePath = path.join(directory, "Dockerfile");
      await fs.writeFile(dockerfilePath, withLambdaWebAdapter(original));
      const ignoreFile = await fs
        .readFile(`${input.dockerfilePath}.dockerignore`)
        .catch(() => null);
      if (ignoreFile) await fs.writeFile(`${dockerfilePath}.dockerignore`, ignoreFile);
      return this.buildxPush({ ...input, dockerfilePath, metadataDirectory: directory });
    });
  }

  /**
   * Railpack 으로 로컬 이미지를 만든 뒤, 그 이미지를 FROM 으로 Lambda Web Adapter 레이어를 더해 push 한다.
   * 로컬 이미지는 같은 Docker 데몬(docker 드라이버)에 있어 다시 받지 않는다. 중간 태그는 끝나면 지운다.
   */
  private async buildRailpack(input: {
    contextPath: string;
    taggedRef: string;
    platform: string;
    commandEnvironment?: NodeJS.ProcessEnv;
  }): Promise<string> {
    const localImage = `camellia-railpack:${randomBytes(8).toString("hex")}`;
    await this.runBuildCommand({
      command: "railpack",
      args: [
        "build",
        "--name",
        localImage,
        "--platform",
        input.platform,
        input.contextPath,
      ],
      cwd: input.contextPath,
      env: input.commandEnvironment,
    });

    try {
      return await this.withTemporaryDirectory(async (directory) => {
        const dockerfilePath = path.join(directory, "Dockerfile");
        await fs.writeFile(dockerfilePath, withLambdaWebAdapter(`FROM ${localImage}\n`));
        return this.buildxPush({
          contextPath: directory,
          dockerfilePath,
          taggedRef: input.taggedRef,
          platform: input.platform,
          commandEnvironment: input.commandEnvironment,
          metadataDirectory: directory,
        });
      });
    } finally {
      await this.runner
        .run({
          command: "docker",
          args: ["image", "rm", localImage],
          cwd: input.contextPath,
          env: input.commandEnvironment,
        })
        .catch(() => undefined);
    }
  }

  /**
   * buildx 로 빌드 · push 하고 metadata 의 digest 를 돌려준다.
   * provenance attestation 을 끄면 image index 가 아닌 단일 manifest 가 push 된다
   * — Lambda 는 attestation 이 붙은 index 를 받지 않는다.
   */
  private async buildxPush(input: {
    contextPath: string;
    dockerfilePath: string;
    taggedRef: string;
    platform: string;
    commandEnvironment?: NodeJS.ProcessEnv;
    metadataDirectory: string;
  }): Promise<string> {
    const metadataPath = path.join(input.metadataDirectory, "metadata.json");
    await this.runBuildCommand({
      command: "docker",
      args: [
        "buildx",
        "build",
        "--platform",
        input.platform,
        "--provenance=false",
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
      env: input.commandEnvironment,
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
  }

  private async withTemporaryDirectory<T>(
    task: (directory: string) => Promise<T>,
  ): Promise<T> {
    const directory = await fs.mkdtemp(
      path.join(this.temporaryRoot, "camellia-build-"),
    );
    try {
      return await task(directory);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
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
  const stats = await fs.stat(directoryPath).catch(() => null);
  if (stats?.isDirectory()) return;
  throw new BuildError(
    "BUILD_CONTEXT_NOT_FOUND",
    "빌드 context 디렉터리를 찾을 수 없습니다.",
  );
}

async function requireFile(
  filePath: string,
  code: "DOCKERFILE_NOT_FOUND",
): Promise<void> {
  const stats = await fs.stat(filePath).catch(() => null);
  if (stats?.isFile()) return;
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

/** 마지막 stage 끝에 Lambda Web Adapter 를 더한다. 원본이 줄바꿈 없이 끝나도 새 줄에서 시작한다 */
function withLambdaWebAdapter(dockerfile: string): string {
  const base = dockerfile.endsWith("\n") ? dockerfile : `${dockerfile}\n`;
  return `${base}${LAMBDA_WEB_ADAPTER_COPY}\n`;
}
