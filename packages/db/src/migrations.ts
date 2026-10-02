/**
 * Exports the ordered list of migration file names for use by the migrate runner.
 * Import path: @camellia/db/migrations
 */

export const MIGRATION_FILES = [
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
] as const;
export type MigrationFile = (typeof MIGRATION_FILES)[number];
