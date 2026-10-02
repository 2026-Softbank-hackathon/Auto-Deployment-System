import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { logMessage, type LogText } from "./log-messages.js";

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
  /** 사용자에게 보여줄 진행 로그 (예: 남은 state 락 해제, 단계별 소요 시간) */
  log?: (line: LogText) => Promise<void>;
  /**
   * false 면 기존 리소스를 다시 조회하지 않는다 — 이미지만 바뀐 재배포 (#252).
   * 이때는 plan 파일을 따로 만들지 않고 apply -refresh=false -auto-approve 한 번으로 끝낸다 (#260). 기본 true
   */
  refresh?: boolean;
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
  /**
   * provider 플러그인 캐시 (#252). 워커 이미지가 profile lock 파일의 provider 를 미리 받아 둔 경로.
   * init 이 여기서 symlink 로 가져오고, 없는 버전만 내려받아 채운다
   */
  pluginCacheDir?: string;
  /** 소요 시간 측정용 시계 (ms) — 테스트 주입용 */
  now?: () => number;
  /**
   * 프로젝트 · 환경(state key)별 Terraform 작업 폴더의 상위 경로 (#260). 있으면 apply 가
   * <root>/<state key> 폴더의 .terraform(backend 설정 · provider 링크)을 다음 배포까지 남겨
   * init · validate 를 필요할 때만 한다. 없으면 예전처럼 매번 임시 폴더에서 init 한다
   */
  workDirRoot?: string;
};

type Workspace = {
  directory: string;
  env: NodeJS.ProcessEnv;
  /** 이 폴더에서 같은 profile 파일로 validate 가 이미 성공했다 */
  validated: boolean;
  markValidated: () => Promise<void>;
};

/** 작업 폴더 상태 기록. .terraform 안에 두어 .terraform 을 지우면 함께 사라진다 */
const WORK_DIR_MARKER = path.join(".terraform", "camellia-workdir.json");

type WorkDirMarker = {
  /** init 결과를 좌우하는 입력(profile 파일 · backend 설정 · 액세스 키 ID · provider 캐시 · terraform 경로)의 지문 */
  initHash: string;
  /** validate 가 성공한 profile 파일 지문 */
  validatedFilesHash?: string;
};

/** state 락이 잡혀 있으면 이만큼 기다린다 (plan · apply · destroy) */
const LOCK_TIMEOUT = "1m";

export class TerraformCli {
  private readonly executable: string;
  private readonly tempRoot: string;
  private readonly execute: TerraformCommandExecutor;
  private readonly staleLockBefore: Date;
  private readonly pluginCacheDir: string | undefined;
  private readonly now: () => number;
  private readonly workDirRoot: string | undefined;
  /** 이 프로세스에서 지금 쓰고 있는 작업 폴더 */
  private readonly busyWorkDirs = new Set<string>();

  constructor(options: TerraformCliOptions = {}) {
    this.executable = options.executable ?? "terraform";
    this.tempRoot = options.tempRoot ?? os.tmpdir();
    this.execute = options.execute ?? executeTerraformCommand;
    this.staleLockBefore =
      options.staleLockBefore ?? new Date(Date.now() - process.uptime() * 1000);
    this.pluginCacheDir = options.pluginCacheDir;
    this.now = options.now ?? (() => performance.now());
    this.workDirRoot = options.workDirRoot;
  }

  /**
   * 인프라 입력 지문 (#252) — 모듈 파일(.terraform 제외) · 변수 · region · access key ID 의 SHA-256.
   * 호출자가 이미지 변수를 빼고 넘기면, 직전 성공 배포와 같을 때 이미지 외에는 바뀐 입력이 없다는 뜻이다.
   */
  async fingerprint(
    input: Pick<TerraformCliRequest, "moduleDirectory" | "region" | "credentials" | "variables">,
  ): Promise<string> {
    return sha256(canonicalJson({
      files: await moduleFileHashes(input.moduleDirectory),
      region: input.region,
      accessKeyId: input.credentials.accessKeyId,
      variables: input.variables,
    }));
  }

