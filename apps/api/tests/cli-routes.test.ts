/**
 * CLI 지원 (UI-02) — 명령 목록이 실제 API 를 가리키는지, 토큰 발급이 되는지.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "@camellia/db";
import type PgBoss from "pg-boss";
import type { Storage } from "@camellia/storage";
import { buildServer } from "../src/server.js";
import { CLI_MANIFEST } from "../src/cli/manifest.js";
import { MockPgBoss, MockPool, MockStorage } from "./mocks/db.js";

let server: FastifyInstance | null = null;

async function start(apiKey?: string) {
  server = await buildServer({
    pool: new MockPool() as unknown as Pool,
    boss: new MockPgBoss() as unknown as PgBoss,
    storage: new MockStorage() as unknown as Storage,
    nodeEnv: "development",
    logger: false,
    enablePgListener: false,
    apiKey,
  });
  await server.ready();
  return server;
}

afterEach(async () => {
  await server?.close();
  server = null;
});

/** "/projects/{app.live.deploymentId}/env" → "/api/v1/projects/1/env" (쿼리 제외) */
function concrete(path: string): string {
  return `/api/v1${path.split("?")[0]!.replace(/\{[\w.]+\}/g, "1")}`;
}

describe("GET /cli/manifest", () => {
  it("명령 목록을 준다", async () => {
    const app = await start();
    const res = await app.inject({ method: "GET", url: "/api/v1/cli/manifest" });
    expect(res.statusCode).toBe(200);
    expect(res.json().commands.map((command: { name: string }) => command.name)).toContain("deploy");
  });

  it("모든 명령 · resolver · follower 경로가 등록된 라우트다", async () => {
    const app = await start();
    const targets = [
      ...CLI_MANIFEST.commands.map((command) => ({ method: command.request.method, url: concrete(command.request.path), name: command.name })),
      ...Object.entries(CLI_MANIFEST.resolvers).map(([name, resolver]) => ({ method: "GET" as const, url: concrete(resolver.list), name })),
      { method: "GET" as const, url: concrete(CLI_MANIFEST.followers.deployment.status), name: "follow status" },
      { method: "POST" as const, url: concrete(CLI_MANIFEST.followers.deployment.approvals), name: "follow approvals" },
    ];
    const missing = targets.filter((target) => !app.findRoute({ method: target.method, url: target.url.replace(/\/1(?=\/|$)/g, "/:id") }) && !app.hasRoute({ method: target.method, url: target.url }));
    // findRoute 는 파라미터 이름까지 맞아야 해서, 실제 요청으로 404(라우트 없음)인지 다시 본다
    const reallyMissing: string[] = [];
    for (const target of missing) {
      const res = await app.inject({ method: target.method, url: target.url, payload: target.method === "GET" || target.method === "DELETE" ? undefined : {} });
      if (res.statusCode === 404 && /Route .* not found/i.test(res.body)) reallyMissing.push(`${target.name}: ${target.method} ${target.url}`);
    }
    expect(reallyMissing).toEqual([]);
  });

  it("인자 이름이 겹치지 않고, 위치 인자 순서가 0부터 이어진다", () => {
    for (const command of CLI_MANIFEST.commands) {
      const names = command.args.map((arg) => arg.name);
      expect(new Set(names).size, command.name).toBe(names.length);
      const positions = command.args.filter((arg) => arg.positional !== undefined).map((arg) => arg.positional).sort();
      expect(positions, command.name).toEqual(positions.map((_, index) => index));
      for (const arg of command.args) {
        expect(arg.positional !== undefined || Boolean(arg.flag), `${command.name} ${arg.name}`).toBe(true);
        if (arg.resolver) expect(CLI_MANIFEST.resolvers[arg.resolver], `${command.name} ${arg.name}`).toBeDefined();
      }
    }
  });
});

describe("POST /cli/token", () => {
  it("API Key 로 인증한 요청에 30일 토큰을 주고, 그 토큰으로 API 를 부를 수 있다", async () => {
    const app = await start("test-api-key");
    const res = await app.inject({ method: "POST", url: "/api/v1/cli/token", headers: { "x-api-key": "test-api-key" } });
    expect(res.statusCode).toBe(201);
    const { token, expiresAt } = res.json();
    const days = (new Date(expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    const manifest = await app.inject({ method: "GET", url: "/api/v1/cli/manifest", headers: { authorization: `Bearer ${token}` } });
    expect(manifest.statusCode).toBe(200);
  });

  it("인증 없이는 401", async () => {
    const app = await start("test-api-key");
    const res = await app.inject({ method: "POST", url: "/api/v1/cli/token" });
    expect(res.statusCode).toBe(401);
  });
});
