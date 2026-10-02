import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_CAPTURED_OUTPUT = 1024 * 1024;

export type TerraformBackend = {
  bucket: string;
  region: string;
  kmsKeyId: string;
  stateKey: string;
};

export type TerraformBackendConfig = Omit<TerraformBackend, "stateKey">;

export type TerraformVariable =
  | string
  | number
  | boolean
  | TerraformVariable[]
  | { [key: string]: TerraformVariable };

export type TerraformAwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
};

export type TerraformCliRequest = {
  moduleDirectory: string;
  backend: TerraformBackend;
  region: string;
  credentials: TerraformAwsCredentials;
  variables: Record<string, TerraformVariable>;
  /** 사용자에게 보여줄 진행 로그 (예: 남은 state 락 해제) */
  log?: (line: string) => Promise<void>;
};

export type TerraformOutput = {
  value: unknown;
  sensitive?: boolean;
};

export type TerraformOutputs = Record<string, TerraformOutput>;

export type TerraformCommandExecutor = (input: {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}) => Promise<string>;

export class TerraformCliError extends Error {
  constructor(
    readonly code:
      | "TERRAFORM_MODULE_INVALID"
      | "TERRAFORM_BACKEND_INVALID"
      | "TERRAFORM_INPUT_INVALID"
      | "TERRAFORM_BINARY_UNAVAILABLE"
      | "TERRAFORM_INIT_FAILED"
      | "TERRAFORM_VALIDATE_FAILED"
      | "TERRAFORM_PLAN_FAILED"
      | "TERRAFORM_APPLY_FAILED"
      | "TERRAFORM_DESTROY_FAILED"
      | "TERRAFORM_OUTPUT_FAILED"
      | "TERRAFORM_OUTPUT_INVALID",
    readonly detail?: string,
  ) {
    super(detail ? `${code}\n${detail}` : code);
    this.name = "TerraformCliError";
  }
}

export class TerraformProcessError extends Error {
  constructor(
    message: string,
    readonly stderrTail: string,
  ) {
    super(message);
    this.name = "TerraformProcessError";
  }
}

export type TerraformCliOptions = {
  executable?: string;
  tempRoot?: string;
  execute?: TerraformCommandExecutor;
  /**
   * 이 시각보다 먼저 만들어진 state 락은 죽은 프로세스가 남긴 것으로 보고 해제한다.
   * 기본값은 이 워커 프로세스의 시작 시각. 플랫폼은 worker 가 하나뿐이고 compose 는
   * 이전 컨테이너를 멈춘 뒤 새 컨테이너를 띄우므로, 그 전에 잡힌 락의 주인은 살아 있을 수 없다.
   */
  staleLockBefore?: Date;
};

/** state 락이 잡혀 있으면 이만큼 기다린다 (plan · apply · destroy) */
const LOCK_TIMEOUT = "1m";

export class TerraformCli {
  private readonly executable: string;
  private readonly tempRoot: string;
  private readonly execute: TerraformCommandExecutor;
  private readonly staleLockBefore: Date;

  constructor(options: TerraformCliOptions = {}) {
    this.executable = options.executable ?? "terraform";
    this.tempRoot = options.tempRoot ?? os.tmpdir();
    this.execute = options.execute ?? executeTerraformCommand;
    this.staleLockBefore =
      options.staleLockBefore ?? new Date(Date.now() - process.uptime() * 1000);
  }

  async apply(request: TerraformCliRequest): Promise<TerraformOutputs> {
    return this.inWorkspace(request, async (workspace, env) => {
      await this.run("TERRAFORM_VALIDATE_FAILED", [
        "validate",
        "-no-color",
      ], workspace, env);

      const planPath = path.join(workspace, "tfplan");
      await this.runReleasingStaleLock("TERRAFORM_PLAN_FAILED", [
        "plan",
        "-input=false",
        "-no-color",
        `-lock-timeout=${LOCK_TIMEOUT}`,
        "-var-file=terraform.tfvars.json",
        `-out=${planPath}`,
      ], workspace, env, request);
      await this.run("TERRAFORM_APPLY_FAILED", [
        "apply",
        "-input=false",
        "-no-color",
        `-lock-timeout=${LOCK_TIMEOUT}`,
        planPath,
      ], workspace, env);

      const outputText = await this.run(
        "TERRAFORM_OUTPUT_FAILED",
        ["output", "-json"],
        workspace,
        env,
      );
      return parseTerraformOutputs(outputText);
    });
  }

