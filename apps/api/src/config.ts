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
  /** API-01 세션 토큰 TTL(초). 기본 3600 */
  SESSION_TTL_SEC: z.coerce.number().int().min(60).max(86400).optional(),
  /** AES-256-GCM 마스터 키 (base64 인코딩된 32바이트). 미설정 시 dev/test 에서만 랜덤 fallback. */
  SECRET_MASTER_KEY: z.string().optional(),
  STORAGE_ROOT_DIR: z.string().default("/tmp/camellia-storage"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  /** 플랫폼 도메인 (고정 서비스 URL 발급용). 예: `camellia.app`. 미세팅 시 publicUrl=null */
  DEMO_PLATFORM_DOMAIN: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const config = ConfigSchema.parse(process.env);
  assertProductionSecurity(config);
  return config;
}

/** production: API_KEY 필수 (SECRET_MASTER_KEY 검증은 main → decodeSecretMasterKey) */
export function assertProductionSecurity(config: Config): void {
  if (config.NODE_ENV !== "production") {
    return;
  }
  if (!config.API_KEY?.trim()) {
    throw new Error("NODE_ENV=production 에서는 API_KEY 가 필수입니다.");
  }
  if (!config.SECRET_MASTER_KEY?.trim()) {
    throw new Error("NODE_ENV=production 에서는 SECRET_MASTER_KEY 가 필수입니다.");
  }
}

export function decodeSecretMasterKey(
  encoded: string | undefined,
  nodeEnv: Config["NODE_ENV"],
): Buffer | undefined {
  if (!encoded) {
    if (nodeEnv === "production") {
      throw new Error("production에서는 SECRET_MASTER_KEY가 필요합니다.");
    }
    return undefined;
  }

  const value = encoded.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error("SECRET_MASTER_KEY는 base64 인코딩된 32바이트여야 합니다.");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32) {
    throw new Error("SECRET_MASTER_KEY는 base64 인코딩된 32바이트여야 합니다.");
  }
  return decoded;
}
