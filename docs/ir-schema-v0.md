# IR 스키마 v0 설명서

- 스키마 버전: `0.1.0`
- 파일 위치: `packages/ir-schema/src/schema.ts`
- 근거 결정: D-03 (IR 중심), D-35 (앱 요구만), D-37 (빠진 요소 결정 기록), D-04 (overrides), D-46 (원클릭)
- 팀원 리포 6필드 정합: `docs/reference/team/ARCHITECTURE_v2_ONBOARDING.md §5`

---

## 1. 개요

IR(Intermediate Representation)은 앱을 **클라우드 중립적인 배포 명세**로 표현한다. 인프라 상세(VPC·ALB·ECS 태스크 크기 등)는 IR에 들어가지 않고, 프로필과 어댑터가 담당한다. 이 분리 덕분에 같은 IR 하나로 AWS ECS와 온프레미스 Docker Compose에 배포할 수 있다.

IR 인스턴스 하나는 다음 질문에 답한다.

- **무엇을 실행할지** (`services`): 서비스 유형, 빌드 방법, 포트, 헬스체크, 환경변수 이름
- **어떤 관리형 인프라가 필요한지** (`resources`): 논리적 리소스 이름과 종류
- **어디에 배포할지** (`deploy`): 프로필 선택
- **프로필별로 다른 값이 무엇인지** (`overrides`): 환경별 튜닝
- **외부에 어떻게 노출할지** (`expose`): 도메인, TLS, 경로 라우팅
- **프로필에 없는 요소를 어떻게 처리했는지** (`missing_resources_decisions`): 사용자 결정 기록

---

## 2. 최상위 6필드

팀원 리포(`ARCHITECTURE_v2_ONBOARDING.md §5`)의 6필드와 완전히 정합한다.

| 필드 | 필수 | 설명 |
|---|---|---|
| `metadata` | 필수 | 앱 이름(semver), 설명, 소유자 |
| `services` | 필수 | 서비스 맵 (키=서비스 이름) |
| `resources` | 선택 | 관리형 리소스 맵 (DB·캐시 등) |
| `deploy` | 필수 | 프로필 선택 + 리전 |
| `overrides` | 선택 | 프로필별 오버라이드 |
| `expose` | 선택 | 외부 라우팅 (도메인·TLS·경로) |

추가 필드:

| 필드 | 필수 | 설명 |
|---|---|---|
| `$ir_version` | 선택(기본 `"0.1.0"`) | 이 IR이 준수하는 스키마 버전 |
| `missing_resources_decisions` | 선택 | D-37: 프로필에 없는 요소 결정 기록 |

---

## 3. services 필드 상세

```
services:
  <서비스-이름>:
    type: http | worker | static | job
    build:
      dockerfile?: string       # 미지정 시 railpack fallback
      context?: string          # 기본 "."
      buildpack?: "railpack"
    command?: string[]          # argv 배열
    port?: number               # http·worker에서 필수
    health:
      path: string              # 기본 "/health"
      expected_status: number   # 기본 200
      timeout_seconds: number   # 기본 3
    env?: string[]              # 환경변수 이름만 (값 없음)
    secrets?: string[]          # 시크릿 이름만 — 값은 저장소 전용 (P1)
    expose: "public"|"internal"|"none"  # 기본 "public" (D-46)
    size: "small"|"medium"|"large"      # 기본 "small"
    depends_on?: string[]       # 위상 정렬 기준
```

**`expose` 기본값**: http·worker 타입은 `"public"` (D-46 원클릭).

**`build` 미지정 또는 `dockerfile` 미지정**: railpack이 자동 감지해 Dockerfile 없이 빌드.

---

## 4. resources 필드 상세

```
resources:
  <리소스-이름>:
    type: postgres | mysql | redis | object_storage
    version?: string    # 예: "16" (postgres 버전)
    plan?: dev | prod   # 프로필이 실제 인스턴스 클래스로 매핑
```

P0 지원: `postgres`, `redis`. P1 예정: `mysql`, `object_storage`.

