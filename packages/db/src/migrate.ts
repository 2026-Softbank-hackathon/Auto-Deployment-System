import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

const TRACKING_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function getApplied(client: pg.PoolClient): Promise<Set<string>> {
  const result = await client.query<{ name: string }>(
    "SELECT name FROM schema_migrations ORDER BY name"
  );
  return new Set(result.rows.map((r) => r.name));
}

async function applyMigration(
  client: pg.PoolClient,
  name: string,
  sql: string
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query(
      "INSERT INTO schema_migrations (name) VALUES ($1)",
      [name]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

async function run(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    process.stderr.write("ERROR: DATABASE_URL environment variable is required\n");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  try {
    await client.query(TRACKING_DDL);

    const applied = await getApplied(client);

    const entries = await readdir(MIGRATIONS_DIR);
    const sqlFiles = entries
      .filter((f) => f.endsWith(".sql"))
      .sort();

    let count = 0;
    for (const file of sqlFiles) {
      if (applied.has(file)) {
        process.stdout.write(`skip  ${file}\n`);
        continue;
      }
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      process.stdout.write(`apply ${file} ...\n`);
      await applyMigration(client, file, sql);
      process.stdout.write(`done  ${file}\n`);
      count++;
    }

    process.stdout.write(`\nMigrations complete. Applied: ${count}\n`);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err: unknown) => {
  process.stderr.write(`Migration failed: ${String(err)}\n`);
  process.exit(1);
});
