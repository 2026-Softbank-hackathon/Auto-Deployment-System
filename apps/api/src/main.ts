/**
 * apps/api/src/main.ts
 * Entry point. env 읽고 buildServer 실행.
 * DB 연결 실패 시 warn 후 재시도 (dev 편의).
 */

// 쉘 source 없이 env 자동 로드. CAMELLIA_ENV_FILE 로 경로 override 가능.
// production 은 실제 env var 가 override: false 로 보존됨.
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";

const envFile =
  process.env["CAMELLIA_ENV_FILE"] ??
  resolve(process.cwd(), "credentials/credentials.env");
loadDotenv({ path: envFile, override: false });

import { decodeSecretMasterKey, loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { createPool, createPgBoss } from "@camellia/db";
import { createStorage } from "@camellia/storage";
import { CloudflareClient } from "@camellia/cloudflare";

const config = loadConfig();

async function main() {
  // Storage 항상 사용 가능
  const storage = createStorage({ rootDir: config.STORAGE_ROOT_DIR });

  // DB: 연결 실패해도 서버는 뜨되 warn 로그 출력
  const pool = createPool(config.DATABASE_URL ?? "postgresql://localhost/camellia_dev");
  const boss = createPgBoss(config.DATABASE_URL ?? "postgresql://localhost/camellia_dev");
  const tunnelManager =
    config.CLOUDFLARE_ACCOUNT_ID && config.CLOUDFLARE_API_TOKEN
      ? new CloudflareClient({
          accountId: config.CLOUDFLARE_ACCOUNT_ID,
          apiToken: config.CLOUDFLARE_API_TOKEN,
        })
      : undefined;

  const server = await buildServer({
    pool,
    boss,
    storage,
    apiKey: config.API_KEY,
    nodeEnv: config.NODE_ENV,
    logLevel: config.LOG_LEVEL,
    secretMasterKey: decodeSecretMasterKey(
      config.SECRET_MASTER_KEY,
      config.NODE_ENV,
    ),
    sessionTtlSec: config.SESSION_TTL_SEC,
    platformDomain: config.DEMO_PLATFORM_DOMAIN,
    cloudflareZoneId: config.CLOUDFLARE_ZONE_ID,
    agentTunnelManager: tunnelManager,
  });

  // pg-boss 시작 (DB 없어도 서버는 뜨게)
  try {
    await boss.start();
    server.log.info("pg-boss started");
  } catch (err) {
    server.log.warn({ err }, "pg-boss 시작 실패 — DB 없이 실행 중. 작업 큐 비활성.");
  }

  // DB 연결 확인
  try {
    await pool.query("SELECT 1");
    server.log.info("Database connected");
  } catch (err) {
    server.log.warn({ err }, "DB 연결 실패 — 요청 처리 시 오류 발생할 수 있음.");
  }

  await server.listen({ port: config.PORT, host: config.HOST });
  server.log.info(`API server listening on ${config.HOST}:${config.PORT}`);
}

main().catch((err) => {
  console.error("Fatal startup error", err);
  process.exit(1);
});
