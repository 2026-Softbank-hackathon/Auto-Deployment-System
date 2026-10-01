import { spawn } from "node:child_process";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "./types.js";
import { CommandExecutionError } from "./errors.js";

export class NodeCommandRunner implements CommandRunner {
  async run(request: CommandRequest): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(request.command, request.args, {
        cwd: request.cwd,
        env: request.env ?? process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.once("error", (error: NodeJS.ErrnoException) => {
        reject(
          new CommandExecutionError(
            request.command,
            null,
            error.code === "ENOENT",
          ),
        );
      });
      child.once("close", (code) => {
        if (code !== 0) {
          reject(new CommandExecutionError(request.command, code));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }
}
