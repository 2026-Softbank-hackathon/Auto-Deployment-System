import type { CommandRunner } from "./contracts.js";
import { AgentError } from "./errors.js";

export class DockerPrerequisiteChecker {
  constructor(private readonly runner: CommandRunner) {}

  async assertReady(): Promise<void> {
    try {
      await this.runner.run({
        command: "docker",
        args: ["info", "--format", "{{.ServerVersion}}"],
      });
    } catch {
      throw new AgentError(
        "internal_error",
        "Docker daemon을 사용할 수 없습니다.",
      );
    }

    try {
      await this.runner.run({
        command: "docker",
        args: ["compose", "version", "--short"],
      });
    } catch {
      throw new AgentError(
        "internal_error",
        "Docker Compose v2를 사용할 수 없습니다.",
      );
    }

    try {
      await this.runner.run({
        command: "cloudflared",
        args: ["--version"],
      });
    } catch {
      throw new AgentError(
        "tunnel_not_configured",
        "cloudflared를 사용할 수 없습니다.",
      );
    }
  }
}
