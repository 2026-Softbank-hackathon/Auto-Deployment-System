import { createServer } from "node:net";
import type {
  BackgroundProcess,
  BackgroundProcessRunner,
  TunnelProvider,
  TunnelReadinessChecker,
  TunnelResult,
  TunnelSession,
  TunnelSessionProvider,
  TunnelStartInput,
} from "./contracts.js";
import { AgentError, throwIfAborted } from "./errors.js";

type CloudflaredTunnelProviderOptions = {
  sessions: TunnelSessionProvider;
  processes: BackgroundProcessRunner;
  readiness?: TunnelReadinessChecker;
  allocateMetricsPort?: () => Promise<number>;
  environment?: NodeJS.ProcessEnv;
};

type LocalTunnelReadinessCheckerOptions = {
  attempts?: number;
  intervalMs?: number;
  requestTimeoutMs?: number;
  fetcher?: typeof fetch;
};

type ActiveTunnel = {
  process: BackgroundProcess;
  result: TunnelResult;
};

const CLOUDFLARED_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // Windows: SystemRoot가 없으면 Go로 만든 cloudflared가 네트워크를 쓰지 못한다
  "SystemRoot",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "TEMP",
  "TMP",
] as const;

function createCloudflaredEnvironment(
  environment: NodeJS.ProcessEnv,
  token: string,
): NodeJS.ProcessEnv {
  const childEnvironment: NodeJS.ProcessEnv = { TUNNEL_TOKEN: token };
  for (const key of CLOUDFLARED_ENV_KEYS) {
    const value = environment[key];
    if (value !== undefined) childEnvironment[key] = value;
  }
  return childEnvironment;
}

function validateSession(session: TunnelSession): void {
  if (!session.tunnelId.trim() || !session.token.trim()) {
    throw new AgentError(
      "tunnel_failed",
      "Tunnel 실행정보가 올바르지 않습니다.",
    );
  }
  if (
    !/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(
      session.hostname,
    )
  ) {
    throw new AgentError(
      "tunnel_failed",
      "Tunnel hostname이 올바르지 않습니다.",
    );
  }
}

function validateStartInput(input: TunnelStartInput): void {
  if (
    !input.jobId.trim() ||
    !input.environmentId.trim() ||
    !Number.isSafeInteger(input.deploymentId) ||
    input.deploymentId < 1 ||
    !Number.isSafeInteger(input.localPort) ||
    input.localPort < 1 ||
    input.localPort > 65_535
  ) {
    throw new AgentError("tunnel_failed", "로컬 포트가 올바르지 않습니다.");
  }
}

export async function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("동적 포트를 할당할 수 없습니다."));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

export class LocalTunnelReadinessChecker implements TunnelReadinessChecker {
  private readonly attempts: number;
  private readonly intervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(options: LocalTunnelReadinessCheckerOptions = {}) {
    this.attempts = options.attempts ?? 20;
    this.intervalMs = options.intervalMs ?? 250;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 1_000;
    this.fetcher = options.fetcher ?? fetch;
  }

  async waitUntilReady(
    url: string,
    process: BackgroundProcess,
    signal?: AbortSignal,
  ): Promise<void> {
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      throwIfAborted(signal);
      if (!process.isRunning()) break;
      const timeout = AbortSignal.timeout(this.requestTimeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const response = await this.fetcher(url, { signal: combined });
        if (response.ok) return;
      } catch (error) {
        if (signal?.aborted) throwIfAborted(signal);
        void error;
      }
      if (attempt < this.attempts) {
        await new Promise((resolve) => setTimeout(resolve, this.intervalMs));
      }
    }
    throw new AgentError(
      "tunnel_failed",
      "Tunnel 연결 준비에 실패했습니다.",
    );
  }
}

export class CloudflaredTunnelProvider implements TunnelProvider {
  private readonly sessions: TunnelSessionProvider;
  private readonly processes: BackgroundProcessRunner;
  private readonly readiness: TunnelReadinessChecker;
  private readonly allocateMetricsPort: () => Promise<number>;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly active = new Map<number, ActiveTunnel>();

  constructor(options: CloudflaredTunnelProviderOptions) {
    this.sessions = options.sessions;
    this.processes = options.processes;
    this.readiness = options.readiness ?? new LocalTunnelReadinessChecker();
    this.allocateMetricsPort =
      options.allocateMetricsPort ?? allocateLoopbackPort;
    this.environment = options.environment ?? process.env;
  }

  async start(
    input: TunnelStartInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<TunnelResult> {
    throwIfAborted(options.signal);
    validateStartInput(input);
    const session = await this.sessions.prepare(input, options);
    validateSession(session);
    throwIfAborted(options.signal);

    const metricsPort = await this.allocateMetricsPort();
    const process = await this.processes.start({
      command: "cloudflared",
      args: [
        "tunnel",
        "--no-autoupdate",
        "--loglevel",
        "info",
        "--metrics",
        `127.0.0.1:${metricsPort}`,
        "run",
      ],
      env: createCloudflaredEnvironment(this.environment, session.token),
    });

    try {
      await this.readiness.waitUntilReady(
        `http://127.0.0.1:${metricsPort}/ready`,
        process,
        options.signal,
      );
      throwIfAborted(options.signal);
    } catch (error) {
      await process.stop().catch(() => undefined);
      if (error instanceof AgentError) throw error;
      throw new AgentError(
        "tunnel_failed",
        "Tunnel 연결 준비에 실패했습니다.",
      );
    }

    const previous = this.active.get(input.deploymentId);
    const result = {
      tunnelId: session.tunnelId,
      endpoint: `https://${session.hostname}`,
    };
    this.active.set(input.deploymentId, { process, result });
    if (previous && previous.process !== process) {
      await previous.process.stop().catch(() => undefined);
    }
    void process.waitForExit().finally(() => {
      if (this.active.get(input.deploymentId)?.process === process) {
        this.active.delete(input.deploymentId);
      }
    });
    return result;
  }

  async stop(deploymentId: number): Promise<void> {
    const active = this.active.get(deploymentId);
    if (!active) return;
    this.active.delete(deploymentId);
    await active.process.stop();
  }

  async isRunning(deploymentId: number): Promise<boolean> {
    return this.active.get(deploymentId)?.process.isRunning() ?? false;
  }
}
