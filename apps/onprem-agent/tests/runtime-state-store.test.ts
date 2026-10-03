import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileRuntimeStateStore,
  type PersistedRuntime,
} from "../src/runtime-state-store.js";

// Windows는 POSIX 권한 비트가 없어 권한 검사를 하지 않는다 (file-permissions.ts)
const posix = process.platform !== "win32";

const runtime: PersistedRuntime = {
  jobId: "job-42",
  deploymentId: 42,
  environmentId: "12",
  digest: `sha256:${"a".repeat(64)}`,
  imageUri: `123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/camellia/project@sha256:${"a".repeat(64)}`,
  projectName: `camellia-d42-1234567890-${"a".repeat(12)}`,
  localUrl: "http://127.0.0.1:49152",
  endpoint: "https://verify-d42.camellia-deploy.app",
  health: { path: "/health", expectedStatus: 200, timeoutSeconds: 3 },
};

describe("Agent 런타임 상태 파일", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  async function createStore() {
    const root = await mkdtemp(join(tmpdir(), "camellia-runtime-state-"));
    roots.push(root);
    const stateDirectory = join(root, "state");
    return { stateDirectory, store: new FileRuntimeStateStore(stateDirectory) };
  }

  it.runIf(posix)("디렉터리 700·파일 600으로 원자 저장하고 배포별로 제거한다", async () => {
    const { stateDirectory, store } = await createStore();

    expect(await store.load()).toEqual([]);
    await store.save(runtime);

    expect((await stat(stateDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(stateDirectory, "runtimes.json"))).mode & 0o777).toBe(0o600);
    expect(await store.load()).toEqual([runtime]);

    await store.remove(runtime.deploymentId);
    expect(await store.load()).toEqual([]);
    expect(JSON.parse(await readFile(join(stateDirectory, "runtimes.json"), "utf8"))).toEqual({
      version: 1,
      runtimes: [],
    });
  });

  it.runIf(posix)("느슨한 권한이나 손상된 상태 파일을 거부한다", async () => {
    const { stateDirectory, store } = await createStore();
    await store.save(runtime);
    const statePath = join(stateDirectory, "runtimes.json");

    await chmod(statePath, 0o644);
    await expect(store.load()).rejects.toThrow("권한");

    await chmod(statePath, 0o600);
    await writeFile(statePath, '{"version":1,"runtimes":[{"digest":"secret"}]}', { mode: 0o600 });
    await expect(store.load()).rejects.toThrow("내용");
  });
});
