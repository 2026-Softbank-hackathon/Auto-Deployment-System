/**
 * packages/analyzer/src/types.ts
 *
 * AnalysisResult 및 보조 타입 정의.
 * IR 조립 결과 + 규칙으로 해결 못 한 필드(unresolved)를 담는다.
 *
 * 근거: D-35 (IR = 앱 요구만), D-47 (규칙 기반 + AI는 빈칸만)
 */

import type { Ir } from "@camellia/ir-schema";

// ---------------------------------------------------------------------------
// 감지된 서비스 후보
// ---------------------------------------------------------------------------

export type ServiceCandidate = {
  /** 서비스 식별 이름 (루트 package.json name 또는 폴더명) */
  name: string;
  /** 소스 루트 기준 상대 경로 */
  path: string;
  /** 서비스 실행 방식 */
  type: "http" | "worker" | "static" | "job" | "unknown";
  /** 감지된 웹 프레임워크 이름 */
  framework?: string;
  /** 런타임 언어 */
  language?: "node" | "python" | "java" | "ruby" | "unknown";
  /** 리스닝 포트 */
  port?: number;
  /** 실행 명령 argv 배열 */
  command?: string[];
  /** Dockerfile 상대 경로 (감지된 경우) */
  dockerfile?: string;
  /** 이 서비스가 필요로 하는 환경변수 이름 목록 */
  env_names: string[];
  /** 감지 근거 목록 (예: "package.json", "server.js line 42") */
  detected_from: string[];
};

// ---------------------------------------------------------------------------
// 감지된 리소스 후보
// ---------------------------------------------------------------------------

export type ResourceCandidate = {
  /** 논리적 리소스 이름 (예: "db", "cache") */
  name: string;
  /** 리소스 종류 */
  type: "postgres" | "mysql" | "redis" | "object_storage" | "unknown";
  /** 감지 근거 목록 */
  detected_from: string[];
};

// ---------------------------------------------------------------------------
// 경고 (ANL-06 운영 위험)
// ---------------------------------------------------------------------------

export type Warning = {
  /** 경고 코드 (예: "ANL-06-SQLITE") */
  code: string;
  /** 사람이 읽을 수 있는 경고 메시지 */
  message: string;
  /** 관련 파일 경로 (있으면) */
  path?: string;
};

// ---------------------------------------------------------------------------
// P1 AI 단계에서 채워야 할 미해결 필드
// ---------------------------------------------------------------------------

export type UnresolvedField = {
  /** IR 내 도트 경로 (예: "services.api.port", "deploy.profile") */
  path: string;
  /** 규칙으로 해결 못 한 이유 */
  reason: string;
};

// ---------------------------------------------------------------------------
// analyze() 반환 타입
// ---------------------------------------------------------------------------

export type AnalysisResult = {
  /** 감지된 서비스들 */
  services: ServiceCandidate[];
  /** 감지된 관리형 리소스들 */
  resources: ResourceCandidate[];
  /** 운영 위험 경고 목록 */
  warnings: Warning[];
  /** 규칙으로 못 채운 필드 — P1 AI 단계에서 채움 */
  unresolved: UnresolvedField[];
  /** 조립한 IR 초안 */
  ir_draft: Partial<Ir>;
  /** IrSchema.parse() 성공 여부 */
  ir_valid: boolean;
  /** parse 실패 시 에러 요약 목록 */
  ir_errors?: string[];
};
