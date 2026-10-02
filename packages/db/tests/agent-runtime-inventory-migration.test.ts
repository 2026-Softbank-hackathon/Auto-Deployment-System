import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationPath = join(
  __dirname,
  "..",
  "migrations",
  "017_agent_runtime_inventory.sql",
);

describe("017_agent_runtime_inventory migration", () => {
  it("Agent heartbeat의 마지막 런타임 목록을 빈 배열 기본값으로 저장함", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toMatch(/ALTER TABLE agents/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS runtime_inventory JSONB/i);
    expect(sql).toMatch(/NOT NULL DEFAULT '\[\]'::jsonb/i);
  });
});
