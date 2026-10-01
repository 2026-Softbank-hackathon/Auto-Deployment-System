import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DockerRegistrySession,
  type DockerRegistryCommand,
  type DockerRegistryCommandRunner,
} from "../src/docker-registry-session.js";

const authorization = {
  registryUri: "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com",
  username: "AWS" as const,
  password: "temporary-password",
  expiresAt: "2026-10-01T12:00:00.000Z",
};

describe("DockerRegistrySession", () => {
  let temporaryRoot: string;
  let calls: DockerRegistryCommand[];
  let runner: DockerRegistryCommandRunner;

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "registry-test-"));
    calls = [];
    runner = {
      run: vi.fn(async (command) => {
        calls.push(command);
      }),
    };
  });

  afterEach(async () => {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  it("password-stdin login과 같은 DOCKER_CONFIG로 task/logout을 실행한다", async () => {
    let taskEnvironment: NodeJS.ProcessEnv | undefined;
    await new DockerRegistrySession(runner, temporaryRoot).withAuthorization(
      authorization,
      async (environment) => {
        taskEnvironment = environment;
      },
    );

    expect(calls[0]?.args).toEqual([
      "login",
      "--username",
      "AWS",
      "--password-stdin",
      authorization.registryUri,
    ]);
    expect(calls[0]?.input).toBe(authorization.password);
    expect(calls[1]?.args).toEqual(["logout", authorization.registryUri]);
    expect(calls[0]?.environment).toBe(taskEnvironment);
    await expect(fs.stat(taskEnvironment!.DOCKER_CONFIG!)).rejects.toThrow();
  });

  it("Buildx 탐색 설정만 복사하고 기존 인증 설정은 복사하지 않는다", async () => {
    const baseConfigPath = path.join(temporaryRoot, "base-config.json");
    await fs.writeFile(
      baseConfigPath,
      JSON.stringify({
        auths: { "existing.example.com": { auth: "must-not-copy" } },
        credsStore: "desktop",
        cliPluginsExtraDirs: ["/opt/docker/cli-plugins"],
      }),
    );
    let copiedConfig: unknown;

    await new DockerRegistrySession(
      runner,
      temporaryRoot,
      baseConfigPath,
    ).withAuthorization(authorization, async (environment) => {
      copiedConfig = JSON.parse(
        await fs.readFile(path.join(environment.DOCKER_CONFIG!, "config.json"), "utf8"),
      );
    });

    expect(copiedConfig).toEqual({
      cliPluginsExtraDirs: [
        "/opt/docker/cli-plugins",
        path.join(temporaryRoot, "cli-plugins"),
      ],
    });
  });

  it("currentContext는 isolated config에 복사하지 않고, 메타데이터에서 해석한 엔드포인트만 DOCKER_HOST로 넘긴다", async () => {
    const baseConfigPath = path.join(temporaryRoot, "base-config.json");
    await fs.writeFile(
      baseConfigPath,
      JSON.stringify({ currentContext: "desktop-linux" }),
    );
    const contextDir = path.join(
      temporaryRoot,
      "contexts",
      "meta",
      "some-hash",
    );
    await fs.mkdir(contextDir, { recursive: true });
    await fs.writeFile(
      path.join(contextDir, "meta.json"),
      JSON.stringify({
        Name: "desktop-linux",
        Endpoints: { docker: { Host: "unix:///example/docker.sock" } },
      }),
    );

    let copiedConfig: unknown;
    let taskEnvironment: NodeJS.ProcessEnv | undefined;
    await new DockerRegistrySession(
      runner,
      temporaryRoot,
      baseConfigPath,
    ).withAuthorization(authorization, async (environment) => {
      taskEnvironment = environment;
      copiedConfig = JSON.parse(
        await fs.readFile(path.join(environment.DOCKER_CONFIG!, "config.json"), "utf8"),
      );
    });

    expect(copiedConfig).toEqual({
      cliPluginsExtraDirs: [path.join(temporaryRoot, "cli-plugins")],
    });
    expect(taskEnvironment?.DOCKER_HOST).toBe("unix:///example/docker.sock");
  });

  it("task 실패 시에도 logout하고 임시 credential을 삭제한다", async () => {
    let dockerConfigPath = "";
    await expect(
      new DockerRegistrySession(runner, temporaryRoot).withAuthorization(
        authorization,
        async (environment) => {
          dockerConfigPath = environment.DOCKER_CONFIG!;
          throw new Error("build failed");
        },
      ),
    ).rejects.toThrow("build failed");

    expect(calls[1]?.args[0]).toBe("logout");
    await expect(fs.stat(dockerConfigPath)).rejects.toThrow();
  });

  it("login 실패 시 task/logout 없이 임시 credential을 삭제한다", async () => {
    runner = { run: vi.fn(async () => Promise.reject(new Error("login failed"))) };
    const task = vi.fn();

    await expect(
      new DockerRegistrySession(runner, temporaryRoot).withAuthorization(
        authorization,
        task,
      ),
    ).rejects.toThrow("login failed");

    expect(task).not.toHaveBeenCalled();
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(temporaryRoot)).toEqual([]);
  });
});
