# IR 스키마 명세 (팀원 전달용)

- 대상 독자: 신은영(어댑터·빌드·프로비저닝), 김민서(배포 검증), 김민성(프론트), 조서현·안우진(관측)
- 목적: IR을 처음 보는 팀원이 개념·문법·구조·검증·어댑터 연결 지점을 한 번에 파악
- 전제 지식: 없음 (TypeScript·Zod 사전 지식 섹션 포함)
- 관련 코드: `packages/ir-schema/src/schema.ts` (실제 스키마), `packages/analyzer/src/ir-builder.ts` (조립), `apps/api/src/routes/deployment-ir.ts` (조회·편집 API)
- 관련 문서: `docs/architecture-v5.md` §2, `docs/decisions.md` D-03·D-04·D-35·D-36·D-37·D-46, `docs/ir-schema-v0.md` (요약본)

---

## 목차

0. [IR이 왜 있는가](#0-ir이-왜-있는가)
1. [30초 요약](#1-30초-요약)
2. [TypeScript 최소 문법 (5분)](#2-typescript-최소-문법-5분)
3. [Zod 최소 문법 (5분)](#3-zod-최소-문법-5분)
4. [IR 6필드 구조](#4-ir-6필드-구조)
5. [필드별 상세와 규칙](#5-필드별-상세와-규칙)
6. [YAML 예시 3개](#6-yaml-예시-3개)
7. [검증 방식 (Zod parse)](#7-검증-방식-zod-parse)
8. [어댑터 연결 방식](#8-어댑터-연결-방식)
9. [담당자별 인터페이스 · 인계 지점](#9-담당자별-인터페이스--인계-지점)
10. [흔한 질문 FAQ](#10-흔한-질문-faq)

---

## 0. IR이 왜 있는가

IR = **Intermediate Representation** (중간 표현). 앱을 "무엇을 배포해야 하는가"의 관점에서 **클라우드 중립적**으로 기술한 YAML.

문제: 같은 앱을 AWS·온프레미스·GCP에 배포할 때, 각 환경마다 인프라 설정을 새로 짜면 N×M 조합이 폭발한다.

해결: 앱 요구사항(포트·헬스·리소스 등)만 담은 IR을 만들고, 환경별 프로필이 자신의 골격(VPC·ALB·ECS 등)을 제공한다. 어댑터가 IR 값을 프로필 모듈 변수로 매핑만 하면 된다.

```
소스 코드 →  분석기  →  IR (YAML)  →  프로필 대조  →  어댑터  →  Terraform · Compose
                     ↑                                    ↑
                     클라우드 중립                          클라우드별 골격
```

핵심 결정:
- **D-03**: IR = 클라우드 중립 앱 명세 + 프로바이더 어댑터
- **D-35**: IR은 앱 요구사항만 (인프라 표현 없음)
- **D-36**: 프로필 = 환경별 검증된 인프라 골격 + capabilities
- **D-37**: 프로필에 없는 요소는 사용자에게 알림 → 추가·제외 결정을 IR에 기록
- **D-46**: 원클릭 원칙 (기본값 최대화, 사용자 입력 최소화)

---

## 1. 30초 요약

- IR = YAML 파일 하나 (또는 JSON)
- 6개 최상위 필드: `metadata`, `services`, `resources`, `deploy`, `overrides`, `expose`
- Zod 스키마로 런타임 검증 (`IrSchema.parse(data)`)
- 팀원 리포 정합 (ARCHITECTURE_v2_ONBOARDING.md §5의 6필드와 동일)
- 스키마 코드: `packages/ir-schema/src/schema.ts` (376줄, 문서화된 `.describe()` 55개)
- 예시 3개: `docs/ir-schema-v0.md` 참조

---

## 2. TypeScript 최소 문법 (5분)

### 2.1 왜 TypeScript
- JavaScript에 **정적 타입**을 얹은 언어. 컴파일 시 타입 검사 후 순수 JS로 변환되어 Node.js에서 실행됨
- 런타임에는 JS와 동일 (타입 정보는 제거됨)

### 2.2 필수 문법 6개

**(a) 변수 타입 어노테이션**
```typescript
const name: string = "todo-app";
const port: number = 3000;
```

**(b) 함수 시그니처**
```typescript
function add(a: number, b: number): number {
  return a + b;
}
```

**(c) interface / type**
```typescript
// interface: 객체 형태
interface Service {
  name: string;
  port?: number;   // optional
}

// type: union·intersection 자유
type ServiceType = "http" | "worker" | "static" | "job";
```

**(d) 제네릭**
```typescript
function pick<T>(arr: T[], i: number): T {
  return arr[i];
}
```

**(e) async / await**
```typescript
async function readSource(path: string): Promise<string> {
  const content = await readFile(path, "utf-8");
  return content;
}
```

**(f) import / export (ESM)**
```typescript
// export한 것만 밖에서 씀
export const IR_SCHEMA_VERSION = "0.1.0";
export function analyze(path: string) { ... }

// 다른 파일에서 import
import { analyze, IR_SCHEMA_VERSION } from "./analyzer.js";
//                                            ^^ .ts인데 .js 확장자 (ESM 규칙)
```

### 2.3 워크스페이스 import
- 같은 모노레포 안의 패키지는 상대 경로 대신 패키지 이름
- 예: `packages/analyzer`에서 `packages/ir-schema` 사용
  ```typescript
  import { IrSchema, type Ir } from "@camellia/ir-schema";
  ```
- pnpm workspace가 자동 해결 (`workspace:*` 프로토콜)

---

## 3. Zod 최소 문법 (5분)

Zod = **런타임 검증 + 타입 자동 추론** 라이브러리. 스키마를 코드로 정의하면 런타임 검증기 겸 TypeScript 타입이 동시에 생성됨.

### 3.1 왜 Zod
- 스키마 정의 = 검증 규칙 + 타입 (한 번 쓰면 두 곳에 사용)
- 파싱 실패 시 명확한 에러 경로 (`issues[].path`)
- IR처럼 사용자 입력을 다루는 곳에 최적

### 3.2 핵심 API

**(a) 기본 타입**
```typescript
import { z } from "zod";

z.string()               // 문자열
z.number()               // 숫자
z.number().int()         // 정수만
z.boolean()
z.enum(["a", "b", "c"])  // 지정된 문자열 중 하나
z.literal("foo")         // 정확히 "foo"만
```

**(b) 객체·배열·record**
```typescript
z.object({
  name: z.string(),
  port: z.number().optional(),   // 없어도 됨
})

z.array(z.string())              // 문자열 배열
z.record(z.string(), z.number()) // { [key: string]: number }
```

**(c) modifier**
```typescript
z.string().min(1)                  // 길이 1 이상
z.string().regex(/^\d+\.\d+\.\d+/) // 정규식
z.string().optional()              // 없어도 됨
z.string().default("hello")        // 없으면 기본값
z.string().describe("설명 문서")   // 문서·에러 메시지용, 런타임 동작 없음
```

**(d) parse vs safeParse**
```typescript
const schema = z.object({ name: z.string() });

// parse: 실패 시 throw
try {
  const result = schema.parse({ name: "abc" });   // OK
  schema.parse({ name: 123 });                     // throws ZodError
} catch (e) {
  if (e instanceof z.ZodError) console.log(e.issues);
}

// safeParse: 실패 시 result 객체 반환 (throw X)
const result = schema.safeParse(input);
if (result.success) {
  console.log(result.data);          // 검증된 값
} else {
  console.log(result.error.issues);  // 에러 경로·메시지
}
```

**(e) 타입 자동 추출** (핵심)
```typescript
const IrSchema = z.object({
  metadata: z.object({ name: z.string() }),
  services: z.record(z.string(), z.object({ port: z.number() })),
});

// 스키마에서 TypeScript 타입을 자동 생성
type Ir = z.infer<typeof IrSchema>;
// = { metadata: { name: string }; services: Record<string, { port: number }>; }

// 이제 어디서든 이 타입 사용
function useIr(ir: Ir) {
  console.log(ir.metadata.name);   // 자동완성됨
}
```

### 3.3 실제 우리 코드에서
`packages/ir-schema/src/schema.ts:293`
```typescript
export const IrSchema = z.object({
  $ir_version: z.string().optional().default("0.1.0"),
  metadata: MetadataSchema,
  services: z.record(z.string().min(1), ServiceSchema),
  resources: z.record(z.string().min(1), ResourceSchema).optional(),
  deploy: DeploySchema,
  overrides: OverridesSchema,
  expose: ExposeSchema,
  missing_resources_decisions: z.array(MissingResourceDecisionSchema).optional(),
});

export type Ir = z.infer<typeof IrSchema>;
```

---

## 4. IR 6필드 구조

팀원 리포 (`docs/reference/team/ARCHITECTURE_v2_ONBOARDING.md` §5) 의 6필드 구조와 완전 정합.

| 필드 | 필수 | 목적 |
|---|---|---|
| `metadata` | 필수 | 앱 기본 정보 (이름·버전·설명·소유자) |
| `services` | 필수 | 실행할 서비스 정의 (http·worker·static·job) |
| `resources` | 선택 | 관리형 인프라 리소스 (postgres·redis 등) |
| `deploy` | 필수 | 배포 프로필과 리전 |
| `overrides` | 선택 | 환경별 필드 오버라이드 |
| `expose` | 선택 | 외부 라우팅 (도메인·TLS·경로) |

추가 필드:
| 필드 | 필수 | 목적 |
|---|---|---|
| `$ir_version` | 선택(기본 `"0.1.0"`) | 이 IR 인스턴스가 준수하는 스키마 버전 |
| `missing_resources_decisions` | 선택 | 프로필에 없는 리소스에 대한 사용자 결정 기록 (D-37) |

---

## 5. 필드별 상세와 규칙

### 5.1 metadata
```yaml
metadata:
  name: todo-app              # 필수, 소문자·하이픈 권장 (URL·레지스트리에 사용)
  version: 1.2.0              # 필수, semver 형식
  description: "설명"          # 선택
  owner: camellia-team        # 선택
```

### 5.2 services
서비스 맵. 키 = 서비스 이름, 값 = 서비스 정의.

```yaml
services:
  api:
    type: http                # 필수 - "http" | "worker" | "static" | "job"
    build:                    # 선택 - 없으면 Railpack 자동 감지
      dockerfile: ./Dockerfile
      context: .
      buildpack: railpack     # 선택 대안
    command: [node, server.js]  # 선택 - argv 배열
    port: 3000                # http·worker에서 필수 (1-65535)
    health:                   # 선택 - 기본값 { path: /health, expected_status: 200, timeout_seconds: 3 }
      path: /health
      expected_status: 200
      timeout_seconds: 3
    env:                      # 선택 - 환경변수 이름만 (값은 시크릿 저장소에서)
      - NODE_ENV
      - DATABASE_URL
    secrets:                  # 선택 (P1) - 시크릿 이름만
      - JWT_SECRET
    expose: public            # 선택 - "public" | "internal" | "none". 기본 "public" (D-46)
    size: small               # 선택 - "small" | "medium" | "large". 기본 "small"
    depends_on:               # 선택 - 다른 서비스 이름
      - db
```

**규칙**:
- `type: http` 인데 `port` 없으면 검증 실패
- `env` 배열에는 **이름만** (값은 IR에 절대 저장 X, D-50)
- `secrets`도 이름만
- `size` → 프로필이 실제 CPU/RAM으로 매핑 (예: `small` = 0.25vCPU/512MB)
- `expose: public`이면 프로필이 자동으로 ALB/Cloudflare Tunnel 라우팅 (D-46 원클릭)

### 5.3 resources
```yaml
resources:
  db:
    type: postgres            # 필수 - "postgres" | "mysql" | "redis" | "object_storage"
    version: "16"             # 선택
    plan: dev                 # 선택 - "dev" | "prod"
```

**규칙**:
- P0 지원: `postgres`, `redis`
- P1 예정: `mysql`, `object_storage`
- 프로필의 `capabilities.resource_types`에 포함되지 않으면 → `missing_resources_decisions` 에 사용자 결정 기록

### 5.4 deploy
```yaml
deploy:
  profile: aws-ecs-basic      # 필수 - 프로필 식별자
  region: ap-northeast-2      # 선택 - 없으면 프로필 기본값
```

**프로필 목록** (`packages/profiles/src/`):
- `aws-ecs-basic`: AWS ECS Fargate + ALB + (P1) RDS
- `onprem-docker-basic`: Intel Mac VM + Docker Compose + Cloudflare Tunnel
- (P2) `gcp-cloudrun-basic`, `azure-containerapp-basic`

### 5.5 overrides
프로필별 부분 오버라이드 (D-04).

```yaml
overrides:
  aws-ecs-basic:
    services:
      api:
        size: large           # 이 프로필에서만 large 사용
  onprem-docker-basic:
    services:
      api:
        size: small
```

**규칙**:
- 키 = 프로필 이름
- 값 = IR 부분 트리 (services 서비스 이름 하위만 지정 가능)
- 어댑터가 최종 실행 시 base IR + overrides[profile] 를 병합

### 5.6 expose
외부 라우팅 설정.

```yaml
expose:
  domain: blog.example.com    # 선택 - 없으면 프로필 기본 도메인
  tls: true                   # 기본값 true (D-46)
  paths:                      # 선택 - 경로 기반 라우팅
    - path: /api
      service: api
      port: 3000              # 선택 - 없으면 서비스 정의의 port
```

### 5.7 missing_resources_decisions (D-37)
프로필 `capabilities.resource_types`에 없는 리소스를 IR이 선언하면, 오케스트레이터가 사용자에게 확인 후 이 배열에 결정을 기록.

```yaml
missing_resources_decisions:
  - resource_name: db
    decision: add_module          # "add_module" | "exclude"
    module_id: aws-rds-postgres-16  # add_module 시 확장 모듈 ID
    decided_at: "2026-09-30T03:00:00.000Z"
```

**규칙**:
- `add_module`: 팀 검증 확장 모듈(P1) or 사용자 정의 모듈(P2) 추가
- `exclude`: 해당 리소스 없이 진행 (앱 코드가 알아서 처리)
- 한 번 기록된 결정은 재질문하지 않음 (원클릭 원칙)

---

## 6. YAML 예시 3개

### 예시 1: 최소 (단일 http 서비스)
```yaml
$ir_version: "0.1.0"

metadata:
  name: todo-app
  version: 1.0.0

services:
  api:
    type: http
    build:
      dockerfile: ./Dockerfile
    command: [node, server.js]
    port: 3000
    env:
      - NODE_ENV
    expose: public
    size: small

deploy:
  profile: onprem-docker-basic

expose:
  tls: true
  paths:
    - path: /
      service: api
      port: 3000
```

### 예시 2: DB 포함 (P1)
```yaml
$ir_version: "0.1.0"

metadata:
  name: blog-api
  version: 2.1.0

services:
  api:
    type: http
    build:
      context: .                # dockerfile 미지정 → Railpack fallback
    command: [node, dist/index.js]
    port: 8080
    health:
      path: /healthz
    env:
      - DATABASE_URL
    secrets:
      - JWT_SECRET
    size: medium

resources:
  db:
    type: postgres
    version: "16"
    plan: dev

deploy:
  profile: aws-ecs-basic
  region: ap-northeast-2

overrides:
  aws-ecs-basic:
    services:
      api:
        size: large

expose:
  domain: blog.example.com
  paths:
    - path: /
      service: api

missing_resources_decisions:
  - resource_name: db
    decision: add_module
    module_id: aws-rds-postgres-16
    decided_at: "2026-09-30T03:00:00.000Z"
```

### 예시 3: MSA (다중 서비스)
```yaml
$ir_version: "0.1.0"

metadata:
  name: order-system
  version: 0.5.0

services:
  api:
    type: http
    build:
      dockerfile: ./services/api/Dockerfile
      context: ./services/api
    port: 3000
    env:
      - DATABASE_URL
      - QUEUE_URL
    expose: public

  order-worker:
    type: worker
    build:
      dockerfile: ./services/worker/Dockerfile
      context: ./services/worker
    env:
      - DATABASE_URL
      - QUEUE_URL
    expose: internal
    depends_on:
      - api

resources:
  db:
    type: postgres
    version: "16"
    plan: prod

deploy:
  profile: aws-ecs-basic

expose:
  paths:
    - path: /api
      service: api
```

---

## 7. 검증 방식 (Zod parse)

### 7.1 parse (throw)
```typescript
import { IrSchema } from "@camellia/ir-schema";
import yaml from "js-yaml";

const raw = yaml.load(readFileSync("todo-app.yaml", "utf-8"));
const ir = IrSchema.parse(raw);   // 실패 시 ZodError throw
```

### 7.2 safeParse (실패 반환)
```typescript
const result = IrSchema.safeParse(raw);
if (result.success) {
  const ir = result.data;
} else {
  for (const issue of result.error.issues) {
    console.log(issue.path.join("."), issue.message);
  }
}
```

### 7.3 에러 예시
`metadata.version` 이 semver가 아닐 때:
```json
{
  "issues": [
    {
      "code": "invalid_string",
      "path": ["metadata", "version"],
      "message": "semver 형식(x.y.z) 필요"
    }
  ]
}
```

### 7.4 자주 나는 검증 실패
| 원인 | 예시 | 해결 |
|---|---|---|
| `port` 누락 | http 서비스에 port 없음 | http/worker면 port 필수 |
| `type` enum 위반 | `"grpc"` | http/worker/static/job 중 하나 |
| `version` semver 아님 | `"v1"` | `1.0.0` 형태 |
| `resources.*.type` 지원 밖 | `"mongodb"` | postgres/mysql/redis/object_storage |
| `missing_resources_decisions[].decided_at` 형식 | `"어제"` | ISO 8601 (`2026-09-30T03:00:00.000Z`) |
| `expose` 잘못된 값 | `"internal-only"` | public/internal/none |

---

## 8. 어댑터 연결 방식

### 8.1 어댑터의 역할
IR을 받아 프로필의 Terraform/Compose 모듈 변수로 매핑. **인프라를 새로 설계하지 않음** — 프로필이 미리 검증한 골격에 IR 값을 꽂아 넣기만.

```
IR
  ↓ (매핑만)
Terraform module variables (aws-ecs-basic)
  ↓ terraform apply
AWS 리소스
```

### 8.2 매핑 규칙 (예: aws-ecs-basic)

| IR 필드 | 어댑터 매핑 (Terraform 변수) |
|---|---|
| `metadata.name` | `var.app_name` |
| `metadata.version` | `var.image_tag` (또는 sha256 digest) |
| `services.api.port` | `var.container_port` |
| `services.api.health.path` | `var.health_check_path` |
| `services.api.env` (이름) | `var.env_var_names` (값은 시크릿 저장소에서 주입) |
| `services.api.size` | `var.cpu` / `var.memory` (small=256/512, medium=512/1024, large=1024/2048) |
| `services.api.expose == "public"` | ALB target group 생성 |
| `services.api.expose == "internal"` | Cloud Map service 등록 (외부 노출 X) |
| `resources.db.type == "postgres"` + `add_module` | `module.aws_rds_postgres_16` 자동 활성화 |
| `deploy.region` | `var.aws_region` |
| `overrides.aws-ecs-basic.services.api.size` | base `size` 덮어씀 |
| `expose.domain` | `var.custom_domain` (없으면 ALB DNS 사용) |
| `expose.tls` | `var.enable_https` |
| `expose.paths` | ALB listener rule |

### 8.3 프로필 골격 output → 확장 모듈 input
프로필은 자기가 만든 리소스의 identifier를 output으로 노출:
```hcl
# packages/profiles/aws-ecs-basic (은영 담당)
output "vpc_id" { value = aws_vpc.main.id }
output "subnet_ids" { value = aws_subnet.private[*].id }
```

확장 모듈 (예: `aws-rds-postgres-16`) 이 이 output을 input으로:
```hcl
module "aws_rds_postgres_16" {
  source = "./addons/rds-postgres-16"
  vpc_id = module.aws_ecs_basic.vpc_id
  subnet_ids = module.aws_ecs_basic.subnet_ids
}

# 모듈이 앱 env로 노출
output "database_url" { value = "postgres://${...}" }
```

앱 컨테이너 env에는 `DATABASE_URL = module.aws_rds_postgres_16.database_url` 로 자동 주입.

### 8.4 프로필 대조 로직
`packages/profile-matcher/src/index.ts` `matchProfile(ir, profile)`:
1. IR resources 순회
2. 각 `type`이 `profile.capabilities.resource_types`에 있으면 OK
3. 없으면 `missing_resources` 배열에 추가
4. 서비스 `type`·`size`·`expose`도 프로필 capabilities와 대조

반환:
```typescript
{
  compatible: boolean,          // missing_resources 0 + critical warning 0
  missing_resources: [...],
  warnings: [...]
}
```

**흐름**: 오케스트레이터는 `compatible === false` 이면 사용자에게 알림 → 결정 받아 `missing_resources_decisions` 배열에 기록 → IR을 프로필 어댑터에 넘김.

---

## 9. 담당자별 인터페이스 · 인계 지점

### 9.1 이정 → 은영 (분석·IR → 어댑터·프로비저닝)
**이정이 보장**:
- `analyzeWithAI(sourcePath)` 결과에서 `ir_after` (검증된 IR) 를 DB `ir_versions` 테이블에 저장
- `apps/worker/src/handlers/analyze.ts`에서 상태 전이 `awaiting_target_confirmation` 완료
- 사용자 승인 (target gate) 후 `apps/api/src/services/approval-service.ts`에서 상태 `queued` 전이

**은영이 받는 것**:
- DB `ir_versions` 최신 row의 `ir_json` (Zod IrSchema 통과 보장)
- DB `deployments.target_profile` (승인된 프로필 이름)
- pg-boss "build" job (payload에 deployment_id 포함)

**은영이 만들 것** (TODO 마커 위치):
- `apps/worker/src/handlers/build.ts` — Docker build + ECR push, digest 저장
- `apps/worker/src/handlers/provision.ts` — 프로필 어댑터로 Terraform plan/apply (온프레미스는 Compose 렌더 + 에이전트 롱 폴링)
- `packages/profiles/` 하위에 Terraform 모듈 파일 추가

### 9.2 이정 → 민서 (IR → 검증)
**민서가 받는 것**:
- 배포 완료 후 `deployments.public_url`
- IR의 `services.*.health.path` (헬스체크 대상 경로)
- 이미지 digest (VRF-03 결정 대기 — Q3, 이정과 별도 논의)

**민서가 만들 것**:
- `apps/worker/src/handlers/verify.ts` — 헬스체크 3회 연속 200, 실패 시 롤백 트리거
- (P1) 스모크 테스트, (P1) 이전 digest 자동 롤백

### 9.3 이정 → 민성 (IR → 프론트)
**민성이 받는 것**:
- REST API 엔드포인트 `GET /api/v1/deployments/:id/ir` → `{ ir: <IR JSON>, version, source }`
- SSE 이벤트 `ir_updated` (편집 시)
- IrSchema 타입 (`packages/ir-schema`에서 import 가능)

**민성이 만들 것**:
- 웹 대시보드 IR 편집 UI (PATCH /api/v1/deployments/:id/ir)
- 승인 게이트 UI (POST /api/v1/deployments/:id/approvals)
- 빠진 요소 결정 UI (POST /api/v1/deployments/:id/missing-resources)

`packages/contracts` (예정) 에서 이 API의 Zod 스키마를 공유해서 프론트·백엔드 타입 통일 예정.

---

## 10. 흔한 질문 FAQ

**Q1. IR YAML을 사용자가 직접 편집할 수 있나?**  
A. 예. `PATCH /api/v1/deployments/:id/ir` 로 편집 가능. IrSchema.parse 통과해야 저장됨. 실패 시 400 + validation issues.

**Q2. `env`와 `secrets`의 차이?**  
A. `env`는 앱이 필요한 환경변수 이름 목록. 값은 시크릿 저장소나 프로필에서 주입. `secrets`는 특히 민감한 값(JWT, API key 등)의 이름 목록 (P1). 둘 다 **값 자체는 IR에 절대 저장 X** (D-50).

**Q3. 프로필에 없는 리소스는 어떻게 처리?**  
A. 오케스트레이터가 감지 → 사용자에게 알림 → 사용자가 `add_module` 또는 `exclude` 결정 → IR의 `missing_resources_decisions` 배열에 기록. 한 번 결정된 것은 재질문 X.

**Q4. `overrides`는 왜 필요한가?**  
A. 같은 IR을 여러 프로필(aws-ecs-basic + onprem-docker-basic)에 배포할 때, 프로필별로 다른 size 등을 지정하기 위함. 예: 온프레미스는 small, AWS는 large.

**Q5. `expose: public` 이면 어떻게 URL이 나오나?**  
A. 프로필이 자동 처리. AWS는 ALB DNS, 온프레미스는 Cloudflare Tunnel URL. `deployments.public_url`에 최종 저장.

**Q6. 이미지 digest는 IR에 없는데 어디로 가나?**  
A. IR과 별개로 DB `deployment_services.digest`에 저장. 같은 IR을 여러 번 빌드해도 매번 새 digest.

**Q7. IR 스키마 v0.1.0 이후 breaking change는 어떻게?**  
A. `$ir_version` 필드로 관리. 스키마 버전 올리면 이전 버전 파서 병행 유지. 마이그레이션 스크립트 작성.

**Q8. 새 리소스 타입 (예: `elasticsearch`) 추가하려면?**  
A. 세 곳 수정:
1. `packages/ir-schema/src/schema.ts` `ResourceTypeSchema` enum에 추가
2. `packages/profiles/*/capabilities.resource_types` 배열에 지원 프로필 추가
3. 확장 모듈 (`packages/adapters/addons/`) 신설

**Q9. IR 예시 파일은 어디에?**  
A. `packages/ir-schema/tests/fixtures/*.yaml` 3개 (todo-app, blog-api, order-system). 실제 vitest 파싱 통과 검증됨.

**Q10. IR을 pretty print 하려면?**  
A. `packages/analyzer/src/ir-builder.ts` 참고. `JSON.stringify(ir, null, 2)` 또는 `js-yaml.dump(ir)` 사용.

---

## 참고 파일 지도

| 항목 | 위치 |
|---|---|
| 스키마 코드 | `packages/ir-schema/src/schema.ts` |
| 스키마 요약본 | `docs/ir-schema-v0.md` |
| YAML 예시 3개 | `packages/ir-schema/tests/fixtures/*.yaml` |
| Zod 테스트 16개 | `packages/ir-schema/tests/schema.test.ts` |
| IR 조립 (분석기) | `packages/analyzer/src/ir-builder.ts` |
| IR 조회·편집 API | `apps/api/src/routes/deployment-ir.ts` |
| IR 저장 (워커) | `apps/worker/src/handlers/analyze.ts` |
| 프로필 카탈로그 | `packages/profiles/src/` |
| 프로필 대조 | `packages/profile-matcher/src/index.ts` |
| API 명세 (IR 조회·편집) | `docs/api-spec-v1.md` API-08, API-09 |
| 관련 결정 | `docs/decisions.md` D-03·D-04·D-35·D-36·D-37·D-46·D-50 |
| 아키텍처 | `docs/architecture-v5.md` §2 IR + 환경 프로필 |
