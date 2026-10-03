import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileAgentCredentialStore } from "../src/credential-store.js";

// Windows는 POSIX 권한 비트가 없어 권한 검사를 하지 않는다 (file-permissions.ts)
const posix = process.platform !== "win32";

describe("Agent 장기 인증정보 파일 저장소", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  async function createStore(): Promise<{
    root: string;
    stateDirectory: string;
    store: FileAgentCredentialStore;
  }> {
    const root = await mkdtemp(join(tmpdir(), "camellia-agent-credential-"));
    roots.push(root);
    const stateDirectory = join(root, "state");
    return {
      root,
      stateDirectory,
      store: new FileAgentCredentialStore(stateDirectory),
    };
  }

  it.runIf(posix)("디렉터리 700·파일 600으로 원자 저장하고 다시 읽는다", async () => {
    const { stateDirectory, store } = await createStore();
    const credential = {
      controlPlaneUrl: "https://control.camellia.example",
      agentId: "5",
      environmentId: "10",
      agentKey: "long-lived-agent-key",
    };

    expect(await store.load()).toBeNull();
    await store.save(credential);

    const directoryMode = (await stat(stateDirectory)).mode & 0o777;
    const credentialPath = join(stateDirectory, "credentials.json");
    const fileMode = (await stat(credentialPath)).mode & 0o777;
    expect(directoryMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
    expect(JSON.parse(await readFile(credentialPath, "utf8"))).toEqual(credential);
    expect(await store.load()).toEqual(credential);

    await chmod(stateDirectory, 0o755);
    await expect(store.load()).rejects.toThrow("디렉터리 권한");
  });

  it.runIf(posix)("권한이 느슨하거나 형식이 잘못된 인증정보 파일을 거부하고 값을 오류에 노출하지 않는다", async () => {
    const { stateDirectory, store } = await createStore();
    await store.save({
      controlPlaneUrl: "https://control.camellia.example",
      agentId: "5",
      environmentId: "10",
      agentKey: "secret-key-must-not-leak",
    });
    const credentialPath = join(stateDirectory, "credentials.json");
    await chmod(credentialPath, 0o644);
    await expect(store.load()).rejects.toThrow("권한");

    await chmod(credentialPath, 0o600);
    await writeFile(credentialPath, '{"agentKey":"secret-key-must-not-leak"}', {
      mode: 0o600,
    });
    let error: unknown;
    try {
      await store.load();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("secret-key-must-not-leak");
  });
});
