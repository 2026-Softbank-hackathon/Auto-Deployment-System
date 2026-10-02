/**
 * packages/db/tests/platform-deploy-record.test.ts
 * 플랫폼 CD 기록 (#310): infra/platform/scripts/deploy.sh 가 psql 변수로 record-deploy.sql 을 실행해
 * platform_deploys 에 시작 · 끝을 남긴다.
 *
 * - 정적: SQL 이 쓰는 psql 변수를 deploy.sh 가 모두 넘기는지
 * - 통합: 실제 psql(Postgres 컨테이너 안)로 시작 → 성공/실패 upsert, 빈 값은 NULL, 따옴표 · 역슬래시가 든 커밋 제목
 *   OPS_TEST_DATABASE_URL + OPS_TEST_PSQL_CONTAINER(예: pg-ops) 가 없으면 건너뜀
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

const sqlUrl = new URL("../../../infra/platform/scripts/record-deploy.sql", import.meta.url);
const deployShUrl = new URL("../../../infra/platform/scripts/deploy.sh", import.meta.url);

describe("record-deploy.sql 과 deploy.sh", () => {
  it("SQL 이 쓰는 psql 변수를 deploy.sh 가 모두 -v 로 넘긴다", async () => {
    const sql = await readFile(sqlUrl, "utf8");
    const script = await readFile(deployShUrl, "utf8");
    const used = new Set([...sql.replace(/--.*$/gm, "").matchAll(/:'([a-z_]+)'/g)].map((m) => m[1]));
    const passed = new Set([...script.matchAll(/-v ([a-z_]+)=/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(5);
    for (const name of used) expect(passed, `deploy.sh 가 ${name} 을 넘기지 않음`).toContain(name);
  });

  it("deploy.sh 는 시작 · 성공을 기록하고, 실패하면 EXIT 트랩에서 failed 를 남긴다 (기록 실패는 배포를 막지 않음)", async () => {
    const script = await readFile(deployShUrl, "utf8");
    expect(script).toMatch(/record_deploy running/);
    expect(script).toMatch(/record_deploy success/);
    expect(script).toMatch(/trap on_exit EXIT/);
    expect(script).toMatch(/record_deploy failed/);
    expect(script).toMatch(/DEPLOY_RUN_ID/);
    expect(script).toMatch(/DEPLOY_RUN_URL/);
  });
});

const databaseUrl = process.env["OPS_TEST_DATABASE_URL"];
const container = process.env["OPS_TEST_PSQL_CONTAINER"];
const schema = `deploy_record_test_${randomUUID().replaceAll("-", "")}`;
const migrations = new URL("../migrations/", import.meta.url);

describe.skipIf(!databaseUrl || !container)("record-deploy.sql: 실제 psql", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let sql: string;

  /** deploy.sh 와 같은 방식(docker exec psql -v … -f -)으로 실행 */
  function record(vars: Record<string, string>) {
    const args = ["exec", "-i", "-e", `PGOPTIONS=-c search_path=${schema}`, container!, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1"];
    for (const [k, v] of Object.entries(vars)) args.push("-v", `${k}=${v}`);
    args.push("-f", "-");
    execFileSync("docker", args, { input: sql, stdio: ["pipe", "pipe", "pipe"] });
  }

  const base = {
    deploy_key: "",
    status: "running",
    ref: "main",
    commit_sha: "abc1234def",
    commit_subject: `웹 추가 — "따옴표" · 'quote' \\ 역슬래시; DROP TABLE x`,
    commit_url: "https://github.com/o/r/commit/abc1234def",
    started_at: "1790000000",
    disk_before: "",
    disk_after: "",
    disk_total: "",
    run_id: "",
    run_url: "",
  };

  beforeAll(async () => {
    sql = await readFile(sqlUrl, "utf8");
    admin = new pg.Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    for (const file of (await readdir(migrations)).filter((f) => f.endsWith(".sql")).sort()) {
      await pool.query(await readFile(new URL(file, migrations), "utf8"));
    }
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it("시작은 running · 끝 시각 없음, 성공 기록은 같은 행을 갱신한다", async () => {
    const key = randomUUID();
    record({ ...base, deploy_key: key, disk_total: "40483942400" });
    let row = (await pool.query(`SELECT * FROM platform_deploys WHERE deploy_key = $1`, [key])).rows[0];
    expect(row).toMatchObject({ status: "running", ref: "main", commit_subject: base.commit_subject, finished_at: null, run_id: null, disk_used_before_bytes: null });
    expect(new Date(row.started_at).getTime()).toBe(1790000000 * 1000);

    record({ ...base, deploy_key: key, status: "success", disk_before: "14000000000", disk_after: "13000000000", disk_total: "40483942400", run_id: "37005279495", run_url: "https://github.com/o/r/actions/runs/37005279495" });
    const rows = (await pool.query(`SELECT * FROM platform_deploys WHERE deploy_key = $1`, [key])).rows;
    expect(rows).toHaveLength(1);
    row = rows[0];
    expect(row).toMatchObject({ status: "success", disk_used_before_bytes: "14000000000", disk_used_after_bytes: "13000000000", disk_total_bytes: "40483942400", run_id: "37005279495" });
    expect(row.finished_at).not.toBeNull();
  });

  it("시작 기록 없이 실패만 남겨도(최초 부팅 · 시작 전 실패) 한 행이 생기고, 빈 값은 NULL 로 둔다", async () => {
    const key = randomUUID();
    record({ ...base, deploy_key: key, status: "failed", commit_sha: "", commit_subject: "", commit_url: "" });
    const row = (await pool.query(`SELECT * FROM platform_deploys WHERE deploy_key = $1`, [key])).rows[0];
    expect(row).toMatchObject({ status: "failed", commit_sha: null, commit_subject: null, commit_url: null });
    expect(row.finished_at).not.toBeNull();
  });

  it("나중 기록의 빈 값은 앞서 남긴 값을 지우지 않는다", async () => {
    const key = randomUUID();
    record({ ...base, deploy_key: key, run_id: "1", run_url: "https://github.com/o/r/actions/runs/1" });
    record({ ...base, deploy_key: key, status: "failed", commit_sha: "", commit_subject: "", run_id: "", run_url: "" });
    const row = (await pool.query(`SELECT * FROM platform_deploys WHERE deploy_key = $1`, [key])).rows[0];
    expect(row).toMatchObject({ status: "failed", commit_sha: "abc1234def", commit_subject: base.commit_subject, run_id: "1" });
  });
});