  async apply(request: TerraformCliRequest): Promise<TerraformOutputs> {
    return this.inWorkspace(request, true, async ({ directory, env, validated, markValidated }) => {
      if (validated) {
        await request.log?.(logMessage("terraform.validateSkipped"));
      } else {
        await this.timed(request, "validate", () =>
          this.run("TERRAFORM_VALIDATE_FAILED", ["validate", "-no-color"], directory, env),
        );
        await markValidated();
      }

      if (request.refresh === false) {
        // 이미지만 바뀐 재배포: 저장한 plan 을 쓰는 곳(승인 · 화면 표시)이 없으므로 plan 과 apply 를
        // 한 프로세스로 합친다. 같은 계산을 state 락 · provider 기동 한 번으로 끝낸다 (#260)
        await request.log?.(logMessage("terraform.combinedApply"));
        await this.timed(request, "plan·apply", () =>
          this.runReleasingStaleLock("TERRAFORM_APPLY_FAILED", [
            "apply",
            "-input=false",
            "-no-color",
            `-lock-timeout=${LOCK_TIMEOUT}`,
            "-refresh=false",
            "-auto-approve",
            "-var-file=terraform.tfvars.json",
          ], directory, env, request),
        );
      } else {
        const planPath = path.join(directory, "tfplan");
        await this.timed(request, "plan", () =>
          this.runReleasingStaleLock("TERRAFORM_PLAN_FAILED", [
            "plan",
            "-input=false",
            "-no-color",
            `-lock-timeout=${LOCK_TIMEOUT}`,
            "-var-file=terraform.tfvars.json",
            `-out=${planPath}`,
          ], directory, env, request),
        );
        await this.timed(request, "apply", () =>
          this.run("TERRAFORM_APPLY_FAILED", [
            "apply",
            "-input=false",
            "-no-color",
            `-lock-timeout=${LOCK_TIMEOUT}`,
            planPath,
          ], directory, env),
        );
      }

      const outputText = await this.run(
        "TERRAFORM_OUTPUT_FAILED",
        ["output", "-json"],
        directory,
        env,
      );
      return parseTerraformOutputs(outputText);
    });
  }

  /** 재시도 시 plan/apply 없이 기존 remote state의 출력값만 복구한다. */
  async output(request: TerraformCliRequest): Promise<TerraformOutputs> {
    return this.inWorkspace(request, true, async ({ directory, env }) => {
      const outputText = await this.run(
        "TERRAFORM_OUTPUT_FAILED",
        ["output", "-json"],
        directory,
        env,
      );
      return parseTerraformOutputs(outputText);
    });
  }

