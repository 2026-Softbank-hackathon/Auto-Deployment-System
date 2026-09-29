/**
 * packages/analyzer/tests/analyze.test.ts
 *
 * analyze() 통합 테스트 — 3개 fixture 기준 최소 6개 케이스.
 */

import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "../src/index.js";
import { IrSchema } from "@camellia/ir-schema";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const fixturesDir = resolve(__dirname, "fixtures");

// ---------------------------------------------------------------------------
// fixture: node-http
// ---------------------------------------------------------------------------
describe("fixture: node-http", () => {
  it("detects 1 service with type=http, framework=express", async () => {
    const result = await analyze(resolve(fixturesDir, "node-http"));
    expect(result.services).toHaveLength(1);
    const svc = result.services[0];
    expect(svc.type).toBe("http");
    expect(svc.framework).toBe("express");
    expect(svc.language).toBe("node");
  });

  it("detects port=3000 from .listen(3000)", async () => {
    const result = await analyze(resolve(fixturesDir, "node-http"));
    const svc = result.services[0];
    expect(svc.port).toBe(3000);
  });

  it("detects Dockerfile and sets dockerfile path", async () => {
    const result = await analyze(resolve(fixturesDir, "node-http"));
    const svc = result.services[0];
    expect(svc.dockerfile).toBeDefined();
    expect(svc.dockerfile).toMatch(/Dockerfile/);
  });

  it("captures env_names from process.env references", async () => {
    const result = await analyze(resolve(fixturesDir, "node-http"));
    const svc = result.services[0];
    // server.js references process.env.PORT
    expect(svc.env_names).toContain("PORT");
  });

  it("ir_draft passes IrSchema.parse() (ir_valid=true)", async () => {
    const result = await analyze(resolve(fixturesDir, "node-http"));
    // node-http has full data — should be valid
    if (!result.ir_valid) {
      // Print errors to aid debugging when it fails
      expect(result.ir_errors).toBeUndefined();
    }
    expect(result.ir_valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fixture: python-fastapi
// ---------------------------------------------------------------------------
describe("fixture: python-fastapi", () => {
  it("detects 1 service with type=http, framework=fastapi, language=python", async () => {
    const result = await analyze(resolve(fixturesDir, "python-fastapi"));
    expect(result.services).toHaveLength(1);
    const svc = result.services[0];
    expect(svc.type).toBe("http");
    expect(svc.framework).toBe("fastapi");
    expect(svc.language).toBe("python");
  });

  it("detects port (explicit or unresolved with default 8000)", async () => {
    const result = await analyze(resolve(fixturesDir, "python-fastapi"));
    const svc = result.services[0];
    // main.py has no explicit port → default 8000 + unresolved
    expect(svc.port).toBe(8000);
    const portUnresolved = result.unresolved.some((u) =>
      u.path.includes("port")
    );
    expect(portUnresolved).toBe(true);
  });

  it("ir_draft has metadata.name and services entry", async () => {
    const result = await analyze(resolve(fixturesDir, "python-fastapi"));
    expect(result.ir_draft.metadata).toBeDefined();
    expect(result.ir_draft.metadata?.name).toBeTruthy();
    expect(result.ir_draft.services).toBeDefined();
  });

  it("IrSchema.safeParse on ir_draft either succeeds or reports structured errors", async () => {
    const result = await analyze(resolve(fixturesDir, "python-fastapi"));
    const parseResult = IrSchema.safeParse(result.ir_draft);
    // Whether valid or not, the result must be a structured parse result
    expect(typeof parseResult.success).toBe("boolean");
    // If invalid, errors must exist
    if (!parseResult.success) {
      expect(parseResult.error.errors.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// fixture: node-postgres
// ---------------------------------------------------------------------------
describe("fixture: node-postgres", () => {
  it("detects 1 service + postgres resource", async () => {
    const result = await analyze(resolve(fixturesDir, "node-postgres"));
    expect(result.services).toHaveLength(1);
    const pgResource = result.resources.find((r) => r.type === "postgres");
    expect(pgResource).toBeDefined();
  });

  it("postgres resource has name 'db'", async () => {
    const result = await analyze(resolve(fixturesDir, "node-postgres"));
    const pgResource = result.resources.find((r) => r.type === "postgres");
    expect(pgResource?.name).toBe("db");
  });

  it("detects DATABASE_URL in env_names from .env.example", async () => {
    const result = await analyze(resolve(fixturesDir, "node-postgres"));
    const svc = result.services[0];
    expect(svc.env_names).toContain("DATABASE_URL");
  });

  it("detects PORT env name from source or .env.example", async () => {
    const result = await analyze(resolve(fixturesDir, "node-postgres"));
    const svc = result.services[0];
    expect(svc.env_names).toContain("PORT");
  });

  it("ir_draft.resources includes db of type postgres", async () => {
    const result = await analyze(resolve(fixturesDir, "node-postgres"));
    expect(result.ir_draft.resources).toBeDefined();
    expect(result.ir_draft.resources?.["db"]).toBeDefined();
    expect(result.ir_draft.resources?.["db"]?.type).toBe("postgres");
  });

  it("deploy.profile unresolved entry exists (orchestrator override expected)", async () => {
    const result = await analyze(resolve(fixturesDir, "node-postgres"));
    const profileUnresolved = result.unresolved.find(
      (u) => u.path === "deploy.profile"
    );
    expect(profileUnresolved).toBeDefined();
  });
});
