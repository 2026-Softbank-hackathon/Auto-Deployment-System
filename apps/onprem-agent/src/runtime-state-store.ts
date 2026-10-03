import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { hasLoosePermissions } from "./file-permissions.js";

export type PersistedRuntime = {
  jobId: string;
  deploymentId: number;
  environmentId: string;
  digest: string;
  imageUri: string;
  projectName: string;
  localUrl: string;
  endpoint: string;
  health: {
    path: string;
    expectedStatus: number;
    timeoutSeconds: number;
  };
};

export interface RuntimeStateStore {
  load(): Promise<PersistedRuntime[]>;
  save(runtime: PersistedRuntime): Promise<void>;
  remove(deploymentId: number): Promise<void>;
}

type RuntimeStateDocument = {
  version: 1;
  runtimes: PersistedRuntime[];
};

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT",
  );
}

function isLoopbackUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      /^\d+$/.test(url.port) &&
      url.pathname === "/" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function isPersistedRuntime(value: unknown): value is PersistedRuntime {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const health = candidate["health"];
  if (!health || typeof health !== "object" || Array.isArray(health)) return false;
  const healthRecord = health as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 9 &&
    typeof candidate["jobId"] === "string" &&
    candidate["jobId"].length > 0 &&
    Number.isSafeInteger(candidate["deploymentId"]) &&
    Number(candidate["deploymentId"]) > 0 &&
    typeof candidate["environmentId"] === "string" &&
    candidate["environmentId"].length > 0 &&
    typeof candidate["digest"] === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(candidate["digest"]) &&
    typeof candidate["imageUri"] === "string" &&
    candidate["imageUri"].endsWith(`@${candidate["digest"]}`) &&
    typeof candidate["projectName"] === "string" &&
    /^camellia-d\d+-[a-f0-9]{10}-[a-f0-9]{12}$/.test(candidate["projectName"]) &&
    isLoopbackUrl(candidate["localUrl"]) &&
    typeof candidate["endpoint"] === "string" &&
    /^https:\/\/[^\s/]+(?:\/.*)?$/.test(candidate["endpoint"]) &&
    Object.keys(healthRecord).length === 3 &&
    typeof healthRecord["path"] === "string" &&
    healthRecord["path"].startsWith("/") &&
    Number.isInteger(healthRecord["expectedStatus"]) &&
    Number(healthRecord["expectedStatus"]) >= 100 &&
    Number(healthRecord["expectedStatus"]) <= 599 &&
    typeof healthRecord["timeoutSeconds"] === "number" &&
    Number.isFinite(healthRecord["timeoutSeconds"]) &&
    Number(healthRecord["timeoutSeconds"]) > 0
  );
}

function parseDocument(value: unknown): RuntimeStateDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid");
  }
  const document = value as Record<string, unknown>;
  if (
    Object.keys(document).length !== 2 ||
    document["version"] !== 1 ||
    !Array.isArray(document["runtimes"]) ||
    !document["runtimes"].every(isPersistedRuntime)
  ) {
    throw new Error("invalid");
  }
  return { version: 1, runtimes: document["runtimes"] };
}

export class FileRuntimeStateStore implements RuntimeStateStore {
  private readonly statePath: string;

  constructor(private readonly stateDirectory: string) {
    this.statePath = join(stateDirectory, "runtimes.json");
  }

  async load(): Promise<PersistedRuntime[]> {
    let fileInfo;
    try {
      fileInfo = await lstat(this.statePath);
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw new Error("Agent 런타임 상태 파일을 확인하지 못했습니다.");
    }
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
      throw new Error("Agent 런타임 상태 파일 형식이 올바르지 않습니다.");
    }
    const directoryInfo = await lstat(this.stateDirectory);
    if (
      !directoryInfo.isDirectory() ||
      directoryInfo.isSymbolicLink() ||
      hasLoosePermissions(directoryInfo.mode)
    ) {
      throw new Error("Agent 상태 디렉터리 권한은 700이어야 합니다.");
    }
    if (hasLoosePermissions(fileInfo.mode)) {
      throw new Error("Agent 런타임 상태 파일 권한은 600이어야 합니다.");
    }
    try {
      const document = parseDocument(JSON.parse(await readFile(this.statePath, "utf8")));
      return document.runtimes;
    } catch {
      throw new Error("Agent 런타임 상태 파일 내용이 올바르지 않습니다.");
    }
  }

  async save(runtime: PersistedRuntime): Promise<void> {
    if (!isPersistedRuntime(runtime)) {
      throw new Error("저장할 Agent 런타임 상태가 올바르지 않습니다.");
    }
    const runtimes = (await this.load()).filter(
      (existing) => existing.deploymentId !== runtime.deploymentId,
    );
    runtimes.push(runtime);
    await this.write({ version: 1, runtimes });
  }

  async remove(deploymentId: number): Promise<void> {
    const runtimes = (await this.load()).filter(
      (runtime) => runtime.deploymentId !== deploymentId,
    );
    await this.write({ version: 1, runtimes });
  }

  private async write(document: RuntimeStateDocument): Promise<void> {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.stateDirectory, 0o700);
    const temporaryPath = join(
      this.stateDirectory,
      `.runtimes-${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporaryPath, `${JSON.stringify(document)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.statePath);
      await chmod(this.statePath, 0o600);
    } catch {
      throw new Error("Agent 런타임 상태를 저장하지 못했습니다.");
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}
