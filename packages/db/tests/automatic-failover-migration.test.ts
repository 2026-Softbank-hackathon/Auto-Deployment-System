import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("026 automatic failover migration (#349)", () => {
  it("현재 활성 배포와 명시적인 AWS fallback 관계를 저장한다", async () => {
    const sql = await readFile(
      new URL("../migrations/026_automatic_failover.sql", import.meta.url),
      "utf8",
    );

    expect(sql).toMatch(/projects[\s\S]*active_deployment_id/i);
    expect(sql).toMatch(/deployments[\s\S]*failover_target_deployment_id/i);
    expect(sql).toMatch(/REFERENCES deployments\s*\(id\)/i);
    expect(sql).toMatch(/UPDATE projects/i);
  });
});
