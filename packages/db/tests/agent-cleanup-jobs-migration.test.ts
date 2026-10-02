import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationPath = join(
  __dirname,
  "..",
  "migrations",
  "018_onprem_agent_cleanup_jobs.sql",
);

describe("018_onprem_agent_cleanup_jobs migration", () => {
  it("배포별 cleanup Job의 예약·lease·결과를 영속화함", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS onprem_agent_cleanup_jobs/i);
    expect(sql).toMatch(/deployment_id BIGINT NOT NULL UNIQUE/i);
    expect(sql).toMatch(/available_at TIMESTAMPTZ NOT NULL/i);
    expect(sql).toMatch(/lease_owner_id BIGINT/i);
    expect(sql).toMatch(/status IN \('pending', 'claimed', 'succeeded', 'failed'\)/i);
  });
});
