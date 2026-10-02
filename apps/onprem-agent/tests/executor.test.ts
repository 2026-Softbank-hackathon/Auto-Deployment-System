import { describe, expect, it } from "vitest";
import type {
  ImageManager,
  PreparedImage,
  RunningDeployment,
  RuntimeManager,
} from "../src/contracts.js";
import { DockerOnpremJobExecutor } from "../src/executor.js";
import { AgentError } from "../src/errors.js";
import { FakeTunnelProvider } from "../src/fakes.js";
import type { PersistedRuntime, RuntimeStateStore } from "../src/runtime-state-store.js";
import { createJob } from "./fixtures.js";

class FakeImageManager implements ImageManager {
  calls = 0;

  async prepare(): Promise<PreparedImage> {
    this.calls += 1;
    const job = createJob();
    return {
      imageUri: `${job.image.repositoryUri}@${job.image.digest}`,
      runningDigest: job.image.digest,
    };
  }
}

class FakeRuntimeManager implements RuntimeManager {
  starts = 0;
  cleanups: string[] = [];

  async start(job: ReturnType<typeof createJob>): Promise<RunningDeployment> {
    this.starts += 1;
    return {
      projectName: `project-${job.image.digest.slice(-8)}`,
      localUrl: "http://127.0.0.1:49152",
      isRunning: async () => true,
      cleanup: async () => {
        this.cleanups.push(job.image.digest);
      },
    };
  }
}

class FakeRuntimeStateStore implements RuntimeStateStore {
  readonly records = new Map<number, PersistedRuntime>();

  async load(): Promise<PersistedRuntime[]> {
    return [...this.records.values()];
  }

  async save(runtime: PersistedRuntime): Promise<void> {
    this.records.set(runtime.deploymentId, runtime);
  }

  async remove(deploymentId: number): Promise<void> {
    this.records.delete(deploymentId);
  }
}

