export type BuildErrorCode =
  | "INVALID_BUILD_REQUEST"
  | "BUILD_PATH_OUTSIDE_WORKSPACE"
  | "BUILD_CONTEXT_NOT_FOUND"
  | "DOCKERFILE_NOT_FOUND"
  | "BUILD_TOOL_UNAVAILABLE"
  | "BUILD_COMMAND_FAILED"
  | "IMAGE_DIGEST_MISSING"
  | "IMAGE_DIGEST_INVALID";

export class BuildError extends Error {
  constructor(
    public readonly code: BuildErrorCode,
    message: string,
    public readonly details?: Record<string, string | number>,
  ) {
    super(message);
    this.name = "BuildError";
  }
}

export class CommandExecutionError extends Error {
  constructor(
    public readonly command: string,
    public readonly exitCode: number | null,
    public readonly unavailable = false,
  ) {
    super(
      unavailable
        ? `빌드 도구 "${command}"을 실행할 수 없습니다.`
        : `빌드 명령 "${command}"이 실패했습니다.`,
    );
    this.name = "CommandExecutionError";
  }
}
