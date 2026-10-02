import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TerraformCli,
  TerraformCliError,
  TerraformProcessError,
  type TerraformCommandExecutor,
} from "../src/terraform-cli.js";
import { renderLogText, type LogText } from "../src/log-messages.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const tempDirectories: string[] = [];

async function createModuleDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "camellia-tf-test-module-"));
  tempDirectories.push(directory);
  await fs.writeFile(path.join(directory, "main.tf"), "terraform {}\n");
  await fs.mkdir(path.join(directory, ".terraform"), { recursive: true });
  await fs.writeFile(path.join(directory, ".terraform", "stale-state"), "ignore");
  return directory;
}

function makeRequest(moduleDirectory: string) {
  return {
    moduleDirectory,
    backend: {
      bucket: "camellia-terraform-state",
      region: "ap-northeast-2",
      kmsKeyId: "arn:aws:kms:ap-northeast-2:123456789012:key/example",
      stateKey: "projects/12/environments/34/terraform.tfstate",
    },
    region: "ap-northeast-2",
    credentials: {
      accessKeyId: "user-access-key",
      secretAccessKey: "user-secret-key",
    },
    variables: {
      app_name: "demo-web",
      container_image: `repo/demo@${DIGEST}`,
      container_port: 3000,
    },
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("TerraformCli", () => {
  it("init/validate/plan/apply 순서로 실행하고 출력값을 수집한다", async () => {
    vi.stubEnv("TF_LOG", "TRACE");
    vi.stubEnv("TF_CLI_ARGS", "-no-color");
    vi.stubEnv("AWS_SESSION_TOKEN", "ambient-session-token");
    const moduleDirectory = await createModuleDirectory();
    const commands: Array<{ args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
    let variablesFile = "";
    const execute: TerraformCommandExecutor = vi.fn(async ({ args, cwd, env }) => {
      commands.push({ args, cwd, env });
      if (args[0] === "init") {
        await expect(
          fs.access(path.join(cwd, ".terraform", "stale-state")),
        ).rejects.toThrow();
      }
      if (args[0] === "plan") {
        variablesFile = await fs.readFile(
          path.join(cwd, "terraform.tfvars.json"),
          "utf8",
        );
      }
      if (args[0] === "output") {
        return JSON.stringify({
          origin_url: { value: "http://origin.example.test", type: "string" },
        });
      }
      return "";
    });

    const outputs = await new TerraformCli({ execute }).apply(
      makeRequest(moduleDirectory),
    );

    expect(commands.map((command) => command.args[0])).toEqual([
      "init",
      "validate",
      "plan",
      "apply",
      "output",
    ]);
    expect(commands[0]?.args).toContain(
      "-backend-config=use_lockfile=true",
    );
    expect(commands[0]?.args).toContain(
      "-backend-config=kms_key_id=arn:aws:kms:ap-northeast-2:123456789012:key/example",
    );
    expect(commands[2]?.args.at(-1)).toBeDefined();
    expect(commands[3]?.args.at(-1)).toMatch(/[\\/]tfplan$/);
    expect(commands[0]?.env["AWS_ACCESS_KEY_ID"]).toBe("user-access-key");
    expect(commands[0]?.env["AWS_SECRET_ACCESS_KEY"]).toBe("user-secret-key");
    expect(commands[0]?.env["AWS_SESSION_TOKEN"]).toBeUndefined();
    expect(commands[0]?.env["TF_LOG"]).toBeUndefined();
    expect(commands[0]?.env["TF_CLI_ARGS"]).toBeUndefined();
    expect(commands.flatMap((command) => command.args).join(" ")).not.toContain(
      "user-secret-key",
    );
    expect(variablesFile).toContain(`repo/demo@${DIGEST}`);
    expect(variablesFile).not.toContain("user-secret-key");
    expect(outputs.origin_url?.value).toBe("http://origin.example.test");
    await expect(fs.access(commands[0]!.cwd)).rejects.toThrow();
  });

  it("기존 state의 출력값만 읽을 때 plan과 apply를 다시 실행하지 않는다", async () => {
    const moduleDirectory = await createModuleDirectory();
    const commands: string[][] = [];
    const execute: TerraformCommandExecutor = vi.fn(async ({ args }) => {
      commands.push(args);
      return args[0] === "output"
        ? JSON.stringify({
            task_definition_arn: {
              value: "arn:aws:ecs:ap-northeast-2:123456789012:task-definition/cam-demo:8",
              type: "string",
            },
          })
        : "";
    });

    const outputs = await new TerraformCli({ execute }).output(
      makeRequest(moduleDirectory),
    );

    expect(commands.map((args) => args[0])).toEqual(["init", "output"]);
    expect(outputs.task_definition_arn?.value).toContain("task-definition/cam-demo:8");
  });

  it("Terraform 오류 상세를 숨기고 단계 오류 코드만 반환하며 임시 파일을 제거한다", async () => {
    const moduleDirectory = await createModuleDirectory();
    let workspace = "";
    const execute: TerraformCommandExecutor = vi.fn(async ({ args, cwd }) => {
      workspace = cwd;
      if (args[0] === "plan") throw new Error("sensitive provider output");
      return "";
    });

    await expect(
      new TerraformCli({ execute }).apply(makeRequest(moduleDirectory)),
    ).rejects.toMatchObject({
      name: "TerraformCliError",
      message: "TERRAFORM_PLAN_FAILED",
    });
    await expect(fs.access(workspace)).rejects.toThrow();
  });

  it("executor가 TerraformProcessError를 던지면 stderr를 TerraformCliError.detail로 전파한다", async () => {
    const moduleDirectory = await createModuleDirectory();
    const stderrText = "Error: failed to query available provider packages\nsome AWS error detail";
    const execute: TerraformCommandExecutor = vi.fn(async ({ args }) => {
      if (args[0] === "init") {
        throw new TerraformProcessError("terraform exited with code 1", stderrText);
      }
      return "";
    });

    const error = await new TerraformCli({ execute })
      .apply(makeRequest(moduleDirectory))
      .catch((e: unknown) => e);

    expect(error).toMatchObject({
      name: "TerraformCliError",
      code: "TERRAFORM_INIT_FAILED",
      detail: stderrText,
    });
    expect((error as { message: string }).message).toContain("TERRAFORM_INIT_FAILED");
    expect((error as { message: string }).message).toContain(stderrText);
  });

  function lockError(created: string): TerraformProcessError {
    return new TerraformProcessError(
      "terraform exited with code 1",
      [
        "Error: Error acquiring the state lock",
        "",
        "Error message: operation error S3: PutObject, https response error StatusCode: 412, PreconditionFailed",
        "Lock Info:",
        "  ID:        8f0c2a51-6d2e-4f7a-9c1b-2b8d3e4f5a6b",
        "  Path:      camellia-terraform-state/projects/12/environments/34/terraform.tfstate",
        "  Operation: OperationTypeApply",
        "  Who:       node@0a1b2c3d4e5f",
        "  Version:   1.16.4",
        `  Created:   ${created}`,
        "  Info:      ",
        "",
        "Terraform acquires a state lock to protect the state from being written",
        "by multiple users at the same time.",
      ].join("\n"),
    );
  }

  it("plan · apply 는 state 락을 잠시 기다린다", async () => {
    const moduleDirectory = await createModuleDirectory();
    const commands: string[][] = [];
    const execute: TerraformCommandExecutor = vi.fn(async ({ args }) => {
      commands.push(args);
      return args[0] === "output" ? "{}" : "";
    });

    await new TerraformCli({ execute }).apply(makeRequest(moduleDirectory));

    expect(commands.find((args) => args[0] === "plan")).toContain("-lock-timeout=1m");
    expect(commands.find((args) => args[0] === "apply")).toContain("-lock-timeout=1m");
  });

  it("워커 프로세스 시작 전에 만들어진 state 락(죽은 이전 워커의 것)은 해제하고 plan 을 다시 한다", async () => {
    const moduleDirectory = await createModuleDirectory();
    const commands: string[][] = [];
    let plans = 0;
    const execute: TerraformCommandExecutor = vi.fn(async ({ args }) => {
      commands.push(args);
      if (args[0] === "plan" && plans++ === 0) {
        throw lockError("2026-10-02 05:20:11.123456789 +0000 UTC");
      }
      return args[0] === "output" ? "{}" : "";
    });
    const log = vi.fn(async (_line: LogText) => undefined);

    await new TerraformCli({
      execute,
      staleLockBefore: new Date("2026-10-02T05:30:00Z"),
    }).apply({ ...makeRequest(moduleDirectory), log });

    expect(commands.map((args) => args[0])).toEqual([
      "init", "validate", "plan", "force-unlock", "plan", "apply", "output",
    ]);
    expect(commands[3]).toEqual(["force-unlock", "-force", "8f0c2a51-6d2e-4f7a-9c1b-2b8d3e4f5a6b"]);
    expect(log.mock.calls.map(([line]) => renderLogText(line))).toContainEqual(
      expect.stringContaining("8f0c2a51-6d2e-4f7a-9c1b-2b8d3e4f5a6b"),
    );
  });

  it("워커 프로세스 시작 뒤에 만들어진 state 락은 해제하지 않고 plan 실패로 끝낸다", async () => {
    const moduleDirectory = await createModuleDirectory();
    const commands: string[][] = [];
    const execute: TerraformCommandExecutor = vi.fn(async ({ args }) => {
      commands.push(args);
      if (args[0] === "plan") throw lockError("2026-10-02 05:31:00.5 +0000 UTC");
      return "";
    });

    await expect(
      new TerraformCli({
        execute,
        staleLockBefore: new Date("2026-10-02T05:30:00Z"),
      }).apply(makeRequest(moduleDirectory)),
    ).rejects.toMatchObject({ code: "TERRAFORM_PLAN_FAILED" });
    expect(commands.map((args) => args[0])).not.toContain("force-unlock");
  });

  it("절대 경로 밖 state key를 거부한다", async () => {
    const moduleDirectory = await createModuleDirectory();
    const execute = vi.fn();

    await expect(
      new TerraformCli({ execute }).apply({
        ...makeRequest(moduleDirectory),
        backend: {
          ...makeRequest(moduleDirectory).backend,
          stateKey: "projects/../other.tfstate",
        },
      }),
    ).rejects.toBeInstanceOf(TerraformCliError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("destroy (#247) — 같은 backend 로 init 한 뒤 destroy -auto-approve 를 state 락 대기와 함께 실행하고 임시 폴더를 지운다", async () => {
    const moduleDirectory = await createModuleDirectory();
    const commands: Array<{ args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
    let variablesFile = "";
    const execute: TerraformCommandExecutor = vi.fn(async ({ args, cwd, env }) => {
      commands.push({ args, cwd, env });
      if (args[0] === "destroy") {
        variablesFile = await fs.readFile(path.join(cwd, "terraform.tfvars.json"), "utf8");
      }
      return "";
    });

    await new TerraformCli({ execute }).destroy(makeRequest(moduleDirectory));

    expect(commands.map((c) => c.args[0])).toEqual(["init", "destroy"]);
    expect(commands[0]!.args).toContain("-backend-config=key=projects/12/environments/34/terraform.tfstate");
    expect(commands[0]!.args).toContain("-backend-config=use_lockfile=true");
    expect(commands[1]!.args).toEqual([
      "destroy",
      "-auto-approve",
      "-input=false",
      "-no-color",
      "-lock-timeout=1m",
      "-var-file=terraform.tfvars.json",
    ]);
    expect(commands[1]!.env["AWS_ACCESS_KEY_ID"]).toBe("user-access-key");
    expect(JSON.parse(variablesFile)).toMatchObject({ app_name: "demo-web" });
    await expect(fs.access(commands[0]!.cwd)).rejects.toThrow();
  });

  it("destroy 실패는 TERRAFORM_DESTROY_FAILED 와 stderr 상세로 알린다", async () => {
    const moduleDirectory = await createModuleDirectory();
    const execute: TerraformCommandExecutor = vi.fn(async ({ args }) => {
      if (args[0] === "destroy") {
        throw new TerraformProcessError("terraform exited with code 1", "Error: DependencyViolation");
      }
      return "";
    });

    await expect(
      new TerraformCli({ execute }).destroy(makeRequest(moduleDirectory)),
    ).rejects.toMatchObject({ code: "TERRAFORM_DESTROY_FAILED", detail: "Error: DependencyViolation" });
  });

  it("provider 캐시 (#252) — 캐시 경로를 TF_PLUGIN_CACHE_DIR 로 넘기고 lock 파일이 있으면 init 을 -lockfile=readonly 로 한다", async () => {
    vi.stubEnv("TF_PLUGIN_CACHE_DIR", "/ambient/cache");
    const moduleDirectory = await createModuleDirectory();
    await fs.writeFile(path.join(moduleDirectory, ".terraform.lock.hcl"), "# lock\n");
    const commands: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const execute: TerraformCommandExecutor = vi.fn(async ({ args, env }) => {
      commands.push({ args, env });
      return args[0] === "output" ? "{}" : "";
    });

    await new TerraformCli({ execute, pluginCacheDir: "/opt/terraform/plugin-cache" })
      .apply(makeRequest(moduleDirectory));

    const init = commands.find((command) => command.args[0] === "init")!;
    expect(init.args).toContain("-lockfile=readonly");
    for (const command of commands) {
      expect(command.env["TF_PLUGIN_CACHE_DIR"]).toBe("/opt/terraform/plugin-cache");
    }
  });

  it("lock 파일이 없는 모듈은 readonly 없이 init 하고, 캐시 경로가 없으면 워커 환경의 TF_PLUGIN_CACHE_DIR 도 넘기지 않는다", async () => {
    vi.stubEnv("TF_PLUGIN_CACHE_DIR", "/ambient/cache");
    const moduleDirectory = await createModuleDirectory();
    const commands: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const execute: TerraformCommandExecutor = vi.fn(async ({ args, env }) => {
      commands.push({ args, env });
      return args[0] === "output" ? "{}" : "";
    });

    await new TerraformCli({ execute }).apply(makeRequest(moduleDirectory));

    expect(commands[0]!.args).not.toContain("-lockfile=readonly");
    expect(commands[0]!.env["TF_PLUGIN_CACHE_DIR"]).toBeUndefined();
  });

  it("refresh: false (이미지만 바뀐 재배포) 면 plan 없이 apply -refresh=false -auto-approve 한 번으로 끝내고, 기본은 전체 재조회 plan → apply 다 (#252, #260)", async () => {
    const moduleDirectory = await createModuleDirectory();
    const runs: string[][][] = [[], []];
    let run = 0;
    let variablesAtApply = "";
    const execute: TerraformCommandExecutor = vi.fn(async ({ args, cwd }) => {
      runs[run]!.push(args);
      if (run === 0 && args[0] === "apply") {
        variablesAtApply = await fs.readFile(path.join(cwd, "terraform.tfvars.json"), "utf8");
      }
      return args[0] === "output" ? "{}" : "";
    });
    const log = vi.fn(async (_line: LogText) => undefined);
    const cli = new TerraformCli({ execute });

    await cli.apply({ ...makeRequest(moduleDirectory), refresh: false, log });
    run = 1;
    await cli.apply(makeRequest(moduleDirectory));

    expect(runs[0]!.map((args) => args[0])).toEqual(["init", "validate", "apply", "output"]);
    expect(runs[0]![2]).toEqual([
      "apply",
      "-input=false",
      "-no-color",
      "-lock-timeout=1m",
      "-refresh=false",
      "-auto-approve",
      "-var-file=terraform.tfvars.json",
    ]);
    expect(variablesAtApply).toContain(`repo/demo@${DIGEST}`);
    expect(log.mock.calls.map(([line]) => renderLogText(line))).toContain("plan·apply 한 번에 (이미지만 바뀐 재배포, -refresh=false)");
    expect(runs[1]!.map((args) => args[0])).toEqual(["init", "validate", "plan", "apply", "output"]);
    expect(runs[1]![2]).not.toContain("-refresh=false");
  });

  it("plan·apply 한 번에 실행할 때도 워커 시작 전에 남은 state 락은 해제하고 다시 한다", async () => {
    const moduleDirectory = await createModuleDirectory();
    const commands: string[][] = [];
    let applies = 0;
    const execute: TerraformCommandExecutor = vi.fn(async ({ args }) => {
      commands.push(args);
      if (args[0] === "apply" && applies++ === 0) {
        throw lockError("2026-10-02 05:20:11.123456789 +0000 UTC");
      }
      return args[0] === "output" ? "{}" : "";
    });

    await new TerraformCli({
      execute,
      staleLockBefore: new Date("2026-10-02T05:30:00Z"),
    }).apply({ ...makeRequest(moduleDirectory), refresh: false });

    expect(commands.map((args) => args[0])).toEqual([
      "init", "validate", "apply", "force-unlock", "apply", "output",
    ]);
  });

  it("init · plan · apply 소요 시간을 진행 로그에 남긴다 (#252)", async () => {
    const moduleDirectory = await createModuleDirectory();
    let clock = 0;
    const execute: TerraformCommandExecutor = vi.fn(async ({ args }) => {
      clock += { init: 2_400, validate: 300, plan: 7_060, apply: 31_000, output: 100 }[args[0]!] ?? 0;
      return args[0] === "output" ? "{}" : "";
    });
    const log = vi.fn(async (_line: LogText) => undefined);

    await new TerraformCli({ execute, now: () => clock })
      .apply({ ...makeRequest(moduleDirectory), log });

    const lines = log.mock.calls.map(([line]) => renderLogText(line));
    expect(lines).toEqual(expect.arrayContaining([
      "terraform init 완료 (2.4초)",
      "terraform plan 완료 (7.1초)",
      "terraform apply 완료 (31.0초)",
    ]));
  });

  it("입력 지문 (#252) — 모듈 파일 · 변수 · region · access key 가 같으면 같고 하나라도 바뀌면 달라진다", async () => {
    const moduleDirectory = await createModuleDirectory();
    const cli = new TerraformCli({ execute: vi.fn() });
    const base = {
      moduleDirectory,
      region: "ap-northeast-2",
      credentials: { accessKeyId: "AKIA1", secretAccessKey: "secret-1" },
      variables: { app_name: "demo-web", container_port: 3000, environment_variables: { A: "1", B: "2" } },
    };

    const first = await cli.fingerprint(base);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    // 키 순서 · secret key 회전 · .terraform 폴더는 영향 없음
    expect(await cli.fingerprint({
      ...base,
      credentials: { accessKeyId: "AKIA1", secretAccessKey: "secret-2" },
      variables: { environment_variables: { B: "2", A: "1" }, container_port: 3000, app_name: "demo-web" },
    })).toBe(first);
    await fs.writeFile(path.join(moduleDirectory, ".terraform", "provider-cache"), "x");
    expect(await cli.fingerprint(base)).toBe(first);

    expect(await cli.fingerprint({ ...base, variables: { ...base.variables, container_port: 8080 } })).not.toBe(first);
    expect(await cli.fingerprint({ ...base, region: "us-east-1" })).not.toBe(first);
    expect(await cli.fingerprint({ ...base, credentials: { accessKeyId: "AKIA2", secretAccessKey: "secret-1" } })).not.toBe(first);
    await fs.writeFile(path.join(moduleDirectory, "main.tf"), "terraform {}\n# changed\n");
    expect(await cli.fingerprint(base)).not.toBe(first);
  });

  it("destroy 도 워커 시작 전에 남은 state 락은 해제하고 다시 한다", async () => {
    const moduleDirectory = await createModuleDirectory();
    const commands: string[][] = [];
    let destroys = 0;
    const execute: TerraformCommandExecutor = vi.fn(async ({ args }) => {
      commands.push(args);
      if (args[0] === "destroy" && destroys++ === 0) {
        throw lockError("2026-10-02 05:20:11.123456789 +0000 UTC");
      }
      return "";
    });

    await new TerraformCli({
      execute,
      staleLockBefore: new Date("2026-10-02T05:30:00Z"),
    }).destroy(makeRequest(moduleDirectory));

    expect(commands.map((args) => args[0])).toEqual(["init", "destroy", "force-unlock", "destroy"]);
  });
});

describe("TerraformCli 작업 폴더 재사용 (#260)", () => {
  type Command = { args: string[]; cwd: string };

  async function createWorkRoot(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "camellia-tf-test-work-"));
    tempDirectories.push(directory);
    return directory;
  }

  /** init 은 실제 terraform 처럼 .terraform/terraform.tfstate(backend 설정)를 만든다 */
  function fakeTerraform(
    hooks: { onCommand?: (command: Command, index: number) => Promise<void> | void } = {},
  ) {
    const commands: Command[] = [];
    const execute: TerraformCommandExecutor = vi.fn(async ({ args, cwd }) => {
      const command = { args, cwd };
      commands.push(command);
      await hooks.onCommand?.(command, commands.length - 1);
      if (args[0] === "init") {
        await fs.mkdir(path.join(cwd, ".terraform", "providers"), { recursive: true });
        await fs.writeFile(path.join(cwd, ".terraform", "terraform.tfstate"), "{\"backend\":{}}");
      }
      return args[0] === "output" ? "{}" : "";
    });
    const names = (from = 0) => commands.slice(from).map((command) => command.args[0]);
    return { commands, execute, names };
  }

  function logger() {
    const log = vi.fn(async (_line: LogText) => undefined);
    return { log, lines: () => log.mock.calls.map(([line]) => renderLogText(line)) };
  }

  const WORK_DIR_NAME = "projects%2F12%2Fenvironments%2F34%2Fterraform.tfstate";

  it("같은 프로젝트 · 환경의 두 번째 실행은 같은 폴더를 다시 쓰고 init · validate 를 건너뛴다", async () => {
    const moduleDirectory = await createModuleDirectory();
    const workDirRoot = await createWorkRoot();
    const terraform = fakeTerraform();
    const cli = new TerraformCli({ execute: terraform.execute, workDirRoot });
    const { log, lines } = logger();

    await cli.apply({ ...makeRequest(moduleDirectory), log });
    await cli.apply({ ...makeRequest(moduleDirectory), log });

    expect(terraform.names()).toEqual([
      "init", "validate", "plan", "apply", "output",
      "plan", "apply", "output",
    ]);
    const workDir = path.join(workDirRoot, WORK_DIR_NAME);
    for (const command of terraform.commands) expect(command.cwd).toBe(workDir);
    expect(lines()).toEqual(expect.arrayContaining([
      "작업 폴더 init (첫 실행)",
      "작업 폴더 재사용, init 생략",
      "validate 생략 (profile 파일이 직전 성공 때와 같음)",
    ]));
    // 실행이 끝나면 .terraform 만 남는다 — 변수 파일 · plan 파일은 지운다
    expect(await fs.readdir(workDir)).toEqual([".terraform"]);
  });

  it("변수 파일은 실행 때마다 새로 쓰고 실패해도 지우며, 이전 실행의 파일이 남지 않는다", async () => {
    const moduleDirectory = await createModuleDirectory();
    await fs.writeFile(path.join(moduleDirectory, "extra.tf"), "# extra\n");
    const workDirRoot = await createWorkRoot();
    const workDir = path.join(workDirRoot, WORK_DIR_NAME);
    const seen: Array<{ files: string[]; variables: string }> = [];
    let failPlan = true;
    const terraform = fakeTerraform({
      onCommand: async ({ args, cwd }) => {
        if (args[0] !== "plan") return;
        seen.push({
          files: (await fs.readdir(cwd)).sort(),
          variables: await fs.readFile(path.join(cwd, "terraform.tfvars.json"), "utf8"),
        });
        if (failPlan) {
          await fs.writeFile(path.join(cwd, "errored.tfstate"), "secret state");
          throw new Error("plan failed");
        }
      },
    });
    const cli = new TerraformCli({ execute: terraform.execute, workDirRoot });

    await expect(cli.apply(makeRequest(moduleDirectory))).rejects.toMatchObject({
      code: "TERRAFORM_PLAN_FAILED",
    });
    expect(await fs.readdir(workDir)).toEqual([".terraform"]);

    failPlan = false;
    await fs.rm(path.join(moduleDirectory, "extra.tf"));
    const request = makeRequest(moduleDirectory);
    await cli.apply({ ...request, variables: { ...request.variables, container_image: "repo/demo:v2" } });

    expect(seen[0]!.files).toEqual([".terraform", "extra.tf", "main.tf", "terraform.tfvars.json"]);
    expect(seen[1]!.files).toEqual([".terraform", "main.tf", "terraform.tfvars.json"]);
    expect(seen[1]!.variables).toContain("repo/demo:v2");
    expect(seen[1]!.variables).not.toContain(DIGEST);
    expect(await fs.readdir(workDir)).toEqual([".terraform"]);
  });

  it("profile 파일(lock 파일 포함)이 바뀌면 .terraform 을 지우고 init · validate 를 다시 한다", async () => {
    const moduleDirectory = await createModuleDirectory();
    await fs.writeFile(path.join(moduleDirectory, ".terraform.lock.hcl"), "# lock v1\n");
    const workDirRoot = await createWorkRoot();
    const workDir = path.join(workDirRoot, WORK_DIR_NAME);
    let leftoverAtInit: boolean | undefined;
    const terraform = fakeTerraform({
      onCommand: async ({ args, cwd }, index) => {
        if (args[0] === "init" && index > 0) {
          leftoverAtInit = await fs.access(path.join(cwd, ".terraform", "old-module")).then(() => true, () => false);
        }
      },
    });
    const cli = new TerraformCli({ execute: terraform.execute, workDirRoot });
    const { log, lines } = logger();

    await cli.apply(makeRequest(moduleDirectory));
    await fs.writeFile(path.join(workDir, ".terraform", "old-module"), "x");
    await fs.writeFile(path.join(moduleDirectory, ".terraform.lock.hcl"), "# lock v2\n");
    const second = terraform.commands.length;
    await cli.apply({ ...makeRequest(moduleDirectory), log });

    expect(terraform.names(second)).toEqual(["init", "validate", "plan", "apply", "output"]);
    expect(leftoverAtInit).toBe(false);
    expect(lines()).toContain("작업 폴더 init (profile · backend 설정 변경)");
  });

  it.each([
    ["backend bucket", (request: ReturnType<typeof makeRequest>) => ({
      ...request, backend: { ...request.backend, bucket: "other-state-bucket" },
    })],
    ["액세스 키", (request: ReturnType<typeof makeRequest>) => ({
      ...request, credentials: { ...request.credentials, accessKeyId: "rotated-access-key" },
    })],
  ])("%s 가 바뀌면 init 을 다시 하고, profile 파일이 같으면 validate 는 건너뛴다", async (_case, change) => {
    const moduleDirectory = await createModuleDirectory();
    const workDirRoot = await createWorkRoot();
    const terraform = fakeTerraform();
    const cli = new TerraformCli({ execute: terraform.execute, workDirRoot });

    await cli.apply(makeRequest(moduleDirectory));
    const second = terraform.commands.length;
    await cli.apply(change(makeRequest(moduleDirectory)));

    expect(terraform.names(second)).toEqual(["init", "plan", "apply", "output"]);
  });

  it("validate 가 실패하면 다음 실행은 init 은 건너뛰어도 validate 는 다시 한다", async () => {
    const moduleDirectory = await createModuleDirectory();
    const workDirRoot = await createWorkRoot();
    let failValidate = true;
    const terraform = fakeTerraform({
      onCommand: ({ args }) => {
        if (args[0] === "validate" && failValidate) throw new Error("invalid");
      },
    });
    const cli = new TerraformCli({ execute: terraform.execute, workDirRoot });

    await expect(cli.apply(makeRequest(moduleDirectory))).rejects.toMatchObject({
      code: "TERRAFORM_VALIDATE_FAILED",
    });
    failValidate = false;
    const second = terraform.commands.length;
    await cli.apply(makeRequest(moduleDirectory));

    expect(terraform.names(second)).toEqual(["validate", "plan", "apply", "output"]);
  });

  it("init 이 중간에 실패한 폴더(재시도 · 워커 재시작)는 다음 실행에서 지우고 처음부터 init 한다", async () => {
    const moduleDirectory = await createModuleDirectory();
    const workDirRoot = await createWorkRoot();
    let failInit = true;
    const terraform = fakeTerraform({
      onCommand: async ({ args, cwd }) => {
        if (args[0] === "init" && failInit) {
          await fs.mkdir(path.join(cwd, ".terraform"), { recursive: true });
          await fs.writeFile(path.join(cwd, ".terraform", "terraform.tfstate"), "{}");
          throw new Error("network");
        }
      },
    });
    const cli = new TerraformCli({ execute: terraform.execute, workDirRoot });

    await expect(cli.apply(makeRequest(moduleDirectory))).rejects.toMatchObject({
      code: "TERRAFORM_INIT_FAILED",
    });
    failInit = false;
    const second = terraform.commands.length;
    await cli.apply(makeRequest(moduleDirectory));

    expect(terraform.names(second)).toEqual(["init", "validate", "plan", "apply", "output"]);
  });

  it("init 기록은 있지만 backend 설정 파일이 없어진 폴더는 손상으로 보고 다시 init 한다", async () => {
    const moduleDirectory = await createModuleDirectory();
    const workDirRoot = await createWorkRoot();
    const terraform = fakeTerraform();
    const cli = new TerraformCli({ execute: terraform.execute, workDirRoot });
    const { log, lines } = logger();

    await cli.apply(makeRequest(moduleDirectory));
    await fs.rm(path.join(workDirRoot, WORK_DIR_NAME, ".terraform", "terraform.tfstate"));
    const second = terraform.commands.length;
    await cli.apply({ ...makeRequest(moduleDirectory), log });

    expect(terraform.names(second)).toEqual(["init", "validate", "plan", "apply", "output"]);
    expect(lines()).toContain("작업 폴더 init (작업 폴더 손상)");
  });

  it("provider 링크가 끊긴 폴더(워커 이미지의 캐시가 바뀜)는 손상으로 보고 다시 init 한다", async () => {
    const moduleDirectory = await createModuleDirectory();
    await fs.writeFile(path.join(moduleDirectory, ".terraform.lock.hcl"), "# lock\n");
    const workDirRoot = await createWorkRoot();
    const cache = await createWorkRoot();
    const terraform = fakeTerraform({
      onCommand: async ({ args, cwd }) => {
        if (args[0] !== "init") return;
        const providerDir = path.join(cwd, ".terraform", "providers", "registry.terraform.io", "hashicorp", "aws");
        await fs.mkdir(providerDir, { recursive: true });
        await fs.mkdir(path.join(cache, "aws"), { recursive: true });
        await fs.symlink(path.join(cache, "aws"), path.join(providerDir, "linux_amd64"), "junction");
      },
    });
    const cli = new TerraformCli({ execute: terraform.execute, workDirRoot });

    await cli.apply(makeRequest(moduleDirectory));
    const reused = terraform.commands.length;
    await cli.apply(makeRequest(moduleDirectory));
    expect(terraform.names(reused)).toEqual(["plan", "apply", "output"]);

    await fs.rm(path.join(cache, "aws"), { recursive: true });
    const broken = terraform.commands.length;
    await cli.apply(makeRequest(moduleDirectory));
    expect(terraform.names(broken)).toEqual(["init", "validate", "plan", "apply", "output"]);
  });

  it("재사용한 폴더에서 Terraform 이 init 을 요구하면 한 번만 다시 init 하고 처음부터 다시 한다", async () => {
    const moduleDirectory = await createModuleDirectory();
    const workDirRoot = await createWorkRoot();
    let plans = 0;
    const terraform = fakeTerraform({
      onCommand: ({ args }) => {
        if (args[0] === "plan" && ++plans === 2) {
          throw new TerraformProcessError(
            "terraform exited with code 1",
            'Error: Backend initialization required, please run "terraform init"',
          );
        }
      },
    });
    const cli = new TerraformCli({ execute: terraform.execute, workDirRoot });
    const { log, lines } = logger();

    await cli.apply(makeRequest(moduleDirectory));
    const second = terraform.commands.length;
    await cli.apply({ ...makeRequest(moduleDirectory), log });

    expect(terraform.names(second)).toEqual(["plan", "init", "validate", "plan", "apply", "output"]);
    expect(lines()).toContain("작업 폴더가 Terraform 과 맞지 않아 다시 init 합니다.");
  });

  it("새로 init 한 폴더의 오류는 다시 시도하지 않는다", async () => {
    const moduleDirectory = await createModuleDirectory();
    const workDirRoot = await createWorkRoot();
    const terraform = fakeTerraform({
      onCommand: ({ args }) => {
        if (args[0] === "plan") {
          throw new TerraformProcessError("terraform exited with code 1", 'please run "terraform init"');
        }
      },
    });

    await expect(
      new TerraformCli({ execute: terraform.execute, workDirRoot }).apply(makeRequest(moduleDirectory)),
    ).rejects.toMatchObject({ code: "TERRAFORM_PLAN_FAILED" });
    expect(terraform.names()).toEqual(["init", "validate", "plan"]);
  });

  it("이미지만 바뀐 재배포는 재사용한 폴더에서 apply 한 번만 실행한다", async () => {
    const moduleDirectory = await createModuleDirectory();
    const workDirRoot = await createWorkRoot();
    const terraform = fakeTerraform();
    const cli = new TerraformCli({ execute: terraform.execute, workDirRoot });

    await cli.apply(makeRequest(moduleDirectory));
    const second = terraform.commands.length;
    await cli.apply({ ...makeRequest(moduleDirectory), refresh: false });

    expect(terraform.names(second)).toEqual(["apply", "output"]);
    expect(terraform.commands[second]!.args).toContain("-refresh=false");
  });

  it("프로젝트 · 환경(state key)마다 다른 폴더를 쓰고, 같은 폴더를 쓰는 중이면 임시 폴더에서 실행한다", async () => {
    const moduleDirectory = await createModuleDirectory();
    const workDirRoot = await createWorkRoot();
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let firstPlan = true;
    const terraform = fakeTerraform({
      onCommand: async ({ args }) => {
        if (args[0] === "plan" && firstPlan) {
          firstPlan = false;
          await blocked;
        }
      },
    });
    const cli = new TerraformCli({ execute: terraform.execute, workDirRoot });
    const { log, lines } = logger();
    const request = makeRequest(moduleDirectory);

    const first = cli.apply(request);
    await vi.waitFor(() => expect(firstPlan).toBe(false));
    await cli.apply({ ...request, log });
    await cli.apply({
      ...request,
      backend: { ...request.backend, stateKey: "projects/12/environments/35/terraform.tfstate" },
    });
    release();
    await first;

    const directories = [...new Set(terraform.commands.map((command) => command.cwd))];
    expect(directories).toHaveLength(3);
    expect(directories).toContain(path.join(workDirRoot, WORK_DIR_NAME));
    expect(directories).toContain(path.join(workDirRoot, "projects%2F12%2Fenvironments%2F35%2Fterraform.tfstate"));
    const temporary = directories.find((directory) => !directory.startsWith(workDirRoot))!;
    expect(path.basename(temporary)).toMatch(/^camellia-terraform-/);
    await expect(fs.access(temporary)).rejects.toThrow();
    expect(lines()).toContain("같은 작업 폴더를 다른 작업이 쓰고 있어 임시 폴더에서 실행합니다.");
  });

  it("destroy 는 임시 폴더에서 실행하고, 성공하면 그 프로젝트 · 환경의 작업 폴더를 지운다", async () => {
    const moduleDirectory = await createModuleDirectory();
    const workDirRoot = await createWorkRoot();
    const terraform = fakeTerraform();
    const cli = new TerraformCli({ execute: terraform.execute, workDirRoot });

    await cli.apply(makeRequest(moduleDirectory));
    await cli.destroy(makeRequest(moduleDirectory));

    const destroy = terraform.commands.find((command) => command.args[0] === "destroy")!;
    expect(destroy.cwd.startsWith(workDirRoot)).toBe(false);
    await expect(fs.access(path.join(workDirRoot, WORK_DIR_NAME))).rejects.toThrow();
  });
});
