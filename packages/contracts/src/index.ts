/**
 * @camellia/contracts — camellia API 계약 (프론트 · 백엔드 공유).
 * `/api/v1` 라우트의 요청 · 응답 · SSE 이벤트를 Zod 스키마 + TS 타입으로 export 한다.
 *
 * 규칙: API 응답을 바꾸면 계약도 같이 바꾼다. 백엔드 서비스의 DTO 반환 타입이 여기 타입이라
 * 어긋나면 tsc 가, 실제 라우트 응답이 어긋나면 apps/api/tests/contracts.test.ts 가 막는다.
 */

export * from "./common.js";
export * from "./projects.js";
export * from "./env.js";
export * from "./deployments.js";
export * from "./secrets.js";
export * from "./environments.js";
export * from "./events.js";
export * from "./auth.js";
export * from "./agents.js";
export * from "./audit-logs.js";
