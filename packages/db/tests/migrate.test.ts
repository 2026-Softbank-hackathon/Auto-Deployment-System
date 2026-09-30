import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

/**
 * Smoke test: verifies migration files exist on disk.
 * Actual execution requires a live Postgres instance (e2e only).
 */
describe("migration files", () => {
  it("migrations directory exists", () => {
    expect(existsSync(MIGRATIONS_DIR)).toBe(true);
  });

  it("001_initial.sql exists", () => {
    expect(existsSync(join(MIGRATIONS_DIR, "001_initial.sql"))).toBe(true);
  });
});
