/**
 * SQLite → PostgreSQL 수정안 (#277) — AI 응답은 mock, 나머지(파일 선택 · 검증 · 의존성 · lock 파일 · diff)는 실제로 돈다.
 * mock 응답은 tests/fixtures/sqlite-web-patched 의 dual-mode 코드 (실제 Postgres 로 데이터 이전까지 확인한 참고 구현).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "../../src/index.js";
import { applyPatch, createSqlitePatch } from "../../src/patch/sqlite-to-postgres.js";
import type { AnthropicCreateParams, AnthropicLike, AnthropicMessageResponse } from "../../src/ai/anthropic-client.js";
import type { ResourceCandidate } from "../../src/types.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const SAMPLE = resolve(here, "../../../../apps/samples/sqlite-web");
const PATCHED = resolve(here, "../fixtures/sqlite-web-patched");

let dir: string;
let resource: ResourceCandidate;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "camellia-patch-"));
  await cp(SAMPLE, dir, {
    recursive: true,
    filter: (source) => !/[\\/](node_modules|dist)([\\/]|$)/.test(source),
  });
  resource = (await analyze(dir)).resources[0]!;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

async function patchedFiles(): Promise<Array<{ path: string; content: string }>> {
  return [
    { path: "src/db.ts", content: await readFile(join(PATCHED, "db.ts.txt"), "utf8") },
    { path: "src/server.ts", content: await readFile(join(PATCHED, "server.ts.txt"), "utf8") },
  ];
}

function mockClient(answers: unknown[]): AnthropicLike & { calls: AnthropicCreateParams[] } {
  const calls: AnthropicCreateParams[] = [];
  return {
    calls,
    messages: {
      create: vi.fn(async (params: AnthropicCreateParams): Promise<AnthropicMessageResponse> => {
        calls.push(params);
        const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
        return {
          content: [
            { type: "thinking", thinking: "..." },
            { type: "text", text: JSON.stringify(answer) },
          ],
          usage: { input_tokens: 1200, output_tokens: 3400 },
          stop_reason: "end_turn",
        };
      }),
    },
  };
}

const fakeLockfile = async (directory: string) => {
  const lock = JSON.parse(await readFile(join(directory, "package-lock.json"), "utf8"));
  lock.packages[""].dependencies = { ...lock.packages[""].dependencies, pg: "^8.23.1" };
  await writeFile(join(directory, "package-lock.json"), JSON.stringify(lock, null, 2) + "\n");
};

describe("createSqlitePatch", () => {
  it("샘플 앱: AI 수정 + pg · @types/pg + lock 파일 갱신 + unified diff", async () => {
    const summary = { ko: "SQLite 접근 코드를 PostgreSQL 겸용으로 바꿉니다.", ja: "SQLite のアクセスコードを PostgreSQL 兼用に変更します。" };
    const note = { ko: "처음 시작할 때 데이터를 옮깁니다.", ja: "初回起動時にデータを移行します。" };
    const client = mockClient([{ summary, notes: [note], files: await patchedFiles() }]);
    const usages: unknown[] = [];

    const patch = await createSqlitePatch(dir, resource, {
      client,
      model: "claude-test",
      onUsage: (usage) => void usages.push(usage),
      updateLockfile: fakeLockfile,
    });

    expect(patch.status).toBe("ready");
    if (patch.status !== "ready") return;
    expect(patch.files.map((file) => file.path)).toEqual([
      "src/db.ts",
      "src/server.ts",
      "package.json",
      "package-lock.json",
    ]);
    const pkg = JSON.parse(patch.files.find((file) => file.path === "package.json")!.after);
    expect(pkg.dependencies.pg).toBe("^8.23.1");
    expect(pkg.devDependencies["@types/pg"]).toBe("^8.23.1");
    // CommonJS 번들이라 배너는 붙이지 않는다
    expect(pkg.scripts.build).not.toContain("--banner");
    expect(patch.files.find((file) => file.path === "package-lock.json")).toMatchObject({ generated: true });
    expect(patch.diff).toContain("--- a/src/db.ts\n+++ b/src/db.ts\n@@");
    expect(patch.diff).toContain("+const DATABASE_URL = process.env.DATABASE_URL;");
    expect(patch.diff).toContain('+    "pg": "^8.23.1"');
    expect(patch.diff).not.toContain("package-lock.json");
    expect(patch.model).toBe("claude-test");
    // 설명은 한국어 · 일본어를 한 번에 받는다 (#147)
    expect(patch.summary).toEqual(summary);
    expect(patch.notes).toEqual([note]);
    expect(usages).toHaveLength(1);

    // 보낸 내용: SQLite 를 쓰는 파일이 먼저, 접속 환경변수 · 데이터 파일 · 구조화 출력
    const request = client.calls[0]!;
    const payload = JSON.parse(request.messages[0]!.content);
    expect(payload.connection_env).toBe("DATABASE_URL");
    expect(payload.sqlite_data_files).toEqual(["data/guestbook.db"]);
    expect(payload.files[0].path).toBe("src/db.ts");
    expect(payload.context_files.map((file: { path: string }) => file.path)).toContain("package.json");
    expect(request.output_config?.format?.type).toBe("json_schema");
    const schema = request.output_config?.format?.schema as {
      properties: { summary: { required: string[] }; notes: { items: { required: string[] } } };
    };
    expect(schema.properties.summary.required).toEqual(["ko", "ja"]);
    expect(schema.properties.notes.items.required).toEqual(["ko", "ja"]);

    await applyPatch(dir, patch.files);
    expect(await readFile(join(dir, "src/db.ts"), "utf8")).toContain("pg.Pool");
  });

  it("SQLite 경로를 지운 답은 이유를 알려 주고 다시 묻는다", async () => {
    const good = await patchedFiles();
    const bad = good.map((file) =>
      file.path === "src/db.ts"
        ? { ...file, content: file.content.replace(/import \{ DatabaseSync \} from "node:sqlite";\n/, "") .replace(/node:sqlite/g, "x") }
        : file,
    );
    const client = mockClient([
      { summary: { ko: "x", ja: "x" }, notes: [], files: bad },
      { summary: { ko: "고쳤습니다.", ja: "修正しました。" }, notes: [], files: good },
    ]);

    const patch = await createSqlitePatch(dir, resource, { client, updateLockfile: fakeLockfile });

    expect(patch.status).toBe("ready");
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1]!.messages[0]!.content).toContain("The SQLite code path was removed");
  });

  it("앱 밖 경로 · 설정 파일 수정은 받지 않고, 끝내 고치지 못하면 건너뛴다", async () => {
    const client = mockClient([
      { summary: { ko: "x", ja: "x" }, notes: [], files: [{ path: "../etc/passwd", content: "x" }, { path: "Dockerfile", content: "FROM x" }] },
    ]);

    const patch = await createSqlitePatch(dir, resource, { client, updateLockfile: fakeLockfile });

    expect(patch.status).toBe("skipped");
    if (patch.status !== "skipped") return;
    expect(patch.reason).toMatch(/^AI_INVALID_PATCH: /);
    expect(client.calls).toHaveLength(2);
  });

  it("접속 환경변수를 읽지 않는 답은 받지 않는다", async () => {
    const files = (await patchedFiles()).map((file) => ({ ...file, content: file.content.replaceAll("DATABASE_URL", "DB_URL") }));
    const client = mockClient([{ summary: { ko: "x", ja: "x" }, notes: [], files }]);

    const patch = await createSqlitePatch(dir, resource, { client, maxAttempts: 1, updateLockfile: fakeLockfile });

    expect(patch).toEqual({
      status: "skipped",
      reason: expect.stringContaining("never reads the DATABASE_URL"),
    });
  });

  it("AI 가 꺼져 있으면 건너뛴다", async () => {
    vi.stubEnv("AI_PROVIDER", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    const patch = await createSqlitePatch(dir, resource);

    expect(patch).toEqual({ status: "skipped", reason: expect.stringMatching(/^AI_DISABLED: /) });
  });

  it("lock 파일 갱신이 실패하면 수정안을 쓰지 않는다 (npm ci 가 깨지므로)", async () => {
    const client = mockClient([{ summary: { ko: "x", ja: "x" }, notes: [], files: await patchedFiles() }]);

    const patch = await createSqlitePatch(dir, resource, {
      client,
      updateLockfile: async () => {
        throw new Error("registry unreachable");
      },
    });

    expect(patch).toEqual({
      status: "skipped",
      reason: expect.stringMatching(/^DEPENDENCY_UPDATE_FAILED: .*registry unreachable/),
    });
  });
});
