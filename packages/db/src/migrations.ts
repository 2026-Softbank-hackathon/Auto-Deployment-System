/**
 * Exports the ordered list of migration file names for use by the migrate runner.
 * Import path: @camellia/db/migrations
 */

export const MIGRATION_FILES = [
  "001_initial.sql",
  "002_health_check_attempts.sql",
] as const;
export type MigrationFile = (typeof MIGRATION_FILES)[number];
