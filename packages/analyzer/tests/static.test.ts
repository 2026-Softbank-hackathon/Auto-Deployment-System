/**
 * packages/analyzer/tests/static.test.ts
 *
 * 정적 사이트 감지 (#272) — 루트 index.html 또는 서버 없는 프론트엔드 빌드 도구.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "../src/index.js";
import { IrSchema } from "@camellia/ir-schema";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const fixturesDir = resolve(__dirname, "fixtures");

const temporaryDirectories: string[] = [];

async function makeSource(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "camellia-static-"));
  temporaryDirectories.push(root);
  for (const [path, content] of Object.entries(files)) {
    const filePath = join(root, path);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, content);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("정적 사이트 감지", () => {
  it("루트 index.html 만 있는 소스 → static, 빌드 없음, 결과 폴더 '.'", async () => {
    const result = await analyze(resolve(fixturesDir, "static-plain"));

    expect(result.services).toHaveLength(1);
    expect(result.services[0]!.type).toBe("static");
    expect(result.ir_valid).toBe(true);

    const ir = IrSchema.parse(result.ir_draft);
    const [, service] = Object.entries(ir.services)[0]!;
    expect(service.type).toBe("static");
    expect(service.port).toBe(8080);
    expect(service.health.path).toBe("/");
    expect(service.command).toBeUndefined();
    expect(service.static).toEqual({ output_dir: ".", spa_fallback: true });
    // 서버가 없으니 command · port 를 AI 에게 물을 필요가 없다
    expect(result.unresolved.map((u) => u.path)).toEqual(["deploy.profile"]);
  });

  it("Vite + build 스크립트 + 서버 프레임워크 없음 → static, 패키지 매니저에 맞는 빌드 명령, dist", async () => {
    const result = await analyze(resolve(fixturesDir, "static-vite"));

    expect(result.services[0]!.type).toBe("static");
    const ir = IrSchema.parse(result.ir_draft);
    expect(ir.metadata).toMatchObject({ name: "vite-spa", version: "1.2.0" });
    const service = ir.services["vite-spa"]!;
    expect(service.static).toEqual({
      build_command: "pnpm run build",
      output_dir: "dist",
      spa_fallback: true,
    });
    expect(service.command).toBeUndefined();
    expect(service.env).toBeUndefined();
    expect(result.unresolved.map((u) => u.path)).toEqual(["deploy.profile"]);
  });

  it("Create React App → static, build 폴더, npm 빌드 명령", async () => {
    const result = await analyze(resolve(fixturesDir, "static-cra"));

    const ir = IrSchema.parse(result.ir_draft);
    const service = ir.services["cra-app"]!;
    expect(service.type).toBe("static");
    expect(service.static).toEqual({
      build_command: "npm run build",
      output_dir: "build",
      spa_fallback: true,
    });
  });

  it("vite.config 의 build.outDir 를 결과 폴더로 쓴다", async () => {
    const root = await makeSource({
      "package.json": JSON.stringify({
        name: "custom-out",
        scripts: { build: "vite build" },
        devDependencies: { vite: "^5.0.0" },
      }),
      "yarn.lock": "",
      "index.html": "<html></html>",
      "vite.config.ts": "export default { build: { outDir: 'public-dist' } };",
    });
    const result = await analyze(root);
    const ir = IrSchema.parse(result.ir_draft);
    const service = Object.values(ir.services)[0]!;
    expect(service.static).toEqual({
      build_command: "yarn build",
      output_dir: "public-dist",
      spa_fallback: true,
    });
  });

  it("서버 프레임워크(express)가 있으면 index.html 이 있어도 http", async () => {
    const root = await makeSource({
      "package.json": JSON.stringify({
        name: "server-app",
        scripts: { start: "node server.js", build: "vite build" },
        dependencies: { express: "^4.0.0" },
        devDependencies: { vite: "^5.0.0" },
      }),
      "index.html": "<html></html>",
      "server.js": "require('express')().listen(3000);",
    });
    const result = await analyze(root);
    expect(result.services[0]!.type).toBe("http");
    expect(result.services[0]!.port).toBe(3000);
  });

  it("package.json 에 start 서버만 있고 빌드 도구가 없으면 static 이 아님", async () => {
    const root = await makeSource({
      "package.json": JSON.stringify({ name: "plain-node", scripts: { start: "node server.js" } }),
      "server.js": "require('http').createServer().listen(4000);",
    });
    const result = await analyze(root);
    expect(result.services[0]!.type).not.toBe("static");
  });

  it("빌드 도구는 있지만 build 스크립트가 없으면 static 이 아님", async () => {
    const root = await makeSource({
      "package.json": JSON.stringify({ name: "no-build", devDependencies: { vite: "^5.0.0" } }),
      "index.html": "<html></html>",
    });
    const result = await analyze(root);
    expect(result.services[0]!.type).not.toBe("static");
  });

  it("package.json 이 있어도 서버 · 빌드 도구 없이 루트 index.html 이면 그대로 서빙하는 static", async () => {
    const root = await makeSource({
      "package.json": JSON.stringify({ name: "tooling-only", devDependencies: { prettier: "^3.0.0" } }),
      "index.html": "<html></html>",
    });
    const result = await analyze(root);
    const ir = IrSchema.parse(result.ir_draft);
    const service = Object.values(ir.services)[0]!;
    expect(service.type).toBe("static");
    expect(service.static).toEqual({ output_dir: ".", spa_fallback: true });
  });

  it("Python 소스는 index.html 이 있어도 static 이 아님", async () => {
    const root = await makeSource({
      "requirements.txt": "flask\n",
      "app.py": "from flask import Flask\napp = Flask(__name__)\n",
      "index.html": "<html></html>",
    });
    const result = await analyze(root);
    expect(result.services[0]!.type).not.toBe("static");
  });
});