  /**
   * 앱 삭제 (#247) — apply 와 같은 backend(state key) · 자격 증명으로 state 의 리소스를 모두 지운다.
   * destroy 는 state 에 있는 리소스를 지우므로 변수 값은 provider region 외에는 결과에 영향이 없다.
   */
  async destroy(request: TerraformCliRequest): Promise<void> {
    await this.inWorkspace(request, async (workspace, env) => {
      await this.runReleasingStaleLock("TERRAFORM_DESTROY_FAILED", [
        "destroy",
        "-auto-approve",
        "-input=false",
        "-no-color",
        `-lock-timeout=${LOCK_TIMEOUT}`,
        "-var-file=terraform.tfvars.json",
      ], workspace, env, request);
    });
  }

  /** 모듈을 임시 폴더에 복사하고 변수 파일을 쓴 뒤 backend 로 init 한다. 끝나면 임시 폴더를 지운다 */
  private async inWorkspace<T>(
    request: TerraformCliRequest,
    work: (workspace: string, env: NodeJS.ProcessEnv) => Promise<T>,
  ): Promise<T> {
    validateRequest(request);

    const workspace = await fs.mkdtemp(
      path.join(this.tempRoot, "camellia-terraform-"),
    );
    try {
      await fs.cp(request.moduleDirectory, workspace, {
        recursive: true,
        filter: (source) => path.basename(source) !== ".terraform",
      });
      await fs.writeFile(
        path.join(workspace, "terraform.tfvars.json"),
        JSON.stringify(request.variables),
        { mode: 0o600 },
      );

      const env = createTerraformEnvironment(request);
      const backendArgs = [
        `bucket=${request.backend.bucket}`,
        `key=${request.backend.stateKey}`,
        `region=${request.backend.region}`,
        "encrypt=true",
        `kms_key_id=${request.backend.kmsKeyId}`,
        "use_lockfile=true",
      ].map((value) => `-backend-config=${value}`);

      await this.run("TERRAFORM_INIT_FAILED", [
        "init",
        "-input=false",
        "-no-color",
        "-reconfigure",
        ...backendArgs,
      ], workspace, env);
      return await work(workspace, env);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** 이전 워커가 작업 도중 죽으면 S3 락 파일이 남는다 → 주인이 죽은 락이면 풀고 한 번 더 */
  private async runReleasingStaleLock(
    failureCode: ConstructorParameters<typeof TerraformCliError>[0],
    args: string[],
    workspace: string,
    env: NodeJS.ProcessEnv,
    request: TerraformCliRequest,
  ): Promise<string> {
    try {
      return await this.run(failureCode, args, workspace, env);
    } catch (error) {
      const lock = error instanceof TerraformCliError ? parseStateLock(error.detail) : null;
      if (!lock || lock.created >= this.staleLockBefore) throw error;
      await request.log?.(
        `이전 워커가 남긴 Terraform state 락(${lock.id}, ${lock.created.toISOString()})을 해제합니다.`,
      );
      await this.run(failureCode, ["force-unlock", "-force", lock.id], workspace, env);
      return this.run(failureCode, args, workspace, env);
    }
  }

  private async run(
    failureCode: ConstructorParameters<typeof TerraformCliError>[0],
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): Promise<string> {
    try {
      return await this.execute({
        executable: this.executable,
        args,
        cwd,
        env,
      });
    } catch (error) {
      if (
        failureCode === "TERRAFORM_INIT_FAILED" &&
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        throw new TerraformCliError("TERRAFORM_BINARY_UNAVAILABLE");
      }
      const stderrTail = error instanceof TerraformProcessError ? error.stderrTail : undefined;
      throw new TerraformCliError(failureCode, stderrTail);
    }
  }
}

function validateRequest(request: TerraformCliRequest): void {
  if (!path.isAbsolute(request.moduleDirectory)) {
    throw new TerraformCliError("TERRAFORM_MODULE_INVALID");
  }
  if (
    !request.backend.bucket ||
    !request.backend.region ||
    !request.backend.kmsKeyId ||
    !isValidStateKey(request.backend.stateKey)
  ) {
    throw new TerraformCliError("TERRAFORM_BACKEND_INVALID");
  }
  if (
    !request.region ||
    !request.credentials.accessKeyId ||
    !request.credentials.secretAccessKey ||
    Object.keys(request.variables).length === 0
  ) {
    throw new TerraformCliError("TERRAFORM_INPUT_INVALID");
  }
}

/** "Error acquiring the state lock" 출력의 Lock Info 에서 ID 와 생성 시각을 읽는다 */
function parseStateLock(
  detail: string | undefined,
): { id: string; created: Date } | null {
  if (!detail || !detail.includes("Error acquiring the state lock")) return null;
  const id = detail.match(/^\s*ID:\s+([0-9a-f-]{36})\s*$/im)?.[1];
  // 예: "Created:   2026-10-02 05:20:11.123456789 +0000 UTC"
  const created = detail.match(
    /^\s*Created:\s+(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)? ([+-]\d{2})(\d{2})/m,
  );
  if (!id || !created) return null;
  const [, date, time, fraction = "", offsetHours, offsetMinutes] = created;
  const value = new Date(
    `${date}T${time}${fraction.slice(0, 4)}${offsetHours}:${offsetMinutes}`,
  );
  return Number.isNaN(value.getTime()) ? null : { id, created: value };
}

function isValidStateKey(key: string): boolean {
  return (
    key.length > 0 &&
    !key.startsWith("/") &&
    !key.split("/").includes("..") &&
    /^[A-Za-z0-9_./-]+$/.test(key) &&
    key.endsWith(".tfstate")
  );
}

function createTerraformEnvironment(
  request: TerraformCliRequest,
): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("AWS_") || key.startsWith("TF_")) delete env[key];
  }
  env["AWS_ACCESS_KEY_ID"] = request.credentials.accessKeyId;
  env["AWS_SECRET_ACCESS_KEY"] = request.credentials.secretAccessKey;
  env["AWS_DEFAULT_REGION"] = request.region;
  env["AWS_REGION"] = request.region;
  env["TF_IN_AUTOMATION"] = "1";
  env["TF_INPUT"] = "0";
  return env;
}

