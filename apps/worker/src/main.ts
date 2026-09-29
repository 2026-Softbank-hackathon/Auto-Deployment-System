/**
 * apps/worker/src/main.ts
 *
 * 별도 프로세스 진입점.
 * DATABASE_URL, STORAGE_ROOT_DIR, ANTHROPIC_API_KEY 환경변수를 읽어
 * 의존성을 초기화하고 pg-boss 워커를 시작한다.
 */

import pino from "pino";
import { createPool, createPgBoss, getEnv } from "@camellia/db";
import { LocalStorage } from "@camellia/storage";
import { createPgNotifier } from "./notifier.js";
import { registerAll } from "./register.js";

const log = pino({ name: "worker" });

async function main(): Promise<void> {
  const { databaseUrl } = getEnv();

  const storageRootDir = process.env["STORAGE_ROOT_DIR"];
  if (!storageRootDir) {
    throw new Error("STORAGE_ROOT_DIR environment variable is required");
  }

  const pool = createPool(databaseUrl);
  const boss = createPgBoss(databaseUrl);
  const storage = new LocalStorage({ rootDir: storageRootDir });
  const notifier = createPgNotifier(pool);

  const deps = { pool, boss, storage, notifier, log };

  boss.on("error", (err: unknown) => {
    log.error({ err }, "pg-boss error");
  });

  await boss.start();

  await registerAll(boss, deps);

  log.info("worker started — listening for jobs");

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, "shutting down worker");
    await boss.stop();
    await pool.end();
    log.info("worker stopped");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  log.error({ err }, "worker startup failed");
  process.exit(1);
});
