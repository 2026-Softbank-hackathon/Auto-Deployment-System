/**
 * risk-checker.test.ts
 * ANL-06 하드코딩 시크릿 + Dockerfile 루트 실행 검출 단위 테스트.
 */

import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkRisks } from "../src/risk-checker.js";

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, body);
  }
}

describe("risk-checker (ANL-06)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "risk-checker-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("깨끗한 프로젝트는 경고 0개", async () => {
    await writeFiles(dir, {
      "app.js": `console.log("hello");\nconst x = 1;\n`,
      "Dockerfile": `FROM node:20\nUSER node\nCMD ["node","app.js"]\n`,
    });
    const res = await checkRisks(dir);
    expect(res.warnings).toEqual([]);
  });

  it("AWS Access Key ID 하드코딩 감지", async () => {
    await writeFiles(dir, {
      "config.js": `const key = "AKIAIOSFODNN7EXAMPLE";\n`,
    });
    const res = await checkRisks(dir);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]?.code).toBe("ANL-06-HARDCODED-SECRET");
    expect(res.warnings[0]?.path).toMatch(/config\.js:1/);
    // 값 자체는 메시지에 포함되지 않아야 함 (D-50)
    expect(res.warnings[0]?.message).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("password = '...' 하드코딩 감지", async () => {
    await writeFiles(dir, {
      "db.py": `PASSWORD = "supersecret123"\n`,
    });
    const res = await checkRisks(dir);
    expect(res.warnings.length).toBeGreaterThanOrEqual(1);
    expect(res.warnings[0]?.code).toBe("ANL-06-HARDCODED-SECRET");
    expect(res.warnings[0]?.message).not.toContain("supersecret123");
  });

  it("PEM 개인키 감지", async () => {
    await writeFiles(dir, {
      "keys.txt.yml": `note: "-----BEGIN RSA PRIVATE KEY-----"\n`,
    });
    const res = await checkRisks(dir);
    expect(res.warnings.some((w) => w.code === "ANL-06-HARDCODED-SECRET")).toBe(true);
  });

  it("Dockerfile 에 USER 없으면 루트 실행 경고", async () => {
    await writeFiles(dir, {
      "Dockerfile": `FROM node:20\nCOPY . /app\nCMD ["node","app.js"]\n`,
    });
    const res = await checkRisks(dir);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]?.code).toBe("ANL-06-DOCKER-ROOT");
    expect(res.warnings[0]?.path).toBe("Dockerfile");
  });

  it("Dockerfile 마지막 USER 가 root 이면 경고", async () => {
    await writeFiles(dir, {
      "Dockerfile": `FROM node:20\nUSER node\nUSER root\nCMD ["node","app.js"]\n`,
    });
    const res = await checkRisks(dir);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]?.code).toBe("ANL-06-DOCKER-ROOT");
  });

  it("node_modules 는 스캔하지 않는다", async () => {
    await writeFiles(dir, {
      "node_modules/pkg/leaked.js": `const key = "AKIAIOSFODNN7EXAMPLE";\n`,
    });
    const res = await checkRisks(dir);
    expect(res.warnings).toEqual([]);
  });

  it("하위 디렉터리 파일 경고 경로는 OS 와 무관하게 / 구분", async () => {
    await writeFiles(dir, {
      "src/config.js": `const key = "AKIAIOSFODNN7EXAMPLE";\n`,
      "docker/Dockerfile": `FROM node:20\nCMD ["node","app.js"]\n`,
    });
    const res = await checkRisks(dir);
    expect(res.warnings.map((w) => w.path).sort()).toEqual(["docker/Dockerfile", "src/config.js:1"]);
  });
});
