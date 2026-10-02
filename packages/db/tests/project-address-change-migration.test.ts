import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("023_project_address_change migration (#301)", () => {
  it("주소 변경 상태 · 예전 주소 · 새 주소 · 이유 · 시각을 저장하고 기존 row 는 건드리지 않는다", async () => {
    const sql = await readFile(new URL("../migrations/023_project_address_change.sql", import.meta.url), "utf8");

    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS address_change_status TEXT\s+CHECK \(address_change_status IN \('changing', 'succeeded', 'failed'\)\)/i);
    for (const column of ["address_change_from", "address_change_to", "address_change_error"]) {
      expect(sql).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${column} TEXT`, "i"));
    }
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS address_change_requested_at TIMESTAMPTZ/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS address_change_finished_at TIMESTAMPTZ/i);
    expect(sql.replace(/--.*$/gm, "")).not.toMatch(/\b(UPDATE|DELETE|DROP|TRUNCATE)\b/i);
  });
});
