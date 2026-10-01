import { spawn, type ChildProcess } from "node:child_process";
import type {
  BackgroundProcess,
  BackgroundProcessRunner,
  CommandRequest,
} from "./contracts.js";
import { AgentError } from "./errors.js";

type NodeBackgroundProcessRunnerOptions = {
  stopTimeoutMs?: number;
};

class NodeBackgroundProcess implements BackgroundProcess {
  private exited = false;
  private readonly exitPromise: Promise<void>;

  constructor(
    private readonly child: ChildProcess,
    private readonly stopTimeoutMs: number,
  ) {
    this.exitPromise = new Promise((resolve) => {
      child.once("close", () => {
        this.exited = true;
        resolve();
      });
    });
  }

  isRunning(): boolean {
    return !this.exited && this.child.exitCode === null;
  }

  async waitForExit(): Promise<void> {
    await this.exitPromise;
  }

  async stop(): Promise<void> {
    if (!this.isRunning()) {
      await this.exitPromise;
      return;
    }

    this.child.kill("SIGTERM");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), this.stopTimeoutMs);
    });
    const outcome = await Promise.race([
      this.exitPromise.then(() => "exit" as const),
      timedOut,
    ]);
    if (timeout) clearTimeout(timeout);
    if (outcome === "timeout" && this.isRunning()) {
      this.child.kill("SIGKILL");
      await this.exitPromise;
    }
  }
}

export class NodeBackgroundProcessRunner implements BackgroundProcessRunner {
  private readonly stopTimeoutMs: number;

  constructor(options: NodeBackgroundProcessRunnerOptions = {}) {
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
  }

  async start(request: CommandRequest): Promise<BackgroundProcess> {
    return new Promise((resolve, reject) => {
      const child = spawn(request.command, request.args, {
        cwd: request.cwd,
        env: request.env ?? process.env,
        shell: false,
        stdio: "ignore",
      });
      const fail = (): void => {
        reject(
          new AgentError(
            "internal_error",
            "백그라운드 프로세스를 시작할 수 없습니다.",
          ),
        );
      };
      child.once("error", fail);
      child.once("spawn", () => {
        child.removeListener("error", fail);
        child.on("error", () => undefined);
        resolve(new NodeBackgroundProcess(child, this.stopTimeoutMs));
      });
    });
  }
}
