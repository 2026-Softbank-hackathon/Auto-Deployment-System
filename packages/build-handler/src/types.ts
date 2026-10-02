import type { BuildPlan } from "@camellia/adapters";

export const DEFAULT_BUILD_PLATFORM = "linux/amd64" as const;

export type BuildPlatform = typeof DEFAULT_BUILD_PLATFORM;

export type BuildRequest = {
  workspacePath: string;
  plan: BuildPlan;
  image: {
    repository: string;
    tag: string;
  };
  platform?: BuildPlatform;
  commandEnvironment?: NodeJS.ProcessEnv;
};

export type ImageRef = {
  repository: string;
  tag: string;
  digest: `sha256:${string}`;
  taggedRef: string;
  immutableRef: string;
};

export type BuildResult = {
  strategy: "dockerfile" | "railpack";
  platform: BuildPlatform;
  /** 이미지에 넣은 Lambda Web Adapter 버전 — 서버리스(Lambda) 배포에 이 이미지를 쓸 수 있는지 판단한다 */
  lambdaWebAdapter: string;
  image: ImageRef;
};

export type CommandRequest = {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
};

export type CommandResult = {
  stdout: string;
  stderr: string;
};

export interface CommandRunner {
  run(request: CommandRequest): Promise<CommandResult>;
}
