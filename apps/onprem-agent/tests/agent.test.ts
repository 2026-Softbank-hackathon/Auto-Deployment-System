import { describe, expect, it } from "vitest";
import { AgentService } from "../src/agent.js";
import type { OnpremJobExecutor } from "../src/contracts.js";
import { FakeControlPlaneClient } from "../src/fakes.js";
import { createJob } from "./fixtures.js";

describe("Agent 작업 수신과 상태 보고", () => {
  it("claim한 job 결과를 보고하고 heartbeat를 전송한다", async () => {
    const client = new FakeControlPlaneClient([createJob()]);
    const executor: OnpremJobExecutor = {
      async execute(job) {
        return {
          deploymentId: job.deploymentId,
          environmentId: job.environmentId,
          jobId: job.jobId,
          status: "failed",
          imageUri: `${job.image.repositoryUri}@${job.image.digest}`,
          errorCode: "internal_error",
          errorMessage: "test",
          startedAt: "2026-10-01T00:00:00.000Z",
          finishedAt: "2026-10-01T00:00:00.000Z",
        };
      },
    };
    const service = new AgentService(client, executor, {
      heartbeatIntervalMs: 5,
    });

    await service.sendHeartbeat();
    await service.pollOnce();

    expect(client.heartbeats).toEqual([undefined, "job-001"]);
    expect(client.reportedResults).toHaveLength(1);
    expect(client.reportedResults[0]?.jobId).toBe("job-001");
  });

  it("서버 취소를 확인하면 실행 signal을 중단한다", async () => {
    const client = new FakeControlPlaneClient([createJob()]);
    client.cancel("job-001");
    let aborted = false;
    const executor: OnpremJobExecutor = {
      async execute(job, options) {
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) {
            aborted = true;
            resolve();
            return;
          }
          options?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
        });
        return {
          deploymentId: job.deploymentId,
          environmentId: job.environmentId,
          jobId: job.jobId,
          status: "failed",
          imageUri: `${job.image.repositoryUri}@${job.image.digest}`,
          errorCode: "cancelled",
          errorMessage: "작업이 취소되었습니다.",
          startedAt: "2026-10-01T00:00:00.000Z",
          finishedAt: "2026-10-01T00:00:00.000Z",
        };
      },
    };
    const service = new AgentService(client, executor, {
      heartbeatIntervalMs: 1,
    });

    await service.pollOnce();

    expect(aborted).toBe(true);
    expect(client.reportedResults[0]).toMatchObject({
      status: "failed",
      errorCode: "cancelled",
    });
  });

  it("종료 시 실행기의 활성 리소스 정리를 기다린다", async () => {
    const client = new FakeControlPlaneClient();
    let shutdownCompleted = false;
    const executor: OnpremJobExecutor = {
      async execute() {
        throw new Error("not used");
      },
      async shutdown() {
        await Promise.resolve();
        shutdownCompleted = true;
      },
    };
    const service = new AgentService(client, executor);

    await service.shutdown();

    expect(shutdownCompleted).toBe(true);
  });
});
