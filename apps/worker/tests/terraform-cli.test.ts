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
});
