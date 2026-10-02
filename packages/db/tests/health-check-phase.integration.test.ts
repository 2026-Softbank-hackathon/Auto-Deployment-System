import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "../src/index.js";

const databaseUrl = process.env["HEALTH_PHASE_TEST_DATABASE_URL"];
const schema = `health_phase_${randomUUID().replaceAll("-", "")}`;
let admin: Pool;
let pool: Pool;
let stepId: string;
let migration: string;

describe.skipIf(!databaseUrl)("health phase migration: isolated PostgreSQL", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    for (const file of ["001_initial.sql", "002_health_check_attempts.sql", "013_health_check_attempt_phase.sql"]) {
      await pool.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    }
    const project = await pool.query("INSERT INTO projects(name) VALUES($1) RETURNING id", [randomUUID()]);
    const deployment = await pool.query("INSERT INTO deployments(project_id,status) VALUES($1,'verifying') RETURNING id", [project.rows[0].id]);
    const step = await pool.query("INSERT INTO deployment_steps(deployment_id,step_name,status) VALUES($1,'verify','running') RETURNING id", [deployment.rows[0].id]);
    stepId = step.rows[0].id;
    await pool.query("INSERT INTO health_check_attempts(deployment_step_id,environment_id,attempt,checked_at,passed) VALUES($1,'31',1,NOW(),TRUE)", [stepId]);
    migration = await readFile(new URL("../migrations/014_health_check_legacy_unique.sql", import.meta.url), "utf8");
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it("실제 잘린 이름의 이전 제약조건을 제거하고 기록·phase별 중복 방지를 유지한다", async () => {
    const legacy = await pool.query("SELECT conname FROM pg_constraint WHERE conrelid='health_check_attempts'::regclass AND conname=$1", ["health_check_attempts_deployment_step_id_environment_id_att_key"]);
    expect(legacy.rowCount).toBe(1);
    await pool.query(migration);
    await pool.query(migration);
    await pool.query("INSERT INTO health_check_attempts(deployment_step_id,environment_id,phase,attempt,checked_at,passed) VALUES($1,'31','public_url',1,NOW(),TRUE)", [stepId]);
    const rows = await pool.query("SELECT phase,attempt,passed FROM health_check_attempts WHERE deployment_step_id=$1 ORDER BY phase", [stepId]);
    expect(rows.rows).toEqual([
      { phase: "public_url", attempt: 1, passed: true },
      { phase: "target", attempt: 1, passed: true },
    ]);
    await expect(pool.query("INSERT INTO health_check_attempts(deployment_step_id,environment_id,phase,attempt,checked_at,passed) VALUES($1,'31','public_url',1,NOW(),TRUE)", [stepId]))
      .rejects.toMatchObject({ code: "23505", constraint: "uq_health_check_attempts_phase_attempt" });
  });
});
