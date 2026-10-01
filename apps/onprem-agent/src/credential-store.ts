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
import { randomUUID } from "node:crypto";

export type AgentCredential = {
  controlPlaneUrl: string;
  agentId: string;
  environmentId: string;
  agentKey: string;
};

export interface AgentCredentialStore {
  prepare(): Promise<void>;
  load(): Promise<AgentCredential | null>;
  save(credential: AgentCredential): Promise<void>;
}

function isAgentCredential(value: unknown): value is AgentCredential {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 4 &&
    typeof candidate.controlPlaneUrl === "string" &&
    candidate.controlPlaneUrl.length > 0 &&
    typeof candidate.agentId === "string" &&
    /^\d+$/.test(candidate.agentId) &&
    typeof candidate.environmentId === "string" &&
    /^\d+$/.test(candidate.environmentId) &&
    typeof candidate.agentKey === "string" &&
    candidate.agentKey.length > 0
  );
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export class FileAgentCredentialStore implements AgentCredentialStore {
  private readonly credentialPath: string;

  constructor(private readonly stateDirectory: string) {
    this.credentialPath = join(stateDirectory, "credentials.json");
  }

  async prepare(): Promise<void> {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(this.stateDirectory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw new Error("Agent 상태 디렉터리가 올바르지 않습니다.");
    }
    await chmod(this.stateDirectory, 0o700);
  }

  async load(): Promise<AgentCredential | null> {
    let fileInfo;
    try {
      fileInfo = await lstat(this.credentialPath);
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw new Error("Agent 인증정보 파일을 확인하지 못했습니다.");
    }
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
      throw new Error("Agent 인증정보 파일 형식이 올바르지 않습니다.");
    }
    const directoryInfo = await lstat(this.stateDirectory);
    if (
      !directoryInfo.isDirectory() ||
      directoryInfo.isSymbolicLink() ||
      (directoryInfo.mode & 0o077) !== 0
    ) {
      throw new Error("Agent 상태 디렉터리 권한은 700이어야 합니다.");
    }
    if ((fileInfo.mode & 0o077) !== 0) {
      throw new Error("Agent 인증정보 파일 권한은 600이어야 합니다.");
    }

    try {
      const parsed: unknown = JSON.parse(await readFile(this.credentialPath, "utf8"));
      if (!isAgentCredential(parsed)) throw new Error("invalid");
      return parsed;
    } catch {
      throw new Error("Agent 인증정보 파일 내용이 올바르지 않습니다.");
    }
  }

  async save(credential: AgentCredential): Promise<void> {
    if (!isAgentCredential(credential)) {
      throw new Error("저장할 Agent 인증정보가 올바르지 않습니다.");
    }
    await this.prepare();

    const temporaryPath = join(
      this.stateDirectory,
      `.credentials-${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporaryPath, `${JSON.stringify(credential)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.credentialPath);
      await chmod(this.credentialPath, 0o600);
    } catch {
      throw new Error("Agent 인증정보를 저장하지 못했습니다.");
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}
