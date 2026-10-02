/**
 * apps/worker/src/lambda-rollout.ts
 *
 * aws-lambda-basic 프로필 (#282) — Terraform apply 뒤 Lambda 갱신이 끝났는지 확인한다.
 * Terraform 은 이미지 갱신(UpdateFunctionCode) → 버전 발행 → live alias 이동까지 하고 돌아온다.
 * 워커는 ECS 롤아웃 확인(ecs-rollout.ts)처럼 2초마다 live alias 를 조회해, 함수가 Active 이고
 * 마지막 갱신이 Successful 이며 alias 가 이번 이미지 digest 를 가리킬 때 검증으로 넘긴다.
 * 실패하면 Lambda 가 남긴 이유(LastUpdateStatusReason · StateReason)를 그대로 보여 준다.
 */

import { GetFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { TerraformAwsCredentials } from "./terraform-cli.js";

export type LambdaRolloutErrorCode =
  | "LAMBDA_UPDATE_FAILED"
  | "LAMBDA_IMAGE_MISMATCH"
  | "LAMBDA_ROLLOUT_TIMEOUT"
  | "LAMBDA_ROLLOUT_CHECK_FAILED";

export class LambdaRolloutError extends Error {
  constructor(
    readonly code: LambdaRolloutErrorCode,
    readonly detail: string,
  ) {
    super(code);
    this.name = "LambdaRolloutError";
  }
}

export type LambdaRolloutInput = {
  region: string;
  credentials: TerraformAwsCredentials;
  functionName: string;
  /** ALB 가 호출하는 alias */
  alias: string;
  /** 이번 배포 이미지 digest (sha256:...) */
  expectedDigest: string;
  log: (line: string) => Promise<void>;
};

type SendClient = { send(command: unknown): Promise<unknown> };

type FunctionSnapshot = {
  Configuration?: {
    State?: string;
    StateReason?: string;
    StateReasonCode?: string;
    LastUpdateStatus?: string;
    LastUpdateStatusReason?: string;
    LastUpdateStatusReasonCode?: string;
    Version?: string;
  };
  Code?: { ImageUri?: string; ResolvedImageUri?: string };
};

const POLL_INTERVAL_MS = 2_000;
const TIMEOUT_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 30_000;

export class LambdaRolloutWaiter {
  private readonly createClient: (region: string, credentials: TerraformAwsCredentials) => SendClient;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: {
    createClient?: (region: string, credentials: TerraformAwsCredentials) => SendClient;
    pollIntervalMs?: number;
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {}) {
    this.createClient = options.createClient
      ?? ((region, credentials) => new LambdaClient({ region, credentials }) as SendClient);
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  async wait(input: LambdaRolloutInput): Promise<void> {
    try {
      await this.poll(input);
    } catch (error) {
      if (error instanceof LambdaRolloutError) throw error;
      const name = (error as { name?: unknown } | null)?.name;
      const message = error instanceof Error ? error.message : String(error);
      throw new LambdaRolloutError(
        "LAMBDA_ROLLOUT_CHECK_FAILED",
        `Lambda 함수 상태를 조회하지 못했습니다: ${typeof name === "string" ? `${name}: ` : ""}${message}`,
      );
    }
  }

  private async poll(input: LambdaRolloutInput): Promise<void> {
    const client = this.createClient(input.region, input.credentials);
    const startedAt = this.now();
    let lastLine: string | undefined;
    let lastWriteAt = startedAt;
    const elapsed = () => Math.round((this.now() - startedAt) / 1000);

    await input.log(
      `Lambda 갱신 확인 시작 (함수 ${input.functionName}:${input.alias}, ${this.pollIntervalMs / 1000}초 간격)`,
    );

    for (;;) {
      const snapshot = (await client.send(
        new GetFunctionCommand({ FunctionName: input.functionName, Qualifier: input.alias }),
      )) as FunctionSnapshot;
      const configuration = snapshot.Configuration ?? {};
      const state = configuration.State ?? "?";
      const update = configuration.LastUpdateStatus ?? "?";
      const imageUri = snapshot.Code?.ResolvedImageUri ?? snapshot.Code?.ImageUri ?? "";

      if (state === "Failed" || update === "Failed") {
        const reason = state === "Failed"
          ? [configuration.StateReasonCode, configuration.StateReason]
          : [configuration.LastUpdateStatusReasonCode, configuration.LastUpdateStatusReason];
        throw new LambdaRolloutError(
          "LAMBDA_UPDATE_FAILED",
          `Lambda 함수 갱신이 실패했습니다: ${reason.filter(Boolean).join(" — ") || "이유 없음"}`,
        );
      }

      if (state === "Active" && update === "Successful") {
        if (!imageUri.endsWith(`@${input.expectedDigest}`)) {
          throw new LambdaRolloutError(
            "LAMBDA_IMAGE_MISMATCH",
            `${input.alias} alias 가 이번 이미지가 아닌 ${digestOf(imageUri)} 를 가리킵니다 (기대: ${shortDigest(input.expectedDigest)}).`,
          );
        }
        await input.log(
          `Lambda 갱신 완료 (${elapsed()}초) — 버전 ${configuration.Version ?? "?"}, 이미지 ${shortDigest(input.expectedDigest)}`,
        );
        return;
      }

      const line = state === "Pending"
        ? `함수 준비 중 (State Pending) — Lambda 가 이미지를 가져와 준비합니다`
        : `갱신 진행 중 (State ${state}, LastUpdateStatus ${update})`;
      if (line !== lastLine) {
        lastLine = line;
        lastWriteAt = this.now();
        await input.log(line);
      }

      if (this.now() - startedAt >= this.timeoutMs) {
        throw new LambdaRolloutError(
          "LAMBDA_ROLLOUT_TIMEOUT",
          `Lambda 갱신이 ${Math.round(this.timeoutMs / 60_000)}분 안에 끝나지 않았습니다. 마지막 상태: State ${state}, LastUpdateStatus ${update}`,
        );
      }
      if (this.now() - lastWriteAt >= HEARTBEAT_MS) {
        lastWriteAt = this.now();
        await input.log(`Lambda 갱신 대기 중 (${elapsed()}초 경과)`);
      }
      await this.sleep(this.pollIntervalMs);
    }
  }
}

function digestOf(imageUri: string): string {
  const digest = imageUri.split("@")[1];
  return digest ? shortDigest(digest) : imageUri || "알 수 없는 이미지";
}

function shortDigest(digest: string): string {
  return digest.slice(0, 19);
}
