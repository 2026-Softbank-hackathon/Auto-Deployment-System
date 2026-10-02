import { GetFunctionCommand } from "@aws-sdk/client-lambda";
import { describe, expect, it } from "vitest";
import { LambdaRolloutError, LambdaRolloutWaiter } from "../src/lambda-rollout.js";

const DIGEST = `sha256:${"b".repeat(64)}`;
const OLD_DIGEST = `sha256:${"a".repeat(64)}`;
const REPOSITORY = "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/camellia-project-7";

type Snapshot = {
  State?: string;
  StateReason?: string;
  StateReasonCode?: string;
  LastUpdateStatus?: string;
  LastUpdateStatusReason?: string;
  LastUpdateStatusReasonCode?: string;
  Version?: string;
  digest?: string;
};

const active = (patch: Snapshot = {}): Snapshot => ({
  State: "Active",
  LastUpdateStatus: "Successful",
  Version: "3",
  digest: DIGEST,
  ...patch,
});

function harness(snapshots: Array<Snapshot | Error>, options: { timeoutMs?: number } = {}) {
  let clock = 0;
  const requests: unknown[] = [];
  const lines: string[] = [];
  let index = 0;
  const waiter = new LambdaRolloutWaiter({
    createClient: () => ({
      async send(command: unknown) {
        expect(command).toBeInstanceOf(GetFunctionCommand);
        requests.push((command as GetFunctionCommand).input);
        const snapshot = snapshots[Math.min(index, snapshots.length - 1)]!;
        index += 1;
        if (snapshot instanceof Error) throw snapshot;
        const { digest, ...configuration } = snapshot;
        return {
          Configuration: configuration,
          Code: digest
            ? { ImageUri: `${REPOSITORY}@${digest}`, ResolvedImageUri: `${REPOSITORY}@${digest}` }
            : {},
        };
      },
    }),
    pollIntervalMs: 2_000,
    timeoutMs: options.timeoutMs ?? 60_000,
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  });
  const wait = () => waiter.wait({
    region: "ap-northeast-2",
    credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
    functionName: "cam-0123456789abcdef",
    alias: "live",
    expectedDigest: DIGEST,
    log: async (line) => { lines.push(line); },
  });
  return { wait, requests, lines };
}

describe("LambdaRolloutWaiter", () => {
  it("returns once the live alias runs the new image and the update succeeded", async () => {
    const { wait, requests, lines } = harness([
      active({ State: "Pending", LastUpdateStatus: "InProgress" }),
      active({ LastUpdateStatus: "InProgress" }),
      active(),
    ]);

    await wait();

    expect(requests[0]).toEqual({ FunctionName: "cam-0123456789abcdef", Qualifier: "live" });
    expect(requests).toHaveLength(3);
    expect(lines[0]).toContain("2초 간격");
    expect(lines.some((line) => line.includes("Pending"))).toBe(true);
    expect(lines.at(-1)).toMatch(/Lambda 갱신 완료 \(4초\) — 버전 3/);
  });

  it("fails with the Lambda reason when the update fails", async () => {
    const { wait } = harness([
      active({
        LastUpdateStatus: "Failed",
        LastUpdateStatusReasonCode: "ImageAccessDenied",
        LastUpdateStatusReason: "Lambda does not have permission to access the ECR image.",
      }),
    ]);

    await expect(wait()).rejects.toMatchObject({
      code: "LAMBDA_UPDATE_FAILED",
      detail: expect.stringContaining("ImageAccessDenied"),
    });
  });

  it("fails when the function itself is in the Failed state", async () => {
    const { wait } = harness([
      active({ State: "Failed", StateReasonCode: "InvalidImage", StateReason: "The image manifest is not supported." }),
    ]);

    await expect(wait()).rejects.toMatchObject({
      code: "LAMBDA_UPDATE_FAILED",
      detail: expect.stringContaining("InvalidImage"),
    });
  });

  it("fails when the alias still points to another image after the update", async () => {
    const { wait } = harness([active({ digest: OLD_DIGEST })]);

    await expect(wait()).rejects.toMatchObject({
      code: "LAMBDA_IMAGE_MISMATCH",
      detail: expect.stringContaining(OLD_DIGEST.slice(0, 19)),
    });
  });

  it("times out with the last state", async () => {
    const { wait } = harness([active({ LastUpdateStatus: "InProgress" })], { timeoutMs: 10_000 });

    const error = await wait().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LambdaRolloutError);
    expect(error).toMatchObject({ code: "LAMBDA_ROLLOUT_TIMEOUT", detail: expect.stringContaining("InProgress") });
  });

  it("wraps AWS API errors", async () => {
    const denied = Object.assign(new Error("not authorized to perform lambda:GetFunction"), { name: "AccessDeniedException" });
    const { wait } = harness([denied]);

    await expect(wait()).rejects.toMatchObject({
      code: "LAMBDA_ROLLOUT_CHECK_FAILED",
      detail: expect.stringContaining("AccessDeniedException"),
    });
  });
});