---

## 5. missing_resources_decisions 필드 (D-37)

프로필 capabilities에 없는 리소스가 IR에 선언되면, 오케스트레이터가 사용자에게 확인 후 결정을 이 배열에 기록한다. 한 번 기록된 결정은 재질문하지 않는다.

```
missing_resources_decisions:
  - resource_name: string         # 리소스 이름
    decision: add_module | exclude
    module_id?: string            # add_module일 때 확장 모듈 ID
    decided_at: string            # ISO 8601
```

---

## 6. YAML 예시 3개

---

### 예시 1 — 최소 예시: 단일 http 서비스 (todo-app, Node.js)

```yaml
$ir_version: "0.1.0"

metadata:
  name: todo-app
  version: 1.0.0
  description: Node.js 기반 할일 관리 앱
  owner: camellia-team

services:
  api:
    type: http
    build:
      dockerfile: ./Dockerfile
      context: .
    command: ["node", "server.js"]
    port: 3000
    health:
      path: /health
      expected_status: 200
      timeout_seconds: 3
    env:
      - NODE_ENV
    expose: public
    size: small

deploy:
  profile: onprem-docker-basic
  region: local

expose:
  tls: true
  paths:
    - path: /
      service: api
      port: 3000
```

**이 IR의 결정 해설**

- 외부 DB 없음: `resources` 필드 생략. sqlite 파일 기반이거나 앱 내장 스토리지를 사용하는 최소 케이스.
- `build.dockerfile` 명시: railpack fallback 없이 팀이 직접 관리하는 Dockerfile 사용.
- `expose: public`: D-46 원클릭 원칙에 따라 기본값 그대로. ALB(AWS) 또는 Cloudflare Tunnel(온프레미스)이 자동으로 HTTPS 엔드포인트를 만들어 준다.
- `missing_resources_decisions` 없음: 선언된 리소스가 없으므로 프로필 대조에서 누락 요소 없음.

---

### 예시 2 — DB 포함 예시 (P1 미리보기): http 서비스 + postgres 리소스

```yaml
$ir_version: "0.1.0"

metadata:
  name: blog-api
  version: 2.1.0
  description: Express + PostgreSQL 블로그 API
  owner: camellia-team

services:
  api:
    type: http
    build:
      context: .
      # dockerfile 미지정 → railpack이 Node.js 자동 감지
    command: ["node", "dist/index.js"]
    port: 8080
    health:
      path: /healthz
      expected_status: 200
      timeout_seconds: 5
    env:
      - NODE_ENV
      - DATABASE_URL
    secrets:
      - JWT_SECRET
    expose: public
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
  tls: true
  paths:
    - path: /
      service: api

missing_resources_decisions:
  - resource_name: db
    decision: add_module
    module_id: aws-rds-postgres-16
    decided_at: "2026-09-30T03:00:00.000Z"
```

**이 IR의 결정 해설**

- `resources.db` 선언: postgres P1 애드온을 요청. 프로필 `aws-ecs-basic`이 postgres를 capabilities에 포함하지 않으므로, 오케스트레이터가 사용자에게 확인 후 `missing_resources_decisions`에 `add_module` 결정을 기록했다.
- `module_id: aws-rds-postgres-16`: 팀이 사전 검증한 확장 모듈(D-39 P1 애드온). 이 모듈의 출력(`endpoint`, `port`)이 앱의 `DATABASE_URL` env로 자동 주입된다 (D-43).
- `secrets: [JWT_SECRET]`: 값은 IR에 없고, 시크릿 저장소에서만 주입 (D-50). AI 에이전트도 키 이름만 볼 수 있다.
- `overrides.aws-ecs-basic.services.api.size: large`: 프로덕션 환경에서는 api 서비스를 large 크기로 오버라이드 (D-04). IR 기본값은 medium이지만 이 프로필에서만 large로 확장.
- `build.dockerfile` 생략: railpack이 `package.json`을 감지해 Dockerfile 없이 빌드.

---

### 예시 3 — MSA 예시: api(http) + worker(worker) + postgres 리소스

