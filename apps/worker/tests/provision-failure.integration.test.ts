import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "@camellia/db";
import type { WorkerDeps } from "../src/deps.js";
import { handleProvision } from "../src/handlers/provision.js";

const databaseUrl = process.env["PROVISION_TEST_DATABASE_URL"];
const schema = `provision_test_${randomUUID().replaceAll("-", "")}`;
let admin: Pool;
let pool: Pool;

describe.skipIf(!databaseUrl)("Provision failure: isolated PostgreSQL", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    for (const file of ["001_initial.sql", "004_secrets_environments.sql", "006_deployment_environments.sql", "007_build_artifacts.sql", "019_deploy_mode.sql"]) {
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

  async function fixture(status = "planning") {
    const project = await pool.query<{ id: string }>("INSERT INTO projects(name) VALUES($1) RETURNING id", [randomUUID()]);
    const deployment = await pool.query<{ id: string }>(
      "INSERT INTO deployments(project_id, status) VALUES($1, $2) RETURNING id", [project.rows[0]!.id, status],
    );
    const deploymentId = Number(deployment.rows[0]!.id);
    await pool.query("INSERT INTO env_locks(env_key, deployment_id, lease_expires_at) VALUES($1, $2, NOW() + INTERVAL '1 hour')", [randomUUID(), deploymentId]);
    const notify = vi.fn(async () => undefined);
    const send = vi.fn(async () => "diagnose-job");
    const deps = { pool, notifier: { notify }, boss: { send }, storage: {} } as unknown as WorkerDeps;
    return { deploymentId, deps, notify, send };
  }

  async function state(deploymentId: number) {
    const result = await pool.query(
      `SELECT status, error, failed_at,
              (SELECT count(*) FROM env_locks WHERE deployment_id = deployments.id) AS lock_count
       FROM deployments WHERE id = $1`, [deploymentId],
    );
    return result.rows[0];
  }

  it("planning 실패를 저장하고 자신의 락만 삭제하며 중복 전달은 무해하다", async () => {
    const current = await fixture();
    const other = await fixture();
    await handleProvision({ data: { deployment_id: current.deploymentId } }, current.deps);
    expect(await state(current.deploymentId)).toMatchObject({
      status: "failed", error: "PROVISION_STATE_INVALID", lock_count: "0",
    });
    expect((await state(current.deploymentId)).failed_at).toBeInstanceOf(Date);
    expect((await state(other.deploymentId)).lock_count).toBe("1");
    await handleProvision({ data: { deployment_id: current.deploymentId } }, current.deps);
    expect(current.notify.mock.calls.filter(([, event]) => event === "state_changed")).toHaveLength(1);
    expect(current.send).toHaveBeenCalledTimes(1);
  });

  it("락 삭제가 실패하면 DB 상태 전이도 롤백한다", async () => {
    const current = await fixture();
    await pool.query(`CREATE FUNCTION reject_unlock() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'test cleanup failure'; END $$`);
    await pool.query("CREATE TRIGGER reject_unlock BEFORE DELETE ON env_locks FOR EACH ROW EXECUTE FUNCTION reject_unlock()");
    try {
      await expect(handleProvision({ data: { deployment_id: current.deploymentId } }, current.deps)).rejects.toThrow("test cleanup failure");
      expect(await state(current.deploymentId)).toMatchObject({
        status: "planning", error: null, failed_at: null, lock_count: "1",
      });
      expect(current.notify).not.toHaveBeenCalledWith(current.deploymentId, "state_changed", { status: "failed" });
      expect(current.send).not.toHaveBeenCalled();
    } finally {
      await pool.query("DROP TRIGGER reject_unlock ON env_locks");
      await pool.query("DROP FUNCTION reject_unlock()");
    }
    await handleProvision({ data: { deployment_id: current.deploymentId } }, current.deps);
    expect((await state(current.deploymentId)).status).toBe("failed");
    expect((await state(current.deploymentId)).lock_count).toBe("0");
  });

  it("취소된 배포의 지연 Job은 terminal 상태와 락에 손대지 않는다", async () => {
    const current = await fixture("cancelled");
    await handleProvision({ data: { deployment_id: current.deploymentId } }, current.deps);
    expect(await state(current.deploymentId)).toMatchObject({ status: "cancelled", error: null, lock_count: "1" });
    expect(current.notify).not.toHaveBeenCalled();
    expect(current.send).not.toHaveBeenCalled();
  });
});
