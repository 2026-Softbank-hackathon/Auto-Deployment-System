import { describe, expect, it } from "vitest";
import type {
  BackgroundProcess,
  BackgroundProcessRunner,
  CommandRequest,
  TunnelReadinessChecker,
  TunnelSessionProvider,
} from "../src/contracts.js";
import { CloudflaredTunnelProvider } from "../src/tunnel.js";
import { LocalTunnelReadinessChecker } from "../src/tunnel.js";

class FakeProcess implements BackgroundProcess {
  running = true;
  stopCount = 0;
  private readonly exitPromise: Promise<void>;
  private resolveExit: () => void = () => undefined;

  constructor() {
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  async waitForExit(): Promise<void> {
    await this.exitPromise;
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
    this.running = false;
    this.resolveExit();
  }
}

class FakeProcessRunner implements BackgroundProcessRunner {
  readonly requests: CommandRequest[] = [];
  readonly processes: FakeProcess[] = [];

  async start(request: CommandRequest): Promise<BackgroundProcess> {
    this.requests.push(request);
    const process = new FakeProcess();
    this.processes.push(process);
    return process;
  }
}

class FakeReadinessChecker implements TunnelReadinessChecker {
  readonly urls: string[] = [];

  async waitUntilReady(url: string): Promise<void> {
    this.urls.push(url);
  }
}

function createSessionProvider(): TunnelSessionProvider & {
  inputs: Array<{
    jobId: string;
    deploymentId: number;
    environmentId: string;
    localPort: number;
  }>;
} {
  const inputs: Array<{
    jobId: string;
    deploymentId: number;
    environmentId: string;
    localPort: number;
  }> = [];
  return {
    inputs,
    async prepare(input) {
      inputs.push(input);
      return {
        tunnelId: `tunnel-${input.deploymentId}`,
        token: "sensitive-tunnel-token",
        hostname: `verify-${input.deploymentId}.example.test`,
      };
    },
  };
}

describe("CloudflaredTunnelProvider", () => {
  it("동적 localPort를 서버 경계에 보고한 뒤 Token을 환경변수로만 전달한다", async () => {
    const sessions = createSessionProvider();
    const processes = new FakeProcessRunner();
    const readiness = new FakeReadinessChecker();
    const provider = new CloudflaredTunnelProvider({
      sessions,
      processes,
      readiness,
      allocateMetricsPort: async () => 20_241,
      environment: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: "/Users/agent",
        SystemRoot: "C:\\Windows",
        ONPREM_AGENT_REGISTRATION_TOKEN: "registration-secret",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
      },
    });

    await expect(
      provider.start({
        jobId: "job-001",
        deploymentId: 42,
        environmentId: "env-onprem-1",
        localPort: 49_152,
      }),
    ).resolves.toEqual({
      tunnelId: "tunnel-42",
      endpoint: "https://verify-42.example.test",
    });

    expect(sessions.inputs).toEqual([
      {
        jobId: "job-001",
        deploymentId: 42,
        environmentId: "env-onprem-1",
        localPort: 49_152,
      },
    ]);
    expect(processes.requests).toHaveLength(1);
    expect(processes.requests[0]).toMatchObject({
      command: "cloudflared",
      args: [
        "tunnel",
        "--no-autoupdate",
        "--loglevel",
        "info",
        "--metrics",
        "127.0.0.1:20241",
        "run",
      ],
    });
    expect(processes.requests[0]?.args).not.toContain("sensitive-tunnel-token");
    expect(processes.requests[0]?.stdin).toBeUndefined();
    expect(processes.requests[0]?.env?.TUNNEL_TOKEN).toBe(
      "sensitive-tunnel-token",
    );
    expect(processes.requests[0]?.env).toMatchObject({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/Users/agent",
      SystemRoot: "C:\\Windows",
    });
    expect(processes.requests[0]?.env?.ONPREM_AGENT_REGISTRATION_TOKEN).toBeUndefined();
    expect(processes.requests[0]?.env?.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(readiness.urls).toEqual(["http://127.0.0.1:20241/ready"]);
  });

  it("새 실행이 준비된 뒤 같은 deployment의 이전 Tunnel 프로세스를 종료한다", async () => {
    const processes = new FakeProcessRunner();
    const provider = new CloudflaredTunnelProvider({
      sessions: createSessionProvider(),
      processes,
      readiness: new FakeReadinessChecker(),
      allocateMetricsPort: async () => 20_241 + processes.processes.length,
    });
    const input = {
      jobId: "job-001",
      deploymentId: 42,
      environmentId: "env-onprem-1",
      localPort: 49_152,
    };

    await provider.start(input);
    await provider.start({ ...input, jobId: "job-002" });

    expect(processes.processes[0]?.stopCount).toBe(1);
    expect(processes.processes[1]?.isRunning()).toBe(true);
  });

  it("준비 확인이 실패하면 새 프로세스를 정리하고 활성화하지 않는다", async () => {
    const processes = new FakeProcessRunner();
    const provider = new CloudflaredTunnelProvider({
      sessions: createSessionProvider(),
      processes,
      readiness: {
        async waitUntilReady() {
          throw new Error("not ready");
        },
      },
      allocateMetricsPort: async () => 20_241,
    });

    await expect(
      provider.start({
        jobId: "job-001",
        deploymentId: 42,
        environmentId: "env-onprem-1",
        localPort: 49_152,
      }),
    ).rejects.toThrow("Tunnel 연결 준비에 실패했습니다.");
    expect(processes.processes[0]?.stopCount).toBe(1);
  });

  it("유효하지 않은 localPort는 서버에 보고하지 않는다", async () => {
    const sessions = createSessionProvider();
    const processes = new FakeProcessRunner();
    const provider = new CloudflaredTunnelProvider({
      sessions,
      processes,
      readiness: new FakeReadinessChecker(),
      allocateMetricsPort: async () => 20_241,
    });

    await expect(
      provider.start({
        jobId: "job-001",
        deploymentId: 42,
        environmentId: "env-onprem-1",
        localPort: 0,
      }),
    ).rejects.toMatchObject({ code: "tunnel_failed" });
    expect(sessions.inputs).toEqual([]);
    expect(processes.requests).toEqual([]);
  });

  it("Token이나 외부 endpoint가 없는 서버 응답을 거부한다", async () => {
    const processes = new FakeProcessRunner();
    const provider = new CloudflaredTunnelProvider({
      sessions: {
        async prepare() {
          return { tunnelId: "tunnel-42", token: "", hostname: "" };
        },
      },
      processes,
      readiness: new FakeReadinessChecker(),
      allocateMetricsPort: async () => 20_241,
    });

    await expect(
      provider.start({
        jobId: "job-001",
        deploymentId: 42,
        environmentId: "env-onprem-1",
        localPort: 49_152,
      }),
    ).rejects.toMatchObject({ code: "tunnel_failed" });
    expect(processes.requests).toEqual([]);
  });

  it("stop은 해당 deployment의 활성 프로세스만 멱등하게 종료한다", async () => {
    const processes = new FakeProcessRunner();
    const provider = new CloudflaredTunnelProvider({
      sessions: createSessionProvider(),
      processes,
      readiness: new FakeReadinessChecker(),
      allocateMetricsPort: async () => 20_241 + processes.processes.length,
    });

    await provider.start({
      jobId: "job-001",
      deploymentId: 42,
      environmentId: "env-onprem-1",
      localPort: 49_152,
    });
    await provider.start({
      jobId: "job-002",
      deploymentId: 43,
      environmentId: "env-onprem-1",
      localPort: 49_153,
    });

    await provider.stop(42);
    await provider.stop(42);

    expect(processes.processes[0]?.stopCount).toBe(1);
    expect(processes.processes[1]?.stopCount).toBe(0);
  });
});

describe("LocalTunnelReadinessChecker", () => {
  it("metrics 요청이 멈추면 timeout 후 실패한다", async () => {
    const fetcher: typeof fetch = async (_input, init) => {
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      });
    };
    const checker = new LocalTunnelReadinessChecker({
      attempts: 1,
      intervalMs: 1,
      requestTimeoutMs: 5,
      fetcher,
    });

    await expect(
      checker.waitUntilReady(
        "http://127.0.0.1:20241/ready",
        new FakeProcess(),
      ),
    ).rejects.toMatchObject({ code: "tunnel_failed" });
  });
});