```yaml
$ir_version: "0.1.0"

metadata:
  name: order-system
  version: 0.5.0
  description: 주문 처리 MSA — api 서버 + 비동기 주문 처리 워커
  owner: camellia-team

services:
  api:
    type: http
    build:
      dockerfile: ./services/api/Dockerfile
      context: ./services/api
    command: ["node", "dist/server.js"]
    port: 3000
    health:
      path: /health
      expected_status: 200
      timeout_seconds: 3
    env:
      - NODE_ENV
      - DATABASE_URL
      - QUEUE_URL
    secrets:
      - API_KEY
    expose: public
    size: medium
    depends_on: []

  order-worker:
    type: worker
    build:
      dockerfile: ./services/worker/Dockerfile
      context: ./services/worker
    command: ["node", "dist/worker.js"]
    health:
      path: /health
      expected_status: 200
      timeout_seconds: 5
    env:
      - NODE_ENV
      - DATABASE_URL
      - QUEUE_URL
    expose: internal
    size: small
    depends_on:
      - api

resources:
  db:
    type: postgres
    version: "16"
    plan: prod

deploy:
  profile: aws-ecs-basic
  region: ap-northeast-2

overrides:
  onprem-docker-basic:
    services:
      api:
        size: small
      order-worker:
        size: small

expose:
  tls: true
  paths:
    - path: /api
      service: api
      port: 3000

missing_resources_decisions:
  - resource_name: db
    decision: add_module
    module_id: aws-rds-postgres-16
    decided_at: "2026-09-30T04:00:00.000Z"
```

**이 IR의 결정 해설**

- **다중 서비스**: `api`와 `order-worker` 두 서비스를 하나의 IR에 선언. D-35 스키마가 다중 서비스를 처음부터 지원하며, P0는 실제로 하나만 사용하고 이 IR은 P1 MSA 케이스를 보여준다.
- **`depends_on`**: `order-worker.depends_on: [api]`로 오케스트레이터의 위상 정렬이 api 헬스체크 통과 후 order-worker를 시작하도록 보장한다. api에는 `depends_on: []`(또는 생략)으로 db 프로비저닝 후 바로 시작.
- **`expose: internal`**: order-worker는 외부 노출 불필요. ALB·Tunnel 라우팅 없이 클러스터 내부 통신만. api만 `public`으로 노출.
- **`overrides.onprem-docker-basic`**: AWS 배포는 medium 크기지만 온프레미스(Intel Mac VM)에서는 리소스 제약으로 api·worker 모두 small로 오버라이드 (D-04).
- **`missing_resources_decisions`**: postgres가 `aws-ecs-basic` capabilities에 없으므로 add_module 결정이 기록됨. `onprem-docker-basic`에서는 postgres 컨테이너를 내장으로 처리하므로 별도 결정 불필요.

---

## 7. Zod 파싱 에러 예시

스키마 검증은 `IrSchema.parse(data)`로 수행한다. 잘못된 필드는 어느 경로에서 실패했는지 정확히 표시된다.

```typescript
import { IrSchema } from "@camellia/ir-schema";

// 예: port 없이 http 서비스를 파싱하면 에러 없이 통과 (port는 optional)
// semver 형식이 틀린 경우:
IrSchema.parse({
  metadata: { name: "test", version: "v1" },  // "v1"은 semver 아님
  services: { api: { type: "http" } },
  deploy: { profile: "aws-ecs-basic" },
});
// ZodError: metadata.version — semver 형식(x.y.z) 필요
```

---

## 8. IR 스키마 버전 관리

- 각 IR 인스턴스는 `$ir_version` 필드로 스키마 버전을 명시한다.
- 스키마 버전 상수는 `IR_SCHEMA_VERSION = "0.1.0"`으로 export된다.
- 파싱 시 `$ir_version`이 없으면 최신 버전(`0.1.0`)으로 간주한다.
- 향후 breaking change 시 버전을 올리고 이전 버전 파서를 별도 유지한다.
