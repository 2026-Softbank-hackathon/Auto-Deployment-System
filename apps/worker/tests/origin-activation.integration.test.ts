import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "@camellia/db";
import type { WorkerDeps } from "../src/deps.js";
import type { VerifyJobPayload } from "../src/handlers/verify.js";
import { DeploymentOriginActivator } from "../src/origin-activation.js";
import { runVerifyJob } from "../src/verify-orchestrator.js";

const databaseUrl = process.env["ORIGIN_TEST_DATABASE_URL"];
const schema = `origin_test_${randomUUID().replaceAll("-", "")}`;
const originalFetch = globalThis.fetch;
const server = createServer((_request, response) => {
  response.writeHead(healthStatus);
  response.end("test app");
});
let healthStatus = 200;
let admin: Pool;
let pool: Pool;
let localBase: string;

describe.skipIf(!databaseUrl)("Verify → Origin: isolated PostgreSQL + HTTP", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    for (const file of [
      "001_initial.sql", "002_health_check_attempts.sql", "003_verify_job_idempotency.sql",
      "004_secrets_environments.sql", "006_deployment_environments.sql", "009_onprem_agent_jobs.sql",
    ]) {
      await pool.query(await readFile(new URL(`../../../packages/db/migrations/${file}`, import.meta.url), "utf8"));
    }
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP server unavailable");
    localBase = `http://127.0.0.1:${address.port}`;
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return originalFetch(`${localBase}${url.pathname}`, init);
    });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  async function fixture(type: "aws" | "onprem") {
    const project = await pool.query<{ id: string }>("INSERT INTO projects(name) VALUES($1) RETURNING id", [randomUUID()]);
    const projectId = project.rows[0]!.id;
    const environment = await pool.query<{ id: string }>(
      "INSERT INTO environments(project_id, name, type) VALUES($1, $2, $3) RETURNING id", [projectId, type, type],
    );
    const environmentId = environment.rows[0]!.id;
    const deployment = await pool.query<{ id: string }>(
      "INSERT INTO deployments(project_id, status, target_environment_id) VALUES($1, 'verifying', $2) RETURNING id",
      [projectId, environmentId],
    );
    const deploymentId = Number(deployment.rows[0]!.id);
    const targetUrl = type === "aws" ? "http://demo.ap-northeast-2.elb.amazonaws.com" : `https://verify-d${deploymentId}.example.com`;
    await pool.query("UPDATE deployments SET public_url = $1 WHERE id = $2", [targetUrl, deploymentId]);
    const digest = `sha256:${"a".repeat(64)}`;
    if (type === "onprem") {
      await pool.query(
        `INSERT INTO onprem_agent_jobs(job_id, deployment_id, environment_id, status, payload, result)
         VALUES($1, $2, $3, 'ready_for_verify', '{}', $4)`,
        [`agent-${deploymentId}`, deploymentId, environmentId, JSON.stringify({
          status: "ready_for_verify", deploymentId, environmentId,
          endpoint: targetUrl, localUrl: `${localBase}/`, runningDigest: digest,
        })],
      );
    }
    const payload: VerifyJobPayload = {
      jobId: `verify-${deploymentId}`, attempt: 1, deploymentId, environmentId,
      environmentType: type, serviceId: "api", targetUrl, expectedDigest: digest,
      health: { path: "/health", expectedStatus: 200, timeoutMs: 3000 },
    };
    return { projectId, payload };
  }

  it("On-Prem HTTP 성공 저장 → 동적 ingress → 고정 DNS, DNS 실패 후 헬스 재검사 없이 재시도", async () => {
    healthStatus = 200;
    const { projectId, payload } = await fixture("onprem");
    const calls: string[] = [];
    const cf = {
      ensureNamedTunnel: vi.fn(async () => ({ id: "tunnel-test", name: "test", endpoint: "tunnel-test.cfargotunnel.com" })),
      setTunnelOrigin: vi.fn(async (input: { serviceUrl: string }) => {
        const saved = await pool.query("SELECT status FROM deployment_steps WHERE job_id = $1", [payload.jobId]);
        expect(saved.rows[0].status).toBe("succeeded");
        expect(input.serviceUrl).toBe(localBase);
        calls.push("ingress");
      }),
      switchServiceOrigin: vi.fn().mockRejectedValueOnce(new Error("fake provider failure")).mockImplementation(async (input) => {
        expect(input.serviceHostname).toBe(`service-${projectId}.apps.example.com`);
        calls.push("dns");
      }),
    };
    const deps = { pool, originActivator: new DeploymentOriginActivator(pool, {
      cloudflare: cf, zoneId: "test-zone", platformDomain: "example.com",
    }) } as unknown as WorkerDeps;
    await expect(runVerifyJob({ data: payload }, deps, { sleep: async () => undefined })).rejects.toThrow("ORIGIN_CLOUDFLARE_FAILED");
    healthStatus = 503;
    await expect(runVerifyJob({ data: payload }, deps)).resolves.toMatchObject({ status: "passed" });
    const checks = await pool.query("SELECT count(*) AS count FROM health_check_attempts");
    expect(Number(checks.rows[0].count)).toBe(3);
    expect(calls).toEqual(["ingress", "ingress", "dns"]);
  });

  it("AWS HTTP 실패는 DB에 저장하고 기존 DNS는 변경하지 않는다", async () => {
    healthStatus = 503;
    const { payload } = await fixture("aws");
    const activate = vi.fn();
    const deps = { pool, originActivator: { activate } } as unknown as WorkerDeps;
    await expect(runVerifyJob({ data: payload }, deps, { sleep: async () => undefined })).resolves.toMatchObject({ status: "failed" });
    const step = await pool.query("SELECT status FROM deployment_steps WHERE job_id = $1", [payload.jobId]);
    expect(step.rows[0].status).toBe("failed");
    expect(activate).not.toHaveBeenCalled();
  });
});
