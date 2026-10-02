/**
 * apps/worker/tests/address-change.integration.test.ts
 * 앱 주소 변경 (#301) — 실제 PostgreSQL 에서 서비스 중인 배포 · IR 을 읽고 성공 · 실패를 기록하는지.
 * TEARDOWN_TEST_DATABASE_URL 이 있을 때만 실행 (격리 schema 생성 후 삭제).
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "@camellia/db";
import { MIGRATION_FILES } from "@camellia/db/migrations";
import type { WorkerDeps } from "../src/deps.js";
import { handleAddressChange } from "../src/handlers/address-change.js";

const databaseUrl = process.env["TEARDOWN_TEST_DATABASE_URL"];
const schema = `address_change_${randomUUID().replaceAll("-", "")}`;
const IR = {
  $ir_version: "0.1.0",
  metadata: { name: "todo", version: "1.0.0" },
  services: {
    api: {
      type: "http", port: 3000, expose: "public", size: "small",
      health: { path: "/ready", expected_status: 200, timeout_seconds: 3 },
    },
  },
  deploy: { profile: "aws-ecs-basic" },
};

let admin: Pool;
let pool: Pool;

describe.skipIf(!databaseUrl)("address-change (#301): isolated PostgreSQL", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    for (const file of MIGRATION_FILES) {
      await pool.query(await readFile(new URL(`../../../packages/db/migrations/${file}`, import.meta.url), "utf8"));
    }
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  async function changingProject(name: string, to: string): Promise<number> {
    const project = await pool.query<{ id: string }>(
      `INSERT INTO projects (name, address_change_status, address_change_from, address_change_to, address_change_requested_at)
       VALUES ($1, 'changing', 'old', $2, NOW()) RETURNING id`,
      [name, to],
    );
    const projectId = Number(project.rows[0]!.id);
    await pool.query(`UPDATE projects SET subdomain = $2, address_change_from = $2 WHERE id = $1`, [projectId, `${name}-old`]);
    const deployment = await pool.query<{ id: string }>(
      `INSERT INTO deployments (project_id, status, target_profile, succeeded_at)
       VALUES ($1, 'succeeded', 'aws-ecs-basic', NOW()) RETURNING id`,
      [projectId],
    );
    await pool.query(
      `INSERT INTO ir_versions (deployment_id, ir_json, source) VALUES ($1, $2, 'analyzer')`,
      [deployment.rows[0]!.id, JSON.stringify(IR)],
    );
    return projectId;
  }

  function deps(passed: boolean): WorkerDeps {
    return {
      pool,
      boss: {},
      storage: {},
      originActivator: {
        addServiceAlias: vi.fn(async (input: { toSubdomain: string }) => ({
          hostname: `${input.toSubdomain}.example.com`, previousHostname: "old.example.com",
          origin: "alb.elb.amazonaws.com", tunnelIngress: null,
        })),
        removeServiceAlias: vi.fn(async () => undefined),
        removeServiceHostname: vi.fn(async () => []),
      },
      finalUrlVerifier: {
        verify: vi.fn(async (input: { health: { path: string } }) => ({
          deploymentId: 1, environmentId: "", status: passed ? "passed" : "failed",
          targetUrl: `https://x${input.health.path}`, checks: [], consecutivePassed: 0, requiredPasses: 3,
          startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 1,
          ...(passed ? {} : { failureReason: "timeout" }),
        })),
      },
    } as unknown as WorkerDeps;
  }

  it("성공하면 subdomain 을 바꾸고 succeeded", async () => {
    const projectId = await changingProject("ok-app", "ok-new");
    const d = deps(true);

    await handleAddressChange({ data: { project_id: projectId } }, d, { sleep: async () => undefined });

    const row = await pool.query(`SELECT subdomain, address_change_status, address_change_finished_at FROM projects WHERE id = $1`, [projectId]);
    expect(row.rows[0]).toMatchObject({ subdomain: "ok-new", address_change_status: "succeeded" });
    expect(row.rows[0].address_change_finished_at).toBeInstanceOf(Date);
    expect(d.finalUrlVerifier!.verify).toHaveBeenCalledWith(
      expect.objectContaining({ health: { path: "/ready", expectedStatus: 200, timeoutMs: 3000 } }),
      expect.anything(),
    );
    expect(d.originActivator!.removeServiceHostname).toHaveBeenCalledWith({ projectId, subdomain: "ok-app-old" });
  });

  it("실패하면 예전 주소를 그대로 두고 failed + 이유", async () => {
    const projectId = await changingProject("bad-app", "bad-new");

    await handleAddressChange({ data: { project_id: projectId } }, deps(false), { sleep: async () => undefined });

    const row = await pool.query(`SELECT subdomain, address_change_status, address_change_error FROM projects WHERE id = $1`, [projectId]);
    expect(row.rows[0]).toEqual({
      subdomain: "bad-app-old", address_change_status: "failed", address_change_error: "ADDRESS_VERIFY_FAILED\ntimeout",
    });
  });
});
