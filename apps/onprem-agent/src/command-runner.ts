import { spawn } from "node:child_process";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "./contracts.js";
import { AgentError, throwIfAborted } from "./errors.js";

export class NodeCommandRunner implements CommandRunner {
  async run(request: CommandRequest): Promise<CommandResult> {
    throwIfAborted(request.signal);

    return new Promise((resolve, reject) => {
      const child = spawn(request.command, request.args, {
        cwd: request.cwd,
        env: request.env ?? process.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (
        callback: () => void,
      ): void => {
        if (settled) return;
        settled = true;
        request.signal?.removeEventListener("abort", abort);
        callback();
      };
      const abort = (): void => {
        child.kill("SIGTERM");
        finish(() =>
          reject(new AgentError("cancelled", "작업이 취소되었습니다.")),
        );
      };

      request.signal?.addEventListener("abort", abort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", () => {
        finish(() =>
          reject(
            new AgentError(
              "internal_error",
              "필수 실행 도구를 시작할 수 없습니다.",
            ),
          ),
        );
      });
      child.once("close", (code) => {
        finish(() => {
          if (code !== 0) {
            reject(
              new AgentError(
                "internal_error",
                "외부 명령 실행에 실패했습니다.",
              ),
            );
            return;
          }
          resolve({ stdout, stderr });
        });
      });

      if (request.stdin !== undefined) child.stdin.end(request.stdin);
      else child.stdin.end();
    });
  }
}