describe("On-Prem job 실행", () => {
  it("Fake Tunnel endpoint까지 확보한 뒤 ready_for_verify를 반환한다", async () => {
    const tunnel = new FakeTunnelProvider("https://fake.example.test");
    const executor = new DockerOnpremJobExecutor({
      imageManager: new FakeImageManager(),
      runtimeManager: new FakeRuntimeManager(),
      tunnelProvider: tunnel,
      now: () => new Date("2026-10-01T00:00:00.000Z"),
    });

    await expect(executor.execute(createJob())).resolves.toMatchObject({
      status: "ready_for_verify",
      endpoint: "https://fake.example.test",
      localUrl: "http://127.0.0.1:49152",
      runningDigest: createJob().image.digest,
    });
    expect(tunnel.starts).toEqual([
      {
        jobId: "job-001",
        deploymentId: 42,
        environmentId: "env-onprem-1",
        localPort: 49_152,
      },
    ]);
  });

  it("Tunnel provider가 없으면 리소스를 정리하고 실패한다", async () => {
    const runtime = new FakeRuntimeManager();
    const executor = new DockerOnpremJobExecutor({
      imageManager: new FakeImageManager(),
      runtimeManager: runtime,
      now: () => new Date("2026-10-01T00:00:00.000Z"),
    });

    await expect(executor.execute(createJob())).resolves.toMatchObject({
      status: "failed",
      errorCode: "tunnel_not_configured",
    });
    expect(runtime.cleanups).toEqual([createJob().image.digest]);
  });

  it("빈 endpoint로 ready_for_verify를 반환하지 않는다", async () => {
    const executor = new DockerOnpremJobExecutor({
      imageManager: new FakeImageManager(),
      runtimeManager: new FakeRuntimeManager(),
      tunnelProvider: new FakeTunnelProvider(""),
      now: () => new Date("2026-10-01T00:00:00.000Z"),
    });

    await expect(executor.execute(createJob())).resolves.toMatchObject({
      status: "failed",
      errorCode: "tunnel_failed",
    });
  });

  it("동일 job 동시 실행과 완료 job 재수신을 한 번만 실행한다", async () => {
    const image = new FakeImageManager();
    const runtime = new FakeRuntimeManager();
    const executor = new DockerOnpremJobExecutor({
      imageManager: image,
      runtimeManager: runtime,
      tunnelProvider: new FakeTunnelProvider("https://fake.example.test"),
    });

    const [first, second] = await Promise.all([
      executor.execute(createJob()),
      executor.execute(createJob()),
    ]);
    const third = await executor.execute(createJob());

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(image.calls).toBe(1);
    expect(runtime.starts).toBe(1);
  });

  it("같은 deployment의 같은 digest는 재생성하지 않고 현재 결과를 반환한다", async () => {
    const runtime = new FakeRuntimeManager();
    const executor = new DockerOnpremJobExecutor({
      imageManager: new FakeImageManager(),
      runtimeManager: runtime,
      tunnelProvider: new FakeTunnelProvider("https://fake.example.test"),
    });

    await executor.execute(createJob());
    const result = await executor.execute(createJob({ jobId: "job-002" }));

    expect(result.jobId).toBe("job-002");
    expect(result.status).toBe("ready_for_verify");
    expect(runtime.starts).toBe(1);
  });

  it("같은 digest라도 컨테이너가 중단됐으면 정리 후 다시 실행한다", async () => {
    let running = true;
    let starts = 0;
    let cleanups = 0;
    const executor = new DockerOnpremJobExecutor({
      imageManager: new FakeImageManager(),
      runtimeManager: {
        async start() {
          starts += 1;
          return {
            projectName: `project-${starts}`,
            localUrl: `http://127.0.0.1:${49_151 + starts}`,
            isRunning: async () => running,
            cleanup: async () => {
              cleanups += 1;
            },
          };
        },
      },
      tunnelProvider: new FakeTunnelProvider("https://fake.example.test"),
    });

    await executor.execute(createJob());
    running = false;
    await executor.execute(createJob({ jobId: "job-002" }));

    expect(starts).toBe(2);
    expect(cleanups).toBe(1);
  });

  it("같은 digest라도 Tunnel이 중단됐으면 정리 후 다시 실행한다", async () => {
    const runtime = new FakeRuntimeManager();
    let tunnelRunning = true;
    let tunnelStarts = 0;
    const executor = new DockerOnpremJobExecutor({
      imageManager: new FakeImageManager(),
      runtimeManager: runtime,
      tunnelProvider: {
        async start() {
          tunnelStarts += 1;
          tunnelRunning = true;
          return { endpoint: "https://fake.example.test" };
        },
        async stop() {
          tunnelRunning = false;
        },
        async isRunning() {
          return tunnelRunning;
        },
      },
    });

    await executor.execute(createJob());
    tunnelRunning = false;
    await executor.execute(createJob({ jobId: "job-002" }));

    expect(runtime.starts).toBe(2);
    expect(tunnelStarts).toBe(2);
    expect(runtime.cleanups).toEqual([createJob().image.digest]);
  });

  it("다른 digest 성공 후에만 이전 버전 리소스를 정리한다", async () => {
    const runtime = new FakeRuntimeManager();
    const executor = new DockerOnpremJobExecutor({
      imageManager: {
        async prepare(job) {
          return {
            imageUri: `${job.image.repositoryUri}@${job.image.digest}`,
            runningDigest: job.image.digest,
          };
        },
      },
      runtimeManager: runtime,
      tunnelProvider: new FakeTunnelProvider("https://fake.example.test"),
    });

    await executor.execute(createJob());
    const nextDigest = `sha256:${"b".repeat(64)}`;
    await executor.execute(
      createJob({
        jobId: "job-002",
        image: { ...createJob().image, digest: nextDigest },
      }),
    );

    expect(runtime.starts).toBe(2);
    expect(runtime.cleanups).toEqual([createJob().image.digest]);
  });

  it("이미 취소된 job은 실행하지 않고 cancelled 결과를 캐시한다", async () => {
    const image = new FakeImageManager();
    const controller = new AbortController();
    controller.abort();
    const executor = new DockerOnpremJobExecutor({
      imageManager: image,
      runtimeManager: new FakeRuntimeManager(),
      tunnelProvider: new FakeTunnelProvider("https://fake.example.test"),
    });

    const first = await executor.execute(createJob(), {
      signal: controller.signal,
    });
    const second = await executor.execute(createJob());

    expect(first).toMatchObject({ status: "failed", errorCode: "cancelled" });
    expect(second).toEqual(first);
    expect(image.calls).toBe(0);
  });

  it("Tunnel 단계에서 취소되면 후속 성공을 중단하고 생성한 리소스를 정리한다", async () => {
    const controller = new AbortController();
    const runtime = new FakeRuntimeManager();
    const tunnel = new FakeTunnelProvider("https://fake.example.test");
    const executor = new DockerOnpremJobExecutor({
      imageManager: new FakeImageManager(),
      runtimeManager: runtime,
      tunnelProvider: {
        async start(input) {
          controller.abort();
          return tunnel.start(input);
        },
        async stop(deploymentId) {
          return tunnel.stop(deploymentId);
        },
      },
    });

    const result = await executor.execute(createJob(), {
      signal: controller.signal,
    });

    expect(result).toMatchObject({ status: "failed", errorCode: "cancelled" });
    expect(runtime.cleanups).toEqual([createJob().image.digest]);
    expect(tunnel.stops).toEqual([createJob().deploymentId]);
  });

  it("Tunnel 준비 요청 중 취소 오류를 tunnel_failed로 덮어쓰지 않는다", async () => {
    const runtime = new FakeRuntimeManager();
    const executor = new DockerOnpremJobExecutor({
      imageManager: new FakeImageManager(),
      runtimeManager: runtime,
      tunnelProvider: {
        async start() {
          throw new AgentError("cancelled", "작업이 취소되었습니다.");
        },
        async stop() {},
      },
    });

    await expect(executor.execute(createJob())).resolves.toMatchObject({
      status: "failed",
      errorCode: "cancelled",
    });
    expect(runtime.cleanups).toEqual([createJob().image.digest]);
  });

  it("실패한 job은 더 높은 attempt에서 다시 실행한다", async () => {
    let starts = 0;
    const executor = new DockerOnpremJobExecutor({
      imageManager: new FakeImageManager(),
      runtimeManager: {
        async start() {
          starts += 1;
          if (starts === 1) {
            throw new AgentError("compose_failed", "first failure");
          }
          return {
            projectName: "project-retry",
            localUrl: "http://127.0.0.1:49152",
            isRunning: async () => true,
            cleanup: async () => {},
          };
        },
      },
      tunnelProvider: new FakeTunnelProvider("https://fake.example.test"),
    });

    const first = await executor.execute(createJob());
    const second = await executor.execute(createJob({ attempt: 2 }));

    expect(first).toMatchObject({ status: "failed", errorCode: "compose_failed" });
    expect(second).toMatchObject({ status: "ready_for_verify" });
    expect(starts).toBe(2);
  });

  it("종료 시 Tunnel만 멈추고 활성 Compose와 복구 상태는 보존한다", async () => {
    const runtime = new FakeRuntimeManager();
    const tunnel = new FakeTunnelProvider("https://fake.example.test");
    const stateStore = new FakeRuntimeStateStore();
    const executor = new DockerOnpremJobExecutor({
      imageManager: new FakeImageManager(),
      runtimeManager: runtime,
      tunnelProvider: tunnel,
      stateStore,
    });

    await executor.execute(createJob());
    await executor.shutdown();
    await executor.shutdown();

    expect(tunnel.stops).toEqual([createJob().deploymentId]);
    expect(runtime.cleanups).toEqual([]);
    expect(stateStore.records.has(createJob().deploymentId)).toBe(true);
  });

  it("저장된 Compose를 복구하고 inventory를 보고하며 요구 상태 밖 런타임을 정리한다", async () => {
    const stateStore = new FakeRuntimeStateStore();
    const tunnel = new FakeTunnelProvider("https://fake.example.test");
    const job = createJob();
    stateStore.records.set(job.deploymentId, {
      jobId: job.jobId,
      deploymentId: job.deploymentId,
      environmentId: job.environmentId,
      digest: job.image.digest,
      imageUri: `${job.image.repositoryUri}@${job.image.digest}`,
      projectName: "camellia-d42-1234567890-aaaaaaaaaaaa",
      localUrl: "http://127.0.0.1:49152",
      endpoint: "https://fake.example.test",
      health: job.plan.health,
    });
    let cleaned = false;
    const executor = new DockerOnpremJobExecutor({
      imageManager: new FakeImageManager(),
      runtimeManager: {
        async start() {
          throw new Error("not used");
        },
        async restore() {
          return {
            projectName: "camellia-d42-1234567890-aaaaaaaaaaaa",
            localUrl: "http://127.0.0.1:49152",
            isRunning: async () => true,
            isHealthy: async () => true,
            cleanup: async () => { cleaned = true; },
          };
        },
      },
      tunnelProvider: tunnel,
      stateStore,
    });

    await executor.restore();
    await expect(executor.inventory()).resolves.toEqual([{
      deploymentId: "42",
      digest: job.image.digest,
      status: "running",
      health: "healthy",
    }]);

    await executor.reconcile([]);
    expect(cleaned).toBe(true);
    expect(stateStore.records.size).toBe(0);
  });

  it("요구 상태 밖 런타임 정리에 실패하면 상태를 보존하고 다음 heartbeat에서 재시도한다", async () => {
    const stateStore = new FakeRuntimeStateStore();
    const tunnel = new FakeTunnelProvider("https://fake.example.test");
    let cleanupAttempts = 0;
    const executor = new DockerOnpremJobExecutor({
      imageManager: new FakeImageManager(),
      runtimeManager: {
        async start() {
          return {
            projectName: "camellia-d42-1234567890-aaaaaaaaaaaa",
            localUrl: "http://127.0.0.1:49152",
            isRunning: async () => true,
            isHealthy: async () => true,
            cleanup: async () => {
              cleanupAttempts += 1;
              if (cleanupAttempts === 1) throw new Error("docker unavailable");
            },
          };
        },
      },
      tunnelProvider: tunnel,
      stateStore,
    });

    await executor.execute(createJob());
    await expect(executor.reconcile([])).rejects.toThrow("docker unavailable");
    expect(stateStore.records.has(createJob().deploymentId)).toBe(true);
    await expect(executor.inventory()).resolves.toHaveLength(1);

    await expect(executor.reconcile([])).resolves.toBeUndefined();
    expect(cleanupAttempts).toBe(2);
    expect(stateStore.records.size).toBe(0);
    await expect(executor.inventory()).resolves.toEqual([]);
  });

  it("cleanup Job은 Tunnel·Compose·로컬 상태를 배포 ID 기준으로 멱등 정리한다", async () => {
    const runtime = new FakeRuntimeManager();
    const tunnel = new FakeTunnelProvider("https://fake.example.test");
    const stateStore = new FakeRuntimeStateStore();
    const executor = new DockerOnpremJobExecutor({
      imageManager: new FakeImageManager(),
      runtimeManager: runtime,
      tunnelProvider: tunnel,
      stateStore,
    });

    await executor.execute(createJob());
    await executor.cleanup(createJob().deploymentId);
    await executor.cleanup(createJob().deploymentId);

    expect(tunnel.stops).toEqual([createJob().deploymentId, createJob().deploymentId]);
    expect(runtime.cleanups).toEqual([createJob().image.digest]);
    expect(stateStore.records.size).toBe(0);
    await expect(executor.inventory()).resolves.toEqual([]);
  });
});