function parseTerraformOutputs(text: string): TerraformOutputs {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TerraformCliError("TERRAFORM_OUTPUT_INVALID");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TerraformCliError("TERRAFORM_OUTPUT_INVALID");
  }

  const outputs: TerraformOutputs = {};
  for (const [name, output] of Object.entries(value)) {
    if (
      output === null ||
      typeof output !== "object" ||
      !("value" in output)
    ) {
      throw new TerraformCliError("TERRAFORM_OUTPUT_INVALID");
    }
    outputs[name] = output as TerraformOutput;
  }
  return outputs;
}

const STDERR_TAIL_LIMIT = 4 * 1024;

const executeTerraformCommand: TerraformCommandExecutor = ({
  executable,
  args,
  cwd,
  env,
}) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let capturedChars = 0;
    let stderrOutput = "";
    let stderrChars = 0;

    const capture = (chunk: Buffer) => {
      if (capturedChars >= MAX_CAPTURED_OUTPUT) return;
      const remaining = MAX_CAPTURED_OUTPUT - capturedChars;
      const text = chunk.toString("utf8").slice(0, remaining);
      output += text;
      capturedChars += text.length;
    };

    const captureStderr = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrOutput += text;
      stderrChars += text.length;
      if (stderrChars > STDERR_TAIL_LIMIT) {
        stderrOutput = stderrOutput.slice(stderrChars - STDERR_TAIL_LIMIT);
        stderrChars = STDERR_TAIL_LIMIT;
      }
    };

    child.stdout.on("data", capture);
    child.stderr.on("data", captureStderr);
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(output);
      else
        reject(
          new TerraformProcessError(
            `terraform exited with code ${code ?? "unknown"}`,
            stderrOutput,
          ),
        );
    });
  });
