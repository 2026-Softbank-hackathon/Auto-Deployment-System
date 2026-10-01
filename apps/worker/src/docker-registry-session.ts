import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EcrAuthorization } from "@camellia/aws-registry";

export type DockerRegistryCommand = {
  args: string[];
  input?: string;
  environment: NodeJS.ProcessEnv;
};

export interface DockerRegistryCommandRunner {
  run(command: DockerRegistryCommand): Promise<void>;
}

export interface RegistrySession {
  withAuthorization<T>(
    authorization: EcrAuthorization,
    task: (commandEnvironment: NodeJS.ProcessEnv) => Promise<T>,
  ): Promise<T>;
}

export class DockerRegistrySession implements RegistrySession {
  constructor(
    private readonly runner: DockerRegistryCommandRunner =
      new NodeDockerRegistryCommandRunner(),
    private readonly temporaryRoot = os.tmpdir(),
    private readonly baseDockerConfigPath = path.join(
      process.env["DOCKER_CONFIG"] ?? path.join(os.homedir(), ".docker"),
      "config.json",
    ),
  ) {}

  async withAuthorization<T>(
    authorization: EcrAuthorization,
    task: (commandEnvironment: NodeJS.ProcessEnv) => Promise<T>,
  ): Promise<T> {
    const dockerConfigPath = await fs.mkdtemp(
      path.join(this.temporaryRoot, "camellia-docker-auth-"),
    );
    const { dockerHost } = await copyDockerRuntimeConfig(
      this.baseDockerConfigPath,
      path.join(dockerConfigPath, "config.json"),
    );
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      DOCKER_CONFIG: dockerConfigPath,
    };
    if (dockerHost && !environment["DOCKER_HOST"]) {
      environment["DOCKER_HOST"] = dockerHost;
    }
    let loggedIn = false;

    try {
      await this.runner.run({
        args: [
          "login",
          "--username",
          authorization.username,
          "--password-stdin",
          authorization.registryUri,
        ],
        input: authorization.password,
        environment,
      });
      loggedIn = true;
      return await task(environment);
    } finally {
      if (loggedIn) {
        await this.runner
          .run({
            args: ["logout", authorization.registryUri],
            environment,
          })
          .catch(() => {});
      }
      await fs.rm(dockerConfigPath, { recursive: true, force: true });
    }
  }
}

async function copyDockerRuntimeConfig(
  sourcePath: string,
  targetPath: string,
): Promise<{ dockerHost?: string }> {
  const source = await fs.readFile(sourcePath, "utf8").catch(() => null);
  if (source === null) return {};

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(source) as Record<string, unknown>;
  } catch {
    return {};
  }

  const declaredExtraDirs = Array.isArray(parsed["cliPluginsExtraDirs"])
    ? parsed["cliPluginsExtraDirs"].filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  // Docker Desktop plugins (buildx 등) live as symlinks in the *original*
  // config dir's own cli-plugins/ folder, not in cliPluginsExtraDirs. Since
  // the isolated DOCKER_CONFIG points elsewhere, that default lookup path
  // is lost — so we re-add it explicitly, in addition to any declared
  // extra dirs, instead of relying on whatever the source config happened
  // to list.
  const baseCliPluginsDir = path.join(path.dirname(sourcePath), "cli-plugins");
  const cliPluginsExtraDirs = Array.from(
    new Set([...declaredExtraDirs, baseCliPluginsDir]),
  );

  const runtimeConfig = { cliPluginsExtraDirs };
  await fs.writeFile(targetPath, JSON.stringify(runtimeConfig));

  // currentContext는 isolated config에 그대로 복사하지 않는다: 컨텍스트의
  // 실제 엔드포인트 메타데이터(contexts/meta/<hash>/meta.json)가 없으면
  // Docker CLI가 "context not found"로 즉시 실패한다. 대신 메타데이터를
  // 직접 읽어 엔드포인트를 DOCKER_HOST로 변환한다. 해석할 수 없으면(예:
  // currentContext 미설정, 메타데이터 없음, TLS 필요) 조용히 건너뛰고
  // Docker CLI 기본 엔드포인트(DOCKER_HOST 또는 기본 소켓)에 맡긴다.
  const currentContext =
    typeof parsed["currentContext"] === "string"
      ? parsed["currentContext"]
      : undefined;
  if (!currentContext) return {};

  const dockerHost = await resolveContextDockerHost(
    path.dirname(sourcePath),
    currentContext,
  );
  return dockerHost ? { dockerHost } : {};
}

async function resolveContextDockerHost(
  dockerConfigDir: string,
  contextName: string,
): Promise<string | undefined> {
  const metaRoot = path.join(dockerConfigDir, "contexts", "meta");
  const entries = await fs.readdir(metaRoot).catch(() => []);

  for (const entry of entries) {
    const metaPath = path.join(metaRoot, entry, "meta.json");
    const raw = await fs.readFile(metaPath, "utf8").catch(() => null);
    if (raw === null) continue;

    try {
      const meta = JSON.parse(raw) as {
        Name?: string;
        Endpoints?: { docker?: { Host?: string } };
      };
      if (meta.Name !== contextName) continue;
      const host = meta.Endpoints?.docker?.Host;
      return typeof host === "string" ? host : undefined;
    } catch {
      continue;
    }
  }
  return undefined;
}

export class NodeDockerRegistryCommandRunner
  implements DockerRegistryCommandRunner
{
  async run(command: DockerRegistryCommand): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("docker", command.args, {
        env: command.environment,
        shell: false,
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.once("error", () => reject(new Error("DOCKER_AUTH_UNAVAILABLE")));
      child.once("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error("DOCKER_AUTH_FAILED"));
      });
      child.stdin.on("error", () => {});
      child.stdin.end(command.input ?? "");
    });
  }
}