  /**
   * 앱 삭제 (#247) — apply 와 같은 backend(state key) · 자격 증명으로 state 의 리소스를 모두 지운다.
   * destroy 는 state 에 있는 리소스를 지우므로 변수 값은 provider region 외에는 결과에 영향이 없다.
   * 한 번뿐인 작업이라 임시 폴더에서 하고, 성공하면 그 state 의 작업 폴더도 지운다 (#260)
   */
  async destroy(request: TerraformCliRequest): Promise<void> {
    await this.inWorkspace(request, false, async ({ directory, env }) => {
      await this.runReleasingStaleLock("TERRAFORM_DESTROY_FAILED", [
        "destroy",
        "-auto-approve",
        "-input=false",
        "-no-color",
        `-lock-timeout=${LOCK_TIMEOUT}`,
        "-var-file=terraform.tfvars.json",
      ], directory, env, request);
    });
    const workDir = this.workDirFor(request);
    if (workDir && !this.busyWorkDirs.has(workDir)) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * reuse 이고 작업 폴더 경로가 설정돼 있으면 state key 별 작업 폴더에서, 아니면 임시 폴더에서 실행한다.
   * 같은 프로젝트 · 환경의 배포는 env 락으로 한 번에 하나이고 플랫폼 워커도 하나라 겹치지 않지만,
   * 이 프로세스에서 같은 폴더를 쓰는 중이면 기다리지 않고 임시 폴더(예전 방식)로 실행한다
   */
  private async inWorkspace<T>(
    request: TerraformCliRequest,
    reuse: boolean,
    work: (workspace: Workspace) => Promise<T>,
  ): Promise<T> {
    validateRequest(request);
    const env = createTerraformEnvironment(request, this.pluginCacheDir);

    const workDir = reuse ? this.workDirFor(request) : null;
    if (workDir && !this.busyWorkDirs.has(workDir)) {
      this.busyWorkDirs.add(workDir);
      try {
        return await this.inPersistentWorkspace(request, workDir, env, work);
      } finally {
        this.busyWorkDirs.delete(workDir);
      }
    }
    if (workDir) {
      await request.log?.(logMessage("terraform.tempWorkspace"));
    }

    const directory = await fs.mkdtemp(path.join(this.tempRoot, "camellia-terraform-"));
    try {
      await writeWorkspaceFiles(request, directory);
      await this.init(request, directory, env);
      return await work({ directory, env, validated: false, markValidated: async () => {} });
    } finally {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * 작업 폴더에는 실행 사이에 .terraform 만 남긴다. 실행마다 profile 파일을 새로 복사하고 변수 파일을 쓰며,
   * 끝나면(실패해도) .terraform 밖의 파일(변수 · plan · errored.tfstate 등)을 모두 지운다.
   * init 기록이 이번 입력과 같고 .terraform 이 온전하면 init 을 건너뛴다. 아니면 .terraform 을 지우고 새로 init.
   */
  private async inPersistentWorkspace<T>(
    request: TerraformCliRequest,
    directory: string,
    env: NodeJS.ProcessEnv,
    work: (workspace: Workspace) => Promise<T>,
  ): Promise<T> {
    try {
      await fs.mkdir(directory, { recursive: true });
      await removeAllButTerraformDir(directory);
      await writeWorkspaceFiles(request, directory);

      const filesHash = sha256(canonicalJson(await moduleFileHashes(request.moduleDirectory)));
      const initHash = sha256(canonicalJson({
        filesHash,
        backend: request.backend,
        accessKeyId: request.credentials.accessKeyId,
        pluginCacheDir: this.pluginCacheDir ?? null,
        executable: this.executable,
      }));
      // validate 결과는 profile 파일에만 달려 있으므로 backend · 키가 바뀌어 다시 init 해도 이어 쓴다
      const freshInit = async (validatedFilesHash?: string) => {
        await fs.rm(path.join(directory, ".terraform"), { recursive: true, force: true });
        await this.init(request, directory, env);
        await writeMarker(directory, { initHash, validatedFilesHash });
      };
      const workspace = (validated: boolean): Workspace => ({
        directory,
        env,
        validated,
        markValidated: () => writeMarker(directory, { initHash, validatedFilesHash: filesHash }),
      });

      const marker = await readMarker(directory);
      const usable = marker !== null && (await isTerraformDirUsable(directory));
      if (!marker || !usable || marker.initHash !== initHash) {
        const reason = !marker
          ? "terraform.initFirst"
          : !usable
            ? "terraform.initCorrupted"
            : "terraform.initConfigChanged";
        // 손상된 폴더는 provider 도 믿지 않고 validate 부터 다시 한다
        const validatedFilesHash = usable ? marker?.validatedFilesHash : undefined;
        await request.log?.(logMessage(reason));
        await freshInit(validatedFilesHash);
        return await work(workspace(validatedFilesHash === filesHash));
      }

      await request.log?.(logMessage("terraform.workspaceReused"));
      try {
        return await work(workspace(marker.validatedFilesHash === filesHash));
      } catch (error) {
        // 검사로 못 잡은 어긋남 — Terraform 이 init 을 요구하면 아무것도 바꾸기 전이므로 한 번만 새로 init
        if (!requiresInit(error)) throw error;
        await request.log?.(logMessage("terraform.reinit"));
        await freshInit();
        return await work(workspace(false));
      }
    } finally {
      await removeAllButTerraformDir(directory).catch(() => {});
    }
  }

  /** state key 하나에 폴더 하나. 폴더끼리 상위 · 하위로 겹치지 않게 '/' 를 인코딩해 한 단계로 둔다 */
  private workDirFor(request: TerraformCliRequest): string | null {
    if (!this.workDirRoot) return null;
    return path.join(this.workDirRoot, encodeURIComponent(request.backend.stateKey));
  }

  private async init(
    request: TerraformCliRequest,
    directory: string,
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    const backendArgs = [
      `bucket=${request.backend.bucket}`,
      `key=${request.backend.stateKey}`,
      `region=${request.backend.region}`,
      "encrypt=true",
      `kms_key_id=${request.backend.kmsKeyId}`,
      "use_lockfile=true",
    ].map((value) => `-backend-config=${value}`);

    // lock 파일이 있으면 그 버전 · 체크섬 그대로만 설치한다 → 캐시의 provider 를 검증 후 재사용 (#252)
    const lockfileArgs = await fs
      .access(path.join(directory, ".terraform.lock.hcl"))
      .then(() => ["-lockfile=readonly"], () => []);

    await this.timed(request, "init", () =>
      this.run("TERRAFORM_INIT_FAILED", [
        "init",
        "-input=false",
        "-no-color",
        "-reconfigure",
        ...lockfileArgs,
        ...backendArgs,
      ], directory, env),
    );
  }

  /** 단계 소요 시간을 진행 로그에 남긴다 (#252) — 예: "terraform plan 완료 (7.1초)" */
  private async timed<T>(
    request: TerraformCliRequest,
    step: "init" | "validate" | "plan" | "apply" | "plan·apply",
    work: () => Promise<T>,
  ): Promise<T> {
    const started = this.now();
    const result = await work();
    const seconds = (this.now() - started) / 1000;
    await request.log?.(logMessage("terraform.stepDone", { step, seconds: seconds.toFixed(1) }));
    return result;
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
        logMessage("terraform.staleLock", { lock: lock.id, created: lock.created.toISOString() }),
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
  pluginCacheDir: string | undefined,
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
  if (pluginCacheDir) env["TF_PLUGIN_CACHE_DIR"] = pluginCacheDir;
  return env;
}

/** profile 파일 복사(.terraform 제외)와 변수 파일 작성. 변수 파일은 실행이 끝나면 지운다 */
async function writeWorkspaceFiles(
  request: TerraformCliRequest,
  directory: string,
): Promise<void> {
  await fs.cp(request.moduleDirectory, directory, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".terraform",
  });
  await fs.writeFile(
    path.join(directory, "terraform.tfvars.json"),
    JSON.stringify(request.variables),
    { mode: 0o600 },
  );
}

async function removeAllButTerraformDir(directory: string): Promise<void> {
  for (const entry of await fs.readdir(directory)) {
    if (entry === ".terraform") continue;
    await fs.rm(path.join(directory, entry), { recursive: true, force: true });
  }
}

async function readMarker(directory: string): Promise<WorkDirMarker | null> {
  try {
    const value: unknown = JSON.parse(
      await fs.readFile(path.join(directory, WORK_DIR_MARKER), "utf8"),
    );
    if (
      value !== null &&
      typeof value === "object" &&
      typeof (value as WorkDirMarker).initHash === "string"
    ) {
      return value as WorkDirMarker;
    }
  } catch {
    // 없거나 깨진 기록 → 새로 init
  }
  return null;
}

/** 임시 파일에 쓴 뒤 이름을 바꿔, 쓰는 도중 죽어도 반쯤 쓴 기록이 남지 않게 한다 */
async function writeMarker(directory: string, marker: WorkDirMarker): Promise<void> {
  const target = path.join(directory, WORK_DIR_MARKER);
  await fs.writeFile(`${target}.tmp`, JSON.stringify(marker));
  await fs.rename(`${target}.tmp`, target);
}

/**
 * init 이 끝까지 된 폴더인지 — backend 설정 파일이 있고, lock 파일이 있으면 provider 폴더의 링크가
 * 모두 실제 파일을 가리킨다(워커 이미지가 바뀌어 provider 캐시가 달라지면 링크가 끊긴다)
 */
async function isTerraformDirUsable(directory: string): Promise<boolean> {
  try {
    await fs.access(path.join(directory, ".terraform", "terraform.tfstate"));
    const hasLockFile = await fs
      .access(path.join(directory, ".terraform.lock.hcl"))
      .then(() => true, () => false);
    if (hasLockFile) await assertLinksResolve(path.join(directory, ".terraform", "providers"));
    return true;
  } catch {
    return false;
  }
}

async function assertLinksResolve(directory: string): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) await fs.stat(entryPath);
    else if (entry.isDirectory()) await assertLinksResolve(entryPath);
  }
}

/** 재사용한 폴더가 Terraform 과 맞지 않을 때의 오류 — 모두 실행 전에 멈추는 오류다 */
function requiresInit(error: unknown): boolean {
  return (
    error instanceof TerraformCliError &&
    /terraform init|Backend initialization required|Required plugins are not installed|Inconsistent dependency lock file/i
      .test(error.detail ?? "")
  );
}

async function moduleFileHashes(directory: string): Promise<Array<[string, string]>> {
  const files: Array<[string, string]> = [];
  for (const file of await listModuleFiles(directory)) {
    files.push([
      path.relative(directory, file).replaceAll(path.sep, "/"),
      sha256(await fs.readFile(file)),
    ]);
  }
  return files;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function listModuleFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".terraform") continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listModuleFiles(entryPath)));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files.sort();
}

/** 키 순서와 무관한 JSON — 같은 값이면 같은 문자열 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
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
