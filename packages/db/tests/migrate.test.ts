import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MIGRATION_FILES } from "../src/migrations.js";

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

  it("exports every current migration in execution order", () => {
    expect(MIGRATION_FILES).toEqual([
      "001_initial.sql",
      "002_diagnosis.sql",
      "002_health_check_attempts.sql",
      "003_verify_job_idempotency.sql",
      "004_secrets_environments.sql",
      "005_env_vars.sql",
      "006_deployment_environments.sql",
      "007_build_artifacts.sql",
      "008_agents.sql",
      "009_onprem_agent_jobs.sql",
      "010_audit_logs.sql",
      "011_agent_ecr_credentials.sql",
      "012_shared_connections.sql",
      "013_health_check_attempt_phase.sql",
      "014_health_check_legacy_unique.sql",
    ]);
    for (const file of MIGRATION_FILES) {
      expect(existsSync(join(MIGRATIONS_DIR, file))).toBe(true);
    }
  });
});
