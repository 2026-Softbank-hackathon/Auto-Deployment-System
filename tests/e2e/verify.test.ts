import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Pool } from "@camellia/db";
import type { WorkerDeps } from "../../apps/worker/src/deps.js";
import type { VerifyJobPayload } from "../../apps/worker/src/handlers/verify.js";
import { runVerifyJob } from "../../apps/worker/src/verify-orchestrator.js";

const describeWithPostgres =
  process.env["SKIP_E2E"] === "true" ? describe.skip : describe;

describeWithPostgres("Verify 실제 Postgres 통합", () => {
  let pool: Pool;
  let server: Server;
  let targetUrl: string;
  let deploymentId: number;
  let requestCount = 0;

  beforeAll(async () => {
    pool = createPool(process.env["DATABASE_URL"]!);
    server = createServer((_request, response) => {
      requestCount += 1;
      response.writeHead(200);
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("테스트 HTTP 서버 주소를 확인할 수 없음");
    }
    targetUrl = `http://127.0.0.1:${address.port}`;

    const project = await pool.query<{ id: string }>(
      `INSERT INTO projects(name, description)
       VALUES ($1, $2)
       RETURNING id`,
      [`verify-e2e-${crypto.randomUUID()}`, "verify integration test"],
    );
    const deployment = await pool.query<{ id: string }>(
      `INSERT INTO deployments(project_id, status, public_url)
       VALUES ($1, 'verifying', $2)
       RETURNING id`,
      [Number(project.rows[0]!.id), targetUrl],
    );
    deploymentId = Number(deployment.rows[0]!.id);
  });

  afterAll(async () => {
    if (deploymentId) {
      await pool.query("DELETE FROM deployments WHERE id = $1", [deploymentId]);
    }
    await pool?.end();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("동일 job을 재실행해도 단계·시도·HTTP 요청을 중복 생성하지 않음", async () => {
    const payload: VerifyJobPayload = {
      jobId: `verify-job-${crypto.randomUUID()}`,
      attempt: 1,
      deploymentId,
      environmentId: "env-aws-e2e",
      environmentType: "aws",
      serviceId: "api",
      targetUrl,
      health: {
        path: "/health",
        expectedStatus: 200,
        timeoutMs: 3_000,
      },
    };
    const deps: WorkerDeps = {
      pool,
      boss: {} as WorkerDeps["boss"],
      storage: {} as WorkerDeps["storage"],
    };
    const runtime = { sleep: async () => undefined };

    const first = await runVerifyJob({ data: payload }, deps, runtime);
    const repeated = await runVerifyJob(
      { data: { ...payload, attempt: 2 } },
      deps,
      runtime,
    );

    expect(first.status, JSON.stringify(first)).toBe("passed");
    expect(repeated).toEqual(first);
    expect(requestCount).toBe(3);

    const steps = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM deployment_steps
       WHERE job_id = $1 AND step_name = 'verify'`,
      [payload.jobId],
    );
    const attempts = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM health_check_attempts h
       JOIN deployment_steps s ON s.id = h.deployment_step_id
       WHERE s.job_id = $1`,
      [payload.jobId],
    );
    expect(steps.rows[0]?.count).toBe("1");
    expect(attempts.rows[0]?.count).toBe("3");
  });
});
