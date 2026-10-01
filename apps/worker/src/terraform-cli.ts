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
};

export class TerraformCli {
  private readonly executable: string;
  private readonly tempRoot: string;
  private readonly execute: TerraformCommandExecutor;

  constructor(options: TerraformCliOptions = {}) {
    this.executable = options.executable ?? "terraform";
    this.tempRoot = options.tempRoot ?? os.tmpdir();
    this.execute = options.execute ?? executeTerraformCommand;
  }

  async apply(request: TerraformCliRequest): Promise<TerraformOutputs> {
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
      await this.run("TERRAFORM_VALIDATE_FAILED", [
        "validate",
        "-no-color",
      ], workspace, env);

      const planPath = path.join(workspace, "tfplan");
      await this.run("TERRAFORM_PLAN_FAILED", [
        "plan",
        "-input=false",
        "-no-color",
        "-var-file=terraform.tfvars.json",
        `-out=${planPath}`,
      ], workspace, env);
      await this.run("TERRAFORM_APPLY_FAILED", [
        "apply",
        "-input=false",
        "-no-color",
        planPath,
      ], workspace, env);

      const outputText = await this.run(
        "TERRAFORM_OUTPUT_FAILED",
        ["output", "-json"],
        workspace,
        env,
      );
      return parseTerraformOutputs(outputText);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
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
