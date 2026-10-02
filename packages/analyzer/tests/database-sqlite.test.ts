/**
 * SQLite 사용 감지 (#276) — 의존성 · 코드 · Prisma 스키마에서 SQLite 를 찾으면
 * PostgreSQL 리소스(연결 환경변수 DATABASE_URL, 로컬 대체 저장소 sqlite)를 제안한다.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectDatabase } from "../src/detectors/database.js";
import { analyze } from "../src/index.js";

const dirs: string[] = [];

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "camellia-sqlite-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("detectDatabase — SQLite 사용 감지", () => {
  it("better-sqlite3 의존성과 그것을 쓰는 소스 파일을 찾는다", async () => {
    const dir = await project({
      "db.js": `const Database = require("better-sqlite3");\nconst db = new Database("data/app.db");\n`,
      "server.js": `const db = require("./db");\n`,
      "data/app.db": "SQLite format 3\u0000",
    });

    const result = await detectDatabase(dir, { "better-sqlite3": "^11.0.0", express: "^4" }, []);

    expect(result.resources).toHaveLength(1);
    const db = result.resources[0]!;
    expect(db).toMatchObject({
      name: "db",
      type: "postgres",
      connection_env: "DATABASE_URL",
      local_fallback: "sqlite",
    });
    expect(db.sqlite?.libraries).toEqual(["better-sqlite3"]);
    expect(db.sqlite?.sources).toEqual(["db.js"]);
    expect(db.sqlite?.files).toEqual(["data/app.db"]);
    expect(result.warnings.map((w) => w.code)).toContain("ANL-06-SQLITE");
  });

  it("의존성이 없어도 node:sqlite import 를 찾는다", async () => {
    const dir = await project({
      "src/db.ts": `import { DatabaseSync } from "node:sqlite";\nexport const db = new DatabaseSync("data/x.db");\n`,
    });

    const result = await detectDatabase(dir, { hono: "^4" }, []);

    expect(result.resources[0]).toMatchObject({ type: "postgres", local_fallback: "sqlite" });
    expect(result.resources[0]!.sqlite?.libraries).toEqual(["node:sqlite"]);
    expect(result.resources[0]!.sqlite?.sources).toEqual(["src/db.ts"]);
  });

  it("Python sqlite3 모듈 사용을 찾는다", async () => {
    const dir = await project({
      "app.py": `import sqlite3\nconn = sqlite3.connect("app.db")\n`,
      "requirements.txt": "flask\n",
    });

    const result = await detectDatabase(dir, {}, ["flask"]);

    expect(result.resources[0]).toMatchObject({ type: "postgres", local_fallback: "sqlite" });
    expect(result.resources[0]!.sqlite?.sources).toEqual(["app.py"]);
  });

  it("Prisma 스키마의 sqlite provider 를 찾는다", async () => {
    const dir = await project({
      "prisma/schema.prisma": `datasource db {\n  provider = "sqlite"\n  url      = "file:./dev.db"\n}\n`,
    });

    const result = await detectDatabase(dir, { "@prisma/client": "^5" }, []);

    expect(result.resources[0]).toMatchObject({ type: "postgres", local_fallback: "sqlite" });
    expect(result.resources[0]!.sqlite?.libraries).toEqual(["prisma (sqlite)"]);
  });

  it(".db 파일만 있고 코드에서 쓰지 않으면 경고만 남기고 리소스는 만들지 않는다", async () => {
    const dir = await project({
      "server.js": `console.log("hi")\n`,
      "backup/old.sqlite": "x",
    });

    const result = await detectDatabase(dir, { express: "^4" }, []);

    expect(result.resources).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toEqual(["ANL-06-SQLITE-FILE"]);
  });

  it("pg 만 쓰는 앱은 지금처럼 로컬 대체 저장소 없는 postgres", async () => {
    const dir = await project({ "server.js": `const { Pool } = require("pg");\n` });

    const result = await detectDatabase(dir, { pg: "^8" }, []);

    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]!.type).toBe("postgres");
    expect(result.resources[0]!.local_fallback).toBeUndefined();
  });
});

describe("analyze — SQLite 앱의 IR", () => {
  it("IR resources 에 연결 환경변수와 로컬 대체 저장소를 기록한다", async () => {
    const dir = await project({
      "package.json": JSON.stringify({
        name: "guestbook",
        version: "1.0.0",
        scripts: { start: "node server.js" },
        dependencies: { express: "^4", "better-sqlite3": "^11" },
      }),
      "server.js": `const express = require("express");\nconst Database = require("better-sqlite3");\nconst db = new Database("app.db");\nexpress().listen(3000);\n`,
    });

    const result = await analyze(dir);

    expect(result.ir_valid, JSON.stringify(result.ir_errors)).toBe(true);
    expect(result.ir_draft.resources).toEqual({
      db: { type: "postgres", connection_env: "DATABASE_URL", local_fallback: "sqlite" },
    });
  });

  it("샘플 앱 apps/samples/sqlite-web 을 SQLite 앱으로 본다", async () => {
    const sample = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../apps/samples/sqlite-web");

    const result = await analyze(sample);

    expect(result.ir_valid, JSON.stringify(result.ir_errors)).toBe(true);
    expect(result.ir_draft.resources?.["db"]).toEqual({
      type: "postgres",
      connection_env: "DATABASE_URL",
      local_fallback: "sqlite",
    });
    const db = result.resources[0]!;
    expect(db.sqlite?.libraries).toEqual(["node:sqlite"]);
    expect(db.sqlite?.sources).toEqual(["src/db.ts"]);
    expect(db.sqlite?.files).toEqual(["data/guestbook.db"]);
    const svc = Object.values(result.ir_draft.services ?? {})[0]!;
    expect(svc.port).toBe(3000);
    expect(svc.health.path).toBe("/health");
    // 접속 정보는 플랫폼이 주입하므로 앱이 등록해야 할 환경변수로 요구하지 않는다
    expect(svc.env ?? []).not.toContain("DATABASE_URL");
  });
});
