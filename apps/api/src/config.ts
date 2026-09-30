/**
 * apps/api/src/config.ts
 * 환경변수 파싱 (Zod). Postgres 연결 없어도 서버 시작 가능하게 optional 처리.
 */

import { z } from "zod";

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().optional(),
  API_KEY: z.string().optional(),
  STORAGE_ROOT_DIR: z.string().default("/tmp/camellia-storage"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  return ConfigSchema.parse(process.env);
}
