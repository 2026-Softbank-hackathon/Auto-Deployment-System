/**
 * packages/ir-schema/src/schema.ts
 *
 * IR(Intermediate Representation) 스키마 v0 — camellia 팀 / SoftBank Hackathon 2026
 *
 * 근거 결정:
 *   D-03  IR = 클라우드 중립 앱 명세 + 프로바이더 어댑터
 *   D-35  IR = 앱 요구사항만 (서비스 유형·포트·헬스·env·secrets·논리 리소스·크기·expose)
 *   D-37  프로필에 없는 요소 결정을 IR에 기록 (missing_resources_decisions)
 *   D-04  클라우드 고유 기능은 overrides + 어댑터에서 수용
 *   D-46  원클릭: expose 기본 public, 기본 ingress + HTTPS
 *
 * 팀원 리포 6필드 정합 확인 (docs/reference/team/ARCHITECTURE_v2_ONBOARDING.md §5):
 *   metadata / services / resources / deploy / overrides / expose  — 전부 포함
 *
 * 언어 확정: TypeScript + Zod (deep-interview-backend-decisions.md Q1 = TS+Zod, D-52)
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// 스키마 자체 버전 상수 (IR 인스턴스가 $ir_version 필드로 참조)
// ---------------------------------------------------------------------------

export const IR_SCHEMA_VERSION = "0.1.0" as const;

// ---------------------------------------------------------------------------
// 공통 열거형
// ---------------------------------------------------------------------------

const ServiceTypeSchema = z
  .enum(["http", "worker", "static", "job"])
  .describe(
    "서비스 실행 방식. http=리스닝 서버, worker=백그라운드 태스크, static=정적 파일 서빙, job=일회성 실행"
  );

const ExposeValueSchema = z
  .enum(["public", "internal", "none"])
  .describe(
    "서비스 노출 범위. public=외부 인터넷, internal=클러스터 내부, none=노출 없음 (D-46: http/worker 기본 public)"
  );

const SizeSchema = z
  .enum(["small", "medium", "large"])
  .describe(
    "서비스 컴퓨트 크기. 프로필이 실제 CPU/RAM 값으로 매핑 (예: small=0.25vCPU/512MB)"
  );

const ResourceTypeSchema = z
  .enum(["postgres", "mysql", "redis", "object_storage"])
  .describe("관리형 리소스 유형. P0 지원: postgres·redis. P1 예정: mysql·object_storage");

const ResourcePlanSchema = z
  .enum(["dev", "prod"])
  .describe("리소스 크기 등급. 프로필이 실제 인스턴스 클래스로 매핑 (dev=소형, prod=운영급)");

// ---------------------------------------------------------------------------
// metadata
// ---------------------------------------------------------------------------

const MetadataSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .describe("앱 식별자. URL·레지스트리 이름에 사용되므로 소문자·하이픈 권장"),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+/, "semver 형식(x.y.z) 필요")
      .describe("앱 버전. semver(x.y.z) 형식"),
    description: z.string().optional().describe("앱 설명 (선택)"),
    owner: z.string().optional().describe("앱 소유자·팀 이름 (선택)"),
  })
  .describe("앱 기본 정보");

// ---------------------------------------------------------------------------
// services[*].build
// ---------------------------------------------------------------------------

const BuildSchema = z
  .object({
    dockerfile: z
      .string()
      .optional()
      .describe("Dockerfile 경로. 미지정 시 buildpack railpack으로 fallback"),
    context: z
      .string()
      .optional()
      .describe("Docker build context 디렉터리. 기본값 '.'"),
    buildpack: z
      .literal("railpack")
      .optional()
      .describe("빌드팩 지정. 현재 지원: railpack. Dockerfile이 없을 때 자동 선택됨"),
  })
  .optional()
  .describe("빌드 설정. 미지정 시 railpack 자동 감지");

// ---------------------------------------------------------------------------
// services[*].health
// ---------------------------------------------------------------------------

const HealthSchema = z
  .object({
    path: z
      .string()
      .default("/health")
      .describe("헬스체크 HTTP 경로. 기본값 /health"),
    expected_status: z
      .number()
      .int()
      .min(100)
      .max(599)
      .default(200)
      .describe("기대 HTTP 상태 코드. 기본값 200"),
    timeout_seconds: z
      .number()
      .int()
      .min(1)
      .max(60)
      .default(3)
      .describe("헬스체크 타임아웃(초). 기본값 3"),
  })
  .default({ path: "/health", expected_status: 200, timeout_seconds: 3 })
  .describe("헬스체크 설정");

// ---------------------------------------------------------------------------
// services[*]
// ---------------------------------------------------------------------------

const ServiceSchema = z
  .object({
    type: ServiceTypeSchema,
    build: BuildSchema,
    command: z
      .array(z.string())
      .optional()
      .describe("컨테이너 실행 명령. argv 배열 형태 (예: [\"node\", \"server.js\"])"),
    port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .optional()
      .describe("서비스 리스닝 포트. type=http·worker에서 필수"),
    health: HealthSchema,
    env: z
      .array(z.string())
      .optional()
      .describe(
        "주입받을 환경변수 이름 목록. 값은 secrets 저장소 또는 프로필에서 주입 (값 자체는 IR에 포함 안 함)"
      ),
    env_defaults: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "환경변수 default 값 매핑 (분석기가 `.env.example`에서 추출). " +
        "프로젝트에 env_vars 미등록 시 이 default 사용 — 원클릭 복원 (이슈 #137). " +
        "secret 성격 값은 저장 금지, 공개 가능한 설정값만."
      ),
    secrets: z
      .array(z.string())
      .optional()
      .describe(
        "주입받을 시크릿 이름 목록 (P1). 값은 시크릿 저장소 전용 — IR에 절대 포함 안 함 (D-50)"
      ),
    expose: ExposeValueSchema.default("public").describe(
      "서비스 노출 범위. D-46 원클릭: http·worker 기본 public"
    ),
    size: SizeSchema.default("small").describe(
      "컴퓨트 크기. 프로필이 CPU/RAM으로 매핑. 기본값 small"
    ),
    depends_on: z
      .array(z.string())
      .optional()
      .describe("이 서비스가 의존하는 다른 서비스 이름 목록. 위상 정렬 순서에 사용됨"),
  })
  .describe("단일 서비스 정의");

// ---------------------------------------------------------------------------
// resources[*]
// ---------------------------------------------------------------------------

const ResourceSchema = z
  .object({
    type: ResourceTypeSchema,
    version: z
      .string()
      .optional()
      .describe("리소스 버전 (예: postgres의 경우 \"16\")"),
    plan: ResourcePlanSchema.optional().describe(
      "리소스 크기 등급. 프로필이 실제 인스턴스 클래스로 매핑"
    ),
  })
  .describe("논리적 관리형 리소스 정의");

// ---------------------------------------------------------------------------
// deploy
// ---------------------------------------------------------------------------

const DeploySchema = z
  .object({
    profile: z
      .string()
      .min(1)
      .describe(
        "배포 프로필 식별자. 예: \"aws-ecs-basic\" | \"onprem-docker-basic\". 프로필이 인프라 골격과 capabilities를 결정 (D-36)"
      ),
    region: z
      .string()
      .optional()
      .describe("배포 리전 (선택). 예: \"ap-northeast-2\". 프로필 기본값이 있으면 생략 가능"),
  })
  .describe("배포 환경 설정. 프로필 선택 + 리전");

// ---------------------------------------------------------------------------
// overrides
// ---------------------------------------------------------------------------

const OverridesSchema = z
  .record(z.string(), z.record(z.string(), z.unknown()))
  .optional()
  .describe(
    "환경 프로필별 필드 오버라이드 (D-04). 키 = 프로필 이름, 값 = IR 부분 오버라이드. " +
    "예: { \"aws-ecs-basic\": { \"services\": { \"api\": { \"size\": \"medium\" } } } }"
  );

// ---------------------------------------------------------------------------
// expose (routing)
// ---------------------------------------------------------------------------

const ExposePathSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .describe("라우팅 경로 접두사 (예: \"/api\")"),
    service: z
      .string()
      .min(1)
      .describe("라우팅 대상 서비스 이름 (services 키와 일치해야 함)"),
    port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .optional()
      .describe("대상 포트. 미지정 시 서비스 정의의 port 값 사용"),
  })
  .describe("개별 경로 라우팅 규칙");

const ExposeSchema = z
  .object({
    domain: z
      .string()
      .optional()
      .describe("커스텀 도메인 (선택). 미지정 시 프로필이 기본 도메인 할당"),
    tls: z
      .boolean()
      .default(true)
      .describe("TLS(HTTPS) 활성화 여부. 기본값 true (D-46 원클릭 기본 HTTPS)"),
    paths: z
      .array(ExposePathSchema)
      .optional()
      .describe(
        "경로 기반 라우팅 규칙 목록. 미지정 시 단일 서비스 기준으로 프로필이 자동 설정"
      ),
  })
  .optional()
  .describe("외부 라우팅 설정. 도메인·TLS·경로 라우팅");

// ---------------------------------------------------------------------------
// missing_resources_decisions (D-37)
// ---------------------------------------------------------------------------

const MissingResourceDecisionSchema = z
  .object({
    resource_name: z
      .string()
      .min(1)
      .describe("프로필에 없는 리소스 이름 (resources 키 또는 서비스 이름)"),
    decision: z
      .enum(["add_module", "exclude"])
      .describe(
        "사용자 결정. add_module=확장 모듈 추가, exclude=해당 리소스 없이 진행"
      ),
    module_id: z
      .string()
      .optional()
      .describe("add_module 선택 시 확장 모듈 식별자 (선택)"),
    decided_at: z
      .string()
      .datetime()
      .describe("결정 시각 (ISO 8601 형식). 예: \"2026-09-30T03:00:00.000Z\""),
  })
  .describe("프로필에 없는 요소에 대한 사용자 결정 기록 (D-37)");

// ---------------------------------------------------------------------------
// 최상위 IR 스키마
// ---------------------------------------------------------------------------

export const IrSchema = z
  .object({
    $ir_version: z
      .string()
      .optional()
      .default(IR_SCHEMA_VERSION)
      .describe(
        "이 IR 인스턴스가 준수하는 스키마 버전. 현재 \"0.1.0\". 미지정 시 최신 버전으로 간주"
      ),

    // 팀원 리포 6필드 (ARCHITECTURE_v2_ONBOARDING.md §5 정합)
    metadata: MetadataSchema.describe("앱 기본 정보 (이름·버전·설명·소유자)"),

    services: z
      .record(z.string().min(1), ServiceSchema)
      .describe(
        "서비스 맵. 키 = 서비스 이름, 값 = 서비스 정의. " +
        "P0는 단일 서비스 사용, 스키마는 다중 서비스 지원. 최소 1개 필수"
      ),

    resources: z
      .record(z.string().min(1), ResourceSchema)
      .optional()
      .describe(
        "관리형 리소스 맵. 키 = 논리적 리소스 이름, 값 = 리소스 정의. " +
        "P0: postgres·redis. P1: mysql·object_storage"
      ),

    deploy: DeploySchema.describe("배포 프로필 및 리전 설정"),

    overrides: OverridesSchema.describe(
      "프로필별 오버라이드 맵 (D-04). 키 = 프로필 이름"
    ),

    expose: ExposeSchema.describe("외부 라우팅 설정 (도메인·TLS·경로 라우팅)"),

    // D-37: 프로필에 없는 요소 결정 기록
    missing_resources_decisions: z
      .array(MissingResourceDecisionSchema)
      .optional()
      .describe(
        "프로필 capabilities에 없는 리소스·서비스에 대한 사용자 결정 목록 (D-37). " +
        "오케스트레이터가 IR·프로필 대조 단계에서 채움"
      ),
  })
  .describe(
    "Camellia IR v0.1.0 — 앱 요구사항 전용 클라우드 중립 배포 명세. " +
    "인프라 상세는 프로필·어댑터가 담당 (D-35·D-36)"
  );

// ---------------------------------------------------------------------------
// TypeScript 타입 exports
// ---------------------------------------------------------------------------

export type Ir = z.infer<typeof IrSchema>;
export type IrMetadata = z.infer<typeof MetadataSchema>;
export type IrService = z.infer<typeof ServiceSchema>;
export type IrServiceType = z.infer<typeof ServiceTypeSchema>;
export type IrResource = z.infer<typeof ResourceSchema>;
export type IrDeploy = z.infer<typeof DeploySchema>;
export type IrExpose = z.infer<typeof ExposeSchema>;
export type IrMissingResourceDecision = z.infer<typeof MissingResourceDecisionSchema>;

// ---------------------------------------------------------------------------
// 하위 스키마 exports (어댑터·테스트에서 재사용)
// ---------------------------------------------------------------------------

export {
  MetadataSchema,
  ServiceSchema,
  ServiceTypeSchema,
  BuildSchema,
  HealthSchema,
  ExposeValueSchema,
  SizeSchema,
  ResourceSchema,
  ResourceTypeSchema,
  ResourcePlanSchema,
  DeploySchema,
  OverridesSchema,
  ExposeSchema,
  ExposePathSchema,
  MissingResourceDecisionSchema,
};
