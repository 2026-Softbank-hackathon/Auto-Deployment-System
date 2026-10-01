import type {
  AgentControlPlaneClient,
  CommandRunner,
  EcrCredential,
  ImageManager,
  OnpremAgentJob,
  PreparedImage,
} from "./contracts.js";
import { AgentError, throwIfAborted } from "./errors.js";
import {
  imageUriForJob,
  validateEcrCredential,
} from "./validation.js";

type EcrImageManagerOptions = {
  now?: () => Date;
};

export class EcrImageManager implements ImageManager {
  private readonly now: () => Date;

  constructor(
    private readonly client: AgentControlPlaneClient,
    private readonly runner: CommandRunner,
    options: EcrImageManagerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async prepare(
    job: OnpremAgentJob,
    signal?: AbortSignal,
  ): Promise<PreparedImage> {
    throwIfAborted(signal);
    let credential: EcrCredential;
    try {
      credential = await this.client.getEcrCredential(job.jobId);
      validateEcrCredential(job, credential, this.now());
    } catch (error) {
      if (error instanceof AgentError && error.code === "cancelled") throw error;
      if (error instanceof AgentError && error.code === "ecr_auth_failed") throw error;
      throw new AgentError(
        "ecr_auth_failed",
        "ECR 인증정보를 조회할 수 없습니다.",
      );
    }
    const imageUri = imageUriForJob(job);
    let primaryError: unknown;
    let prepared: PreparedImage | undefined;
    let logoutFailed = false;

    try {
      try {
        await this.runner.run({
          command: "docker",
          args: [
            "login",
            credential.registry,
            "--username",
            credential.username,
            "--password-stdin",
          ],
          stdin: credential.password,
          signal,
        });
      } catch (error) {
        if (error instanceof AgentError && error.code === "cancelled") throw error;
        throw new AgentError("ecr_auth_failed", "ECR 로그인에 실패했습니다.");
      }

      throwIfAborted(signal);
      try {
        await this.runner.run({
          command: "docker",
          args: ["pull", "--platform", job.image.platform, imageUri],
          signal,
        });
      } catch (error) {
        if (error instanceof AgentError && error.code === "cancelled") throw error;
        throw new AgentError("image_pull_failed", "이미지 pull에 실패했습니다.");
      }

      throwIfAborted(signal);
      let inspectOutput: string;
      try {
        const result = await this.runner.run({
          command: "docker",
          args: ["inspect", "--format", "{{json .RepoDigests}}", imageUri],
          signal,
        });
        inspectOutput = result.stdout.trim();
      } catch (error) {
        if (error instanceof AgentError && error.code === "cancelled") throw error;
        throw new AgentError(
          "image_pull_failed",
          "pull한 이미지 정보를 확인할 수 없습니다.",
        );
      }

      let repoDigests: unknown;
      try {
        repoDigests = JSON.parse(inspectOutput);
      } catch {
        throw new AgentError(
          "digest_mismatch",
          "pull한 이미지 digest를 확인할 수 없습니다.",
        );
      }
      if (
        !Array.isArray(repoDigests) ||
        !repoDigests.some((value) => value === imageUri)
      ) {
        throw new AgentError(
          "digest_mismatch",
          "pull한 이미지 digest가 요청과 일치하지 않습니다.",
        );
      }

      prepared = { imageUri, runningDigest: job.image.digest };
    } catch (error) {
      primaryError = error;
    }

    try {
      // logout은 로컬 인증정보 제거이며 ECR 토큰 자체의 서버 만료를 취소하지 않음.
      await this.runner.run({
        command: "docker",
        args: ["logout", credential.registry],
      });
    } catch {
      logoutFailed = true;
    }

    if (primaryError !== undefined) throw primaryError;
    if (logoutFailed) {
      throw new AgentError(
        "ecr_auth_failed",
        "로컬 ECR 인증정보를 제거하지 못했습니다.",
      );
    }
    if (!prepared) {
      throw new AgentError("internal_error", "이미지 준비 결과가 없습니다.");
    }
    return prepared;
  }
}
