import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stage } from "../../src/stager.js";
import { countDiffLines, createUnifiedDiff } from "../../src/patch/unified-diff.js";
import { zipDirectory } from "../../src/patch/zip.js";
import { addNodePostgresDependencies, addPythonPostgresRequirement } from "../../src/patch/dependencies.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("createUnifiedDiff", () => {
  it("바뀐 줄 앞뒤 3줄을 hunk 로 묶고, 떨어진 변경은 hunk 를 나눈다", () => {
    const lines = Array.from({ length: 15 }, (_, index) => `l${index + 1}`);
    const before = lines.join("\n") + "\n";
    const after = [...lines.slice(0, 4), "L5", ...lines.slice(5), "l16"].join("\n") + "\n";

    expect(createUnifiedDiff("x.txt", before, after)).toBe(
      [
        "--- a/x.txt",
        "+++ b/x.txt",
        "@@ -2,7 +2,7 @@",
        " l2", " l3", " l4", "-l5", "+L5", " l6", " l7", " l8",
        "@@ -13,3 +13,4 @@",
        " l13", " l14", " l15", "+l16",
        "",
      ].join("\n"),
    );
  });

  it("가까운 변경은 git 처럼 한 hunk 로 합친다", () => {
    const diff = createUnifiedDiff("x", "a\nb\nc\nd\ne\nf\n", "a\nB\nc\nd\ne\nF\n");
    expect(diff.match(/^@@/gm)).toHaveLength(1);
    expect(diff).toContain("@@ -1,6 +1,6 @@");
  });

  it("새 파일은 /dev/null 에서, 같은 내용은 빈 문자열", () => {
    expect(createUnifiedDiff("n.ts", null, "x\ny\n")).toBe("--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,2 @@\n+x\n+y\n");
    expect(createUnifiedDiff("n.ts", "x\n", "x\n")).toBe("");
  });

  it("더한 줄 · 뺀 줄을 센다", () => {
    expect(countDiffLines(createUnifiedDiff("x", "a\nb\n", "a\nc\nd\n"))).toEqual({ additions: 2, deletions: 1 });
  });
});

describe("zipDirectory", () => {
  it("stage(unzip) 로 풀면 같은 파일 · 같은 내용 (바이너리 포함), 같은 폴더는 같은 zip", async () => {
    const source = await mkdtemp(join(tmpdir(), "camellia-zip-"));
    dirs.push(source);
    await mkdir(join(source, "src"), { recursive: true });
    await mkdir(join(source, "data"), { recursive: true });
    await writeFile(join(source, "package.json"), '{"name":"x"}\n');
    await writeFile(join(source, "src", "한글.ts"), "export const a = 1;\n".repeat(50));
    await writeFile(join(source, "data", "app.db"), Buffer.from([0, 1, 2, 3, 255, 254]));

    const zip = await zipDirectory(source);
    expect((await zipDirectory(source)).equals(zip)).toBe(true);

    const zipPath = join(source, "..", `${source.split(/[\\/]/).pop()}.zip`);
    await writeFile(zipPath, zip);
    const staged = await stage(zipPath, { mode: "unzip", destDir: `${source}-out` });
    dirs.push(`${source}-out`, zipPath);
    expect(await readFile(join(staged.resolvedPath, "package.json"), "utf8")).toBe('{"name":"x"}\n');
    expect(await readFile(join(staged.resolvedPath, "src", "한글.ts"), "utf8")).toBe("export const a = 1;\n".repeat(50));
    expect([...(await readFile(join(staged.resolvedPath, "data", "app.db")))]).toEqual([0, 1, 2, 3, 255, 254]);
  });
});

describe("의존성 규칙", () => {
  it("pg · @types/pg 를 더하고 들여쓰기를 유지한다", () => {
    const before = JSON.stringify({ name: "x", dependencies: { hono: "^4" }, devDependencies: { typescript: "^5" } }, null, 2) + "\n";

    const result = addNodePostgresDependencies(before, { typescript: true });

    expect(result.changed).toBe(true);
    expect(JSON.parse(result.text)).toMatchObject({
      dependencies: { hono: "^4", pg: "^8.23.1" },
      devDependencies: { typescript: "^5", "@types/pg": "^8.23.1" },
    });
    expect(result.text.startsWith('{\n  "name"')).toBe(true);
    expect(addNodePostgresDependencies(result.text, { typescript: true }).changed).toBe(false);
  });

  it("esbuild ESM 번들 스크립트에는 createRequire 배너를 붙인다", () => {
    const before = JSON.stringify({
      scripts: { build: "tsc --noEmit && esbuild src/server.ts --bundle --platform=node --format=esm --outfile=dist/server.js" },
    });

    const result = addNodePostgresDependencies(before, { typescript: false });

    expect(JSON.parse(result.text).scripts.build).toContain(
      `--banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"`,
    );
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toEqual({
      ko: expect.stringContaining("createRequire"),
      ja: expect.stringContaining("createRequire"),
    });
  });

  it("requirements.txt 에 psycopg 를 한 번만 더한다", () => {
    const first = addPythonPostgresRequirement("flask==3.0\n");
    expect(first).toEqual({ text: "flask==3.0\npsycopg[binary]>=3.2\n", changed: true });
    expect(addPythonPostgresRequirement(first.text).changed).toBe(false);
    expect(addPythonPostgresRequirement("psycopg2-binary\n").changed).toBe(false);
  });
});
