import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { APP_VERSION } from "./version.js";

const startedAt = new Date();

export type AppInfo = {
  version: string;
  environment: string;
  hostname: string;
  startedAt: string;
  uptimeSeconds: number;
  message: string | null;
  node: string;
};

// 실행 환경 이름. DEPLOY_TARGET을 주면 그 값을 쓰고, 없으면 플랫폼이 남기는 흔적으로 추정한다.
function detectEnvironment(): string {
  if (process.env.DEPLOY_TARGET) return process.env.DEPLOY_TARGET;
  // ECS 에이전트가 모든 컨테이너에 넣어 주는 메타데이터 엔드포인트 변수 (앱 설정값이 아니라 이름으로만 확인)
  if (Object.keys(process.env).some((key) => key.startsWith("ECS_CONTAINER_METADATA_URI"))) {
    return "AWS ECS";
  }
  if (existsSync("/.dockerenv")) return "Docker";
  return "Local";
}

export function getInfo(): AppInfo {
  return {
    version: APP_VERSION,
    environment: detectEnvironment(),
    hostname: hostname(),
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
    message: process.env.APP_MESSAGE || null,
    node: process.version,
  };
}
