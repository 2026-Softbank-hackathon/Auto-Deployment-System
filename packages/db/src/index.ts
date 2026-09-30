import pg from "pg";
import PgBoss from "pg-boss";

export { Pool } from "pg";
export type { PoolConfig } from "pg";

export function getEnv(): { databaseUrl: string } {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  return { databaseUrl };
}

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl });
}

export function createPgBoss(databaseUrl: string): PgBoss {
  return new PgBoss({ connectionString: databaseUrl });
}

export * from "./schema.js";
