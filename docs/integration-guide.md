# 통합 가이드 — 이정용 (v2)

> 최초 작성: 2026-09-30 (v1)  
> v2 갱신: 2026-09-30 — packages/db·storage·profiles·profile-matcher, apps/api·worker, docker-compose, Notion DB 링크 추가  
> 대상: 이정 (백엔드, Terraform·AWS 경험, TypeScript 처음)  
> 목적: 자고 일어나서 30분 안에 리포 상태 파악 + 팀원 통합 지점 이해

---

## 노션 DB · 핵심 링크

| 이름 | URL | 설명 |
|------|-----|------|
| 기능 명세 DB (119 rows) | https://app.notion.com/p/a321b75796b7482bbe62720b64bb827d | 기능 요구사항 전체 |
| API 명세 DB (48 rows) | https://app.notion.com/p/69fa1d6026f14ff99b6224a9e6971c99 | 엔드포인트 48개 상세 |
| 팀 홈 | https://www.notion.so/6958bee9ada483d1815c01c831afcb3a | 노션 워크스페이스 진입 |
| 아키텍처 v5.4.1 절충안 | https://www.notion.so/3ea8bee9ada480d68879ed5059f8acb3 | 채택된 v5.4.1 |
| 09/30 새벽 회의록 | https://www.notion.so/3ea8bee9ada480549dd9f14b965aba36 | D-52·D-53·Q-01 close 결정 |

---

## 0. 대상·전제

이 문서는 이정이 새벽에 작업하다 잠들었다가 깨어났을 때, 30분 안에 "지금 리포가 어디까지 됐고 내가 뭘 해야 하며 팀원들과 어떻게 맞물리는지"를 혼자 파악할 수 있도록 쓰여 있다.

**커버하는 것**
- TS/ESM/Zod/pnpm workspace/vitest 기초 — 처음 보는 것들
- 이정 담당 파트 (`packages/ir-schema`, `packages/analyzer`) 소스 구조와 흐름
- 팀원(은영·민서·민성·서현·우진)과의 인터페이스·데이터 계약

**커버 안 하는 것**
- 팀원 담당 파트 내부 (빌드·프로비저닝·프론트 상세)
- 최종 Terraform 배포 스크립트
- DB 스키마 상세 (별도 `docs/erd/`)

> v2 추가: `packages/db`, `packages/storage`, `packages/profiles`, `packages/profile-matcher`, `apps/api`, `apps/worker` 구조와 통합 지점이 이 문서에 포함됨.

---

## 1. 사전 지식 (TS 초보 기준)

TypeScript를 처음 쓰면 낯선 것들이 많다. 각 항목마다 실제 리포 코드에서 발췌한 예제로 설명한다.

### 1.1 JS·TS 관계

TS는 JS 위에 타입을 얹은 언어다. `tsc` 컴파일러가 `.ts` 파일에서 타입 어노테이션을 제거(stripping)해서 `.js`로 변환한다. **런타임은 Node.js**, 타입은 실행 중에는 존재하지 않는다.

```
소스       : packages/analyzer/src/index.ts     ← 이정이 편집하는 파일
컴파일 후  : packages/analyzer/dist/index.js    ← Node.js가 실행하는 파일
```

vitest는 `esbuild`로 TS를 바로 실행하므로 테스트에서는 dist가 필요 없다.

**ESM import에서 확장자 규칙**: `.ts` 파일에서 다른 모듈을 import할 때 `.js` 확장자를 써야 한다. Node.js ESM 런타임이 `.ts` 확장자를 모르기 때문이다.

```typescript
// packages/analyzer/src/index.ts:14
import { stage } from "./stager.js";   // .ts 파일이지만 .js로 import
import { splitServices } from "./service-splitter.js";
```

vitest는 이 확장자를 관대하게 처리하지만, `node dist/index.js`로 직접 실행하면 `.js`가 없으면 에러 난다.

---

### 1.2 TS 필수 문법 8개

#### 1. 변수 타입 어노테이션

```typescript
const x: number = 42;
const name: string = "api";
let port: number | undefined = undefined;   // union: number 또는 undefined
```

#### 2. 함수 시그니처

```typescript
// packages/analyzer/src/stager.ts:24
export async function stage(sourcePath: string): Promise<StageResult> {
  // ...
}
```

파라미터 타입 `: string`, 리턴 타입 `: Promise<StageResult>`. async 함수는 항상 `Promise<T>`를 리턴한다.

#### 3. interface vs type

```typescript
// interface — 객체 형태 정의
interface ServiceRoot {
  name: string;
  absPath: string;
}

// type — 더 유연. union, intersection, 기존 타입 별칭
// packages/analyzer/src/types.ts:16
export type ServiceCandidate = {
  name: string;
  type: "http" | "worker" | "static" | "job" | "unknown";
  port?: number;
};
```

실무에서 차이는 거의 없다. 이 리포는 `type`을 주로 쓴다.

#### 4. optional 필드와 non-null assertion

```typescript
// packages/analyzer/src/types.ts:22
framework?: string;   // optional: string 또는 undefined

// non-null assertion (!): "나는 이게 null이 아님을 보장한다"
const svc = result.services[0]!;  // 타입에서 undefined 제거
```

`!`는 런타임 체크가 아니다. null이면 그냥 터진다. 확실한 경우에만 쓴다.

#### 5. 제네릭

```typescript
// packages/analyzer/src/types.ts:90
export type AnalysisResult = {
  ir_draft: Partial<Ir>;   // Partial<T> = T의 모든 필드를 optional로
};

// Promise<T> 도 제네릭
async function analyze(path: string): Promise<AnalysisResult> { ... }
```

`Partial<Ir>`는 `Ir`의 모든 필드가 `?`가 붙은 형태다. IR 초안이 불완전할 수 있으므로 사용.

#### 6. as / as const

```typescript
// as: 타입 캐스팅 (위험 — 꼭 필요할 때만)
const pkg = JSON.parse(raw) as { name?: string; version?: string };

// as const: 리터럴 타입으로 고정
// packages/ir-schema/src/schema.ts:25
export const IR_SCHEMA_VERSION = "0.1.0" as const;
// 타입: "0.1.0" (string 아님)
```

#### 7. enum vs literal union

이 리포는 Zod enum을 쓰고, TS 타입은 literal union으로 뽑는다.

```typescript
// packages/ir-schema/src/schema.ts:31
const ServiceTypeSchema = z.enum(["http", "worker", "static", "job"]);

// packages/analyzer/src/types.ts:22
type: "http" | "worker" | "static" | "job" | "unknown";
// ↑ literal union. 문자열이지만 이 4가지만 허용
```

TS `enum` 키워드는 쓰지 않는다 — 컴파일 후 런타임 객체가 생기는 게 불편해서.

#### 8. import·export (ESM)

```typescript
// named export
export function analyze(...) { ... }
export type { AnalysisResult };

// default export (이 리포에서는 거의 안 씀)
export default class Foo { ... }

// named import
import { analyze } from "@camellia/analyzer";
import type { AnalysisResult } from "@camellia/analyzer";  // 타입만 import
```

`import type`은 컴파일 후 완전히 제거된다. 타입만 필요할 때 쓰면 번들 크기 줄고 순환 의존 방지에 도움.

---

### 1.3 Promise·async·await

JS는 싱글 스레드 이벤트 루프다. I/O(파일 읽기, 네트워크)는 비동기로 처리한다.

**기본 패턴**

```typescript
// await: Promise가 끝날 때까지 기다림
const content = await readFile(path, "utf8");

// try/catch: Promise rejection 잡기
try {
  const stats = await stat(resolvedPath);
} catch {
  throw new Error(`not found: ${resolvedPath}`);
}
```

**Promise.all — 병렬 실행**

순차 실행 대신 병렬로 돌려서 성능을 높인다.

```typescript
// packages/analyzer/src/index.ts:58
const [nodeResult, pyResult, dockerResult] = await Promise.all([
  detectNodejs(svcDir),
  detectPython(svcDir),
  detectDocker(svcDir),
]);
// 세 감지기를 동시에 실행. 셋 다 끝나면 다음 줄로 넘어감.
```

**for await — 비동기 이터레이터 (참고용, 현재 리포에는 미사용)**

```typescript
for await (const chunk of stream) {
  process.stdout.write(chunk);
}
```

---

### 1.4 ESM 특이사항

**import에 `.js` 확장자 필수 이유**

```typescript
// 틀림 (vitest는 OK지만 node 런타임은 에러)
import { stage } from "./stager";

// 맞음
import { stage } from "./stager.js";
```

Node.js ESM은 파일 확장자를 브라우저처럼 strict하게 요구한다. tsc는 `.ts` → `.js`로 변환하면서 import 경로의 `.js`를 그대로 두기 때문에, 소스에서 `.js`로 쓰면 빌드 후에도 맞는 경로가 된다.

**`__dirname` 대체 방법**

CommonJS(`.cjs`)에는 `__dirname`이 있지만, ESM에는 없다. 대신:

```typescript
// packages/analyzer/tests/analyze.test.ts:9
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
// import.meta.url = 현재 파일의 file:// URL
// fileURLToPath: file:///abs/path → /abs/path
```

**workspace 패키지 import**

```typescript
// packages/analyzer/src/ir-builder.ts:10
import { IrSchema } from "@camellia/ir-schema";
import type { Ir, IrService, IrResource } from "@camellia/ir-schema";
```

`@camellia/ir-schema`는 npm 패키지가 아니라 `packages/ir-schema`다. pnpm workspace가 심링크로 연결한다.

---

### 1.5 Zod 사용법 상세

Zod는 런타임 스키마 검증 라이브러리다. 타입 어노테이션은 컴파일 타임만이지만, Zod는 실제 데이터가 실행 중에 맞는지 검사한다.

**기본 스키마 빌더**

```typescript
// packages/ir-schema/src/schema.ts에서 발췌
import { z } from "zod";

z.string()                          // 문자열
z.number().int()                    // 정수
z.boolean()                         // boolean
z.enum(["http", "worker"])          // 열거형
z.record(z.string(), z.unknown())   // 키-값 맵
z.array(z.string())                 // 배열
z.object({ name: z.string() })      // 객체
```

**실제 예시 — MetadataSchema**

```typescript
// packages/ir-schema/src/schema.ts:61
const MetadataSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe("앱 식별자"),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+/, "semver 형식 필요")
    .describe("앱 버전"),
  description: z.string().optional(),
  owner:       z.string().optional(),
});
```

**수식어들**

```typescript
z.string().optional()           // undefined도 허용
z.string().default("value")     // 없으면 "value"로 채움
z.string().describe("설명")     // 문서화 메타 (런타임 영향 없음)
z.string().min(1)               // 최소 길이
z.string().regex(/pattern/)     // 정규식 검증
z.number().int().min(1).max(65535)  // 범위
```

**`.parse()` vs `.safeParse()`**

```typescript
// .parse() — 실패하면 ZodError throw
const ir = IrSchema.parse(rawData);         // 성공 시 타입 보장된 ir

// .safeParse() — 실패해도 throw 안 함, 결과 객체 반환
// packages/analyzer/src/ir-builder.ts:147
const parseResult = IrSchema.safeParse(draft);
if (parseResult.success) {
  return { ir_draft: parseResult.data, ir_valid: true };
} else {
  const errors = parseResult.error.errors.map(
    (e) => `${e.path.join(".")}: ${e.message}`  // 에러 경로 확인
  );
}
```

`safeParse`를 쓰면 `parseResult.success`가 `true`일 때 `parseResult.data`에 검증된 값이, `false`일 때 `parseResult.error.errors`에 에러 목록이 들어있다.

**`z.infer<typeof Schema>` — 타입 자동 추출**

```typescript
// packages/ir-schema/src/schema.ts:347
export type Ir = z.infer<typeof IrSchema>;
// IrSchema 구조에서 TS 타입을 자동으로 뽑아냄.
// 스키마 바꾸면 타입도 자동 갱신.
```

이게 Zod의 핵심 장점이다. 스키마 한 곳만 수정하면 런타임 검증과 TS 타입이 동시에 맞아진다.

**에러 경로 확인**

```typescript
const result = IrSchema.safeParse(data);
if (!result.success) {
  for (const issue of result.error.issues) {
    console.log(issue.path.join("."), issue.message);
    // 예: "services.api.port" "Required"
  }
}
```

---

### 1.6 pnpm workspace

이 리포는 pnpm workspace 모노레포다.

**구조**

```yaml
# pnpm-workspace.yaml
packages:
  - "packages/*"
  - "apps/*"
```

`packages/ir-schema`, `packages/analyzer`가 workspace 패키지다. `apps/`는 아직 비어 있다.

**workspace 내 의존성**

```json
// packages/analyzer/package.json
{
  "dependencies": {
    "@camellia/ir-schema": "workspace:*",
    "fast-glob": "^3.3.2"
  }
}
```

`workspace:*`는 "이 workspace 안에 있는 패키지 최신 버전"이라는 뜻이다. pnpm이 심링크로 연결한다.

**자주 쓰는 명령**

```bash
# 전체 의존성 설치
pnpm install

# 전체 패키지 빌드/테스트
pnpm -r build
pnpm -r --if-present test

# 특정 패키지만
pnpm --filter @camellia/analyzer test
pnpm --filter @camellia/analyzer typecheck

# 특정 패키지에 의존성 추가
pnpm add fast-glob --filter @camellia/analyzer
pnpm add -D vitest --filter @camellia/analyzer   # dev dependency

# 패키지 목록 확인
pnpm list -r
```

---

### 1.7 vitest

vitest는 Vite 기반 테스트 러너다. Jest와 거의 같은 API다.

**기본 구조**

```typescript
// packages/analyzer/tests/analyze.test.ts:19
import { describe, it, expect } from "vitest";

describe("fixture: node-http", () => {
  it("detects 1 service with type=http", async () => {
    const result = await analyze(resolve(fixturesDir, "node-http"));
    expect(result.services).toHaveLength(1);
    expect(result.services[0].type).toBe("http");
  });
});
```

**실행**

```bash
vitest run     # 한 번만 실행 (CI용)
vitest         # watch 모드 (개발 중)
```

**주요 matcher**

```typescript
expect(x).toBe(3)             // 값 동일 (===)
expect(x).toEqual({ a: 1 })   // 깊은 동일 (객체/배열)
expect(x).toHaveLength(2)
expect(x).toContain("PORT")
expect(x).toBeDefined()
expect(x).toBeUndefined()
expect(fn).toThrow()
expect(x).toBeGreaterThan(0)
```

**mock — `vi.fn().mockResolvedValue()`**

```typescript
// packages/analyzer/tests/ai/fill-unresolved.test.ts:66
const mockCreate = vi.fn().mockResolvedValue({
  content: [{ type: "tool_use", id: "...", name: "...", input: { fields } }],
  usage: { input_tokens: 100, output_tokens: 50 },
});

const client: AnthropicLike = {
  messages: { create: mockCreate },
};
// 실제 API 호출 없이 mock 클라이언트 주입
```

`vi.fn()`은 jest의 `jest.fn()`과 동일하다. `.mockResolvedValue(x)`는 항상 `Promise.resolve(x)`를 반환한다.

---

### 1.8 Fastify (앞으로)

아직 `apps/api`는 없지만 곧 만들 것이다. Express와 다른 점:

| 항목 | Express | Fastify |
|------|---------|---------|
| 스키마 검증 | 수동 | JSON Schema 내장 |
| 성능 | 보통 | Express 대비 2-3배 빠름 |
| 플러그인 시스템 | 미들웨어 | `fastify.register()` |
| TypeScript 지원 | 별도 설정 | 기본 내장 |
| SSE | 직접 구현 | 직접 구현 (동일) |

```typescript
// 앞으로 apps/api에 나올 패턴 (참고)
import Fastify from "fastify";
const app = Fastify({ logger: true });

app.post("/deployments", async (request, reply) => {
  return reply.send({ id: "dep_123" });
});

await app.listen({ port: 3000, host: "0.0.0.0" });
```

---

## 2. 프로젝트 구조 (실제 트리)

```
Auto-Deployment-System/
├── packages/                  # workspace 패키지
│   ├── ir-schema/             # IR 계약 (Zod 스키마 + 타입)
│   │   ├── src/schema.ts      # 핵심 파일 하나
│   │   └── tests/
│   │       ├── fixtures/      # todo-app.yaml, blog-api.yaml, order-system.yaml
│   │       └── schema.test.ts
│   ├── analyzer/              # 소스 → IR 분석기
│   │   ├── src/
│   │   │   ├── index.ts       # analyze(), analyzeWithAI() 진입점
│   │   │   ├── stager.ts      # 경로 검증 + unzip
│   │   │   ├── service-splitter.ts
│   │   │   ├── ir-builder.ts
│   │   │   ├── types.ts
│   │   │   ├── detectors/     # nodejs·python·docker·database·env
│   │   │   └── ai/            # fillUnresolved (Anthropic API)
│   │   └── tests/
│   ├── db/                    # ★ v2 신규 — Postgres 스키마·마이그레이션·pg-boss 초기화
│   │   ├── src/
│   │   │   ├── index.ts       # createPool, createPgBoss, getEnv
│   │   │   ├── schema.ts      # Zod 테이블 스키마 8종
│   │   │   ├── migrate.ts     # 마이그레이션 실행기 (node migrate)
│   │   │   └── migrations.ts
│   │   ├── migrations/        # SQL 파일 (순차 적용)
│   │   └── tests/             # 29 tests (schema.test.ts, migrate.test.ts)
│   ├── storage/               # ★ v2 신규 — 파일 저장소 추상화
│   │   ├── src/
│   │   │   ├── index.ts       # createStorage()
│   │   │   ├── local.ts       # LocalStorage (파일시스템)
│   │   │   └── types.ts       # Storage 인터페이스
│   │   └── tests/             # 9 tests
│   ├── profiles/              # ★ v2 신규 — 배포 프로필 정의 2종
│   │   ├── src/
│   │   │   ├── index.ts       # PROFILES 맵, getProfile()
│   │   │   ├── aws-ecs-basic.ts
│   │   │   ├── onprem-docker-basic.ts
│   │   │   └── types.ts       # Profile, ProfileCapabilities 스키마
│   │   └── tests/             # 11 tests
│   └── profile-matcher/       # ★ v2 신규 — IR ↔ 프로필 대조
│       ├── src/
│       │   └── index.ts       # matchProfile(), matchProfileById()
│       └── tests/             # 14 tests
├── apps/
│   ├── api/                   # ★ v2 신규 — Fastify API 서버
│   │   ├── src/
│   │   │   ├── main.ts        # 진입점
│   │   │   ├── server.ts      # buildServer() 팩토리
│   │   │   ├── config.ts
│   │   │   ├── plugins/       # request-id·error-handler·auth·multipart·sse-broker·pg-listener
│   │   │   ├── routes/        # projects·deployments·events·ir·missing·approvals
│   │   │   └── services/      # ProjectService·DeploymentService·IrService·ApprovalService
│   │   └── tests/             # 16 tests (server.test.ts, pg-listener.test.ts)
│   └── worker/                # ★ v2 신규 — pg-boss consumer
│       ├── src/
│       │   ├── main.ts        # 진입점 (pg-boss.start + registerAll)
│       │   ├── deps.ts        # WorkerDeps 타입
│       │   ├── notifier.ts    # pg_notify 래퍼
│       │   ├── register.ts    # 핸들러 등록
│       │   ├── state-machine.ts
│       │   └── handlers/      # analyze·build·provision·verify
│       └── tests/             # 16 tests (analyze-handler.test.ts, state-machine.test.ts)
├── docs/
│   ├── architecture-v5.md
│   ├── decisions.md
│   ├── api-spec-v0.md
│   ├── api-spec-v1.md         # ★ v2 신규 — 48 엔드포인트 (v0 확장)
│   ├── ir-schema-v0.md
│   ├── measurement-2026-09-30.md  # ★ v2 신규 — 실제 AI 호출 측정
│   └── diagrams/usecase/      # ★ v2 신규 — 담당자별·전체 유즈케이스 6종
├── docker-compose.yml         # ★ v2 신규 — Postgres 16 컨테이너 (5433 포트)
├── .env.example               # ★ v2 신규
├── credentials/               # gitignore — AWS 키 등
├── .omc/                      # gitignore — AI 도구 상태
├── pnpm-workspace.yaml
└── package.json               # workspace 루트 (db:up/migrate/reset, dev, dev:api, dev:worker)
```

**담당 구분**

| 폴더/파일 | 이정 담당 | 팀원 담당 |
|-----------|-----------|-----------|
| `packages/ir-schema/` | 스키마 수정·확장 | - |
| `packages/analyzer/` | 감지 로직·AI fill | - |
| `packages/db/` | 스키마·마이그레이션 | - |
| `packages/storage/` | 로컬 스토리지 | - |
| `packages/profiles/` | 프로필 정의 | 은영 (Terraform 모듈 ref) |
| `packages/profile-matcher/` | IR ↔ 프로필 대조 | - |
| `apps/api/` | Fastify API 서버 | - |
| `apps/worker/` | analyze 핸들러 | 은영 (build·provision), 민서 (verify) |
| Terraform 모듈 | 연결 예정 | 은영 (빌드·프로비저닝) |
| 프론트엔드 | `packages/contracts` (예정) | 민성 |
| Loki·메트릭 | - | 서현·우진 (P2) |

---

---

## 2.5 새로 추가된 패키지·앱 (v2)

### 2.5.1 packages/db — Postgres 스키마 + 마이그레이션 + pg-boss

**역할**: DB 연결 팩토리, Zod 테이블 스키마 타입, SQL 마이그레이션 실행기.  
다른 패키지·앱은 이 패키지에서 `createPool`, `createPgBoss`, 각 테이블 타입을 import한다.

**테이블 8종** (`packages/db/src/schema.ts`)

| 테이블 | 핵심 필드 |
|--------|-----------|
| `projects` | id, name, description |
| `deployments` | id, project_id, status(15종), target_profile, public_url |
| `source_versions` | id, deployment_id, sha256, storage_key, size_bytes |
| `analysis_reports` | deployment_id, services_json, ir_valid, ir_errors_json |
| `ir_versions` | deployment_id, ir_json, source(analyzer/ai_filled/user_edited) |
| `env_locks` | env_key, deployment_id, lease_expires_at |
| `approvals` | deployment_id, gate(patch/target/plan), decision(approve/reject) |
| `deployment_steps` | deployment_id, step_name, status, duration_ms |
| `ai_usage` | deployment_id, model, input_tokens, output_tokens, cache_creation_tokens, estimated_cost_usd |

**DeploymentStatus 15종** (상태 머신)

```
received → analyzing → awaiting_target_confirmation → target_confirmed
→ awaiting_plan_approval → plan_approved → provisioning → building
→ deploying → verifying → awaiting_patch_approval → patching
→ succeeded | failed | cancelled | rolled_back
```

**주요 export** (`packages/db/src/index.ts`)

```typescript
import { createPool, createPgBoss, getEnv } from "@camellia/db";
import type { Deployment, DeploymentStatus } from "@camellia/db";

const { databaseUrl } = getEnv();          // DATABASE_URL 없으면 throw
const pool = createPool(databaseUrl);      // pg.Pool 반환
const boss = createPgBoss(databaseUrl);    // PgBoss 반환
```

**마이그레이션 실행**

```bash
# DB 컨테이너 올리기
pnpm db:up

# SQL 파일 순차 적용 (schema_migrations 테이블로 중복 방지)
pnpm db:migrate

# 초기화 (볼륨 삭제 후 재시작)
pnpm db:reset
```

마이그레이션 실행기(`packages/db/src/migrate.ts`)는 `migrations/` 폴더의 `.sql` 파일을 이름순으로 읽어 `schema_migrations` 테이블에 없는 것만 트랜잭션으로 적용한다.

---

### 2.5.2 packages/storage — 파일 저장소 추상화

**역할**: 소스 zip 업로드·다운로드를 추상화. 현재 구현은 `LocalStorage`(파일시스템). 나중에 S3/MinIO로 교체해도 인터페이스가 동일하다.

**Storage 인터페이스** (`packages/storage/src/types.ts`)

```typescript
interface Storage {
  put(key: string, buffer: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  presignUrl(key: string, opts?: { expiresInSeconds?: number }): Promise<string>;
  listKeys(prefix: string): Promise<string[]>;
}
```

**생성**

```typescript
import { createStorage } from "@camellia/storage";

const storage = createStorage({
  rootDir: process.env["STORAGE_ROOT"],     // 저장 루트 디렉터리
  publicBaseUrl: "http://localhost:3000/storage",
});
// presignUrl은 <publicBaseUrl>/<key> 형태의 URL을 반환한다.
```

`LocalStorage`는 `..` 포함 key를 path traversal로 탐지해 에러를 던진다.

---

### 2.5.3 packages/profiles — 배포 프로필 정의

**역할**: 각 배포 환경(AWS ECS, 온프레미스)의 capabilities를 정의. analyzer의 `ir-builder.ts`가 기본값 `"aws-ecs-basic"`을 넣고, worker의 analyze 핸들러가 `target_profile`로 덮어쓴다.

**현재 프로필 2종**

| 프로필 ID | cloud | 최대 서비스 | resource_types | 설명 |
|-----------|-------|------------|----------------|------|
| `aws-ecs-basic` | aws | 10 | postgres | ECS Fargate + ALB (D-53) |
| `onprem-docker-basic` | onprem | 5 | postgres | Intel Mac VM + Docker Compose + Cloudflare Tunnel |

```typescript
import { getProfile, PROFILES } from "@camellia/profiles";

const profile = getProfile("aws-ecs-basic");  // Profile | null
// profile.capabilities.service_types → ["http", "worker", "job"]
// profile.capabilities.sizes         → ["small", "medium", "large"]
// profile.default_region              → "ap-northeast-2"
```

**은영 TODO**: `terraform_module_ref` 필드에 실제 Terraform 모듈 경로를 채워야 한다.

---

### 2.5.4 packages/profile-matcher — IR ↔ 프로필 대조

**역할**: IR이 선택된 프로필과 호환되는지 5가지 규칙으로 대조한다. `missing_resources`와 `warnings` 목록을 반환한다.

**대조 규칙 5종**

| 규칙 | 내용 | 실패 시 |
|------|------|---------|
| 1 | IR.resources의 type이 `capabilities.resource_types`에 포함 | `missing_resources`에 추가 |
| 2 | services의 type이 `capabilities.service_types`에 포함 | `warnings` 추가 |
| 3 | services의 size가 `capabilities.sizes`에 포함 | `warnings` 추가 |
| 4 | expose "public"/"internal"이 프로필에서 지원 | `warnings` 추가 |
| 5 | 서비스 수가 `max_services` 이하 | `warnings` 추가 |

`compatible = missing_resources 0개 AND "critical_" 접두사 warning 0개`.

```typescript
import { matchProfileById } from "@camellia/profile-matcher";
import type { Ir } from "@camellia/ir-schema";

const result = matchProfileById(ir, "aws-ecs-basic");
// result.compatible           → true/false
// result.missing_resources    → []
// result.warnings             → []
```

---

### 2.5.5 apps/api — Fastify API 서버

**결정 근거**: D-52 (TS + Fastify + pg-boss), D-53 (ECS Fargate)

**아키텍처**

```
main.ts
  └─ buildServer(opts: { pool, boss, storage, apiKey, ... })
       ├─ plugins: request-id · error-handler · auth · multipart · sse-broker · pg-listener
       ├─ services: ProjectService · DeploymentService · IrService · ApprovalService
       └─ routes (prefix /api/v1):
            ├─ /projects             → CRUD
            ├─ /deployments          → 목록·생성·상태
            ├─ /deployments/:id/events (SSE)
            ├─ /deployments/:id/ir   → IR 조회·수정
            ├─ /deployments/:id/missing
            └─ /deployments/:id/approvals
```

**SSE 브로커** (`apps/api/src/plugins/sse-broker.ts`)

배포 ID별 EventEmitter + 최근 100개 이벤트 버퍼를 관리한다. `Last-Event-Id` 헤더로 재연결 시 버퍼에서 누락 이벤트를 재전송한다.

```typescript
// 이벤트 발행 (worker → pg_notify → pg-listener → sseBroker.publish)
sseBroker.publish(deploymentId, { event: "state_changed", data: { status: "analyzing" } });

// 이벤트 구독 (SSE route)
const unsub = sseBroker.subscribe(deploymentId, (evt) => {
  reply.raw.write(formatSseMessage(evt));
});
```

**pg-listener** (`apps/api/src/plugins/pg-listener.ts`)

worker가 `pg_notify("deployment_events", JSON)` 하면 API 프로세스가 `LISTEN deployment_events`로 받아서 SSE로 relay한다.

```
worker process → pg_notify → Postgres → pg-listener → SseBroker → SSE clients
```

**의존성 주입 패턴**: `buildServer(opts)`에 `pool`, `boss`, `storage`를 주입한다. 테스트에서 mock DB/storage를 주입해 실제 Postgres 없이 테스트 가능하다.

**실행**

```bash
# DB 필요 없어도 서버는 뜸 (warn 로그 출력)
pnpm dev:api
# 또는 둘 다
pnpm dev
```

---

### 2.5.6 apps/worker — pg-boss consumer

**역할**: Fastify API가 enqueue한 job을 소비하는 별도 프로세스. 현재 핸들러: `analyze` (구현 완료), `build`·`provision`·`verify` (stub).

**초기화 흐름** (`apps/worker/src/main.ts`)

```
DATABASE_URL, STORAGE_ROOT_DIR 환경변수 확인
  ↓
createPool + createPgBoss + LocalStorage 생성
  ↓
boss.start()
  ↓
registerAll(boss, deps)   ← 모든 핸들러 등록
  ↓
SIGINT/SIGTERM → boss.stop() + pool.end()
```

**analyze 핸들러 흐름** (`apps/worker/src/handlers/analyze.ts`)

```
job.data: { deployment_id, source_storage_key, sha256 }
  ↓
1. received → analyzing 전이 + pg_notify
  ↓
2. storage.get(source_storage_key) → Buffer
  ↓
3. 임시 파일 저장 → stage(tmpZip, { mode: "unzip" })
  ↓
4. analyzeWithAI(staged.resolvedPath, { apiKey, onUsage })
     └─ onUsage: ai_usage 테이블에 INSERT
  ↓
5. analysis_reports INSERT
  ↓
6. ir_versions INSERT
     └─ target_profile로 deploy.profile 덮어쓰기 ← 버그 픽스 (하드코딩 제거)
  ↓
7. analyzing → awaiting_target_confirmation 전이 + pg_notify
```

**버그 픽스 (v2)**: 이전에 `deploy.profile`이 `"aws-ecs-basic"`으로 하드코딩됐었다. 현재는 DB의 `deployments.target_profile`을 조회해서 덮어쓴다 (`apps/worker/src/handlers/analyze.ts:126-133`).

```typescript
// 수정 후 (analyze.ts:126)
const targetProfileRes = await pool.query<{ target_profile: string | null }>(
  "SELECT target_profile FROM deployments WHERE id = $1",
  [deployment_id]
);
const targetProfile = targetProfileRes.rows[0]?.target_profile;
if (targetProfile && irJson && ...) {
  ir["deploy"] = { ...deploy, profile: targetProfile };
}
```

**실행**

```bash
pnpm dev:worker
```

---

## 3. 이정 담당 파트 상세: 소스 → IR

### 3.1 흐름 요약

```
사용자 zip/디렉터리
        │
        ▼
  stage()                  경로 검증, 절대경로 정규화
        │
        ▼
  splitServices()           서비스 경계 감지 (docker-compose, 모노레포, 단일)
        │
        ▼ (서비스별 병렬)
  detectNodejs()
  detectPython()      ──── Promise.all 동시 실행
  detectDocker()
        │
        ▼
  detectDatabase()          DB 의존성 감지
  detectEnvNames()          .env 파일 + 소스 스캔
        │
        ▼
  ServiceCandidate[]        언어·프레임워크·포트·커맨드·env 후보
        │
        ▼
  buildIr()                 ServiceCandidate → Zod IR 조립 + 검증
        │
        ▼
  AnalysisResult            ir_draft(Partial<Ir>) + unresolved 필드 목록
        │
       [unresolved가 있으면]
        ▼
  fillUnresolved()          Anthropic API → tool_use → 빈칸 채움
        │
        ▼
  AiFillResult              ir_after(완전한 Ir) + 사용량 기록
```

---

### 3.2 packages/ir-schema — 계약

`packages/ir-schema/src/schema.ts`는 팀 전체가 공유하는 IR 계약이다. 이 파일이 바뀌면 은영·민서·민성 모두 영향받는다.

**최상위 6필드 구조**

| 필드 | 타입 | 필수 | 근거 결정 | 역할 |
|------|------|------|-----------|------|
| `metadata` | `{ name, version, description?, owner? }` | 필수 | - | 앱 식별자·버전 |
| `services` | `Record<string, ServiceSchema>` | 필수 | D-35 | 서비스 맵 (포트·타입·헬스·env) |
| `resources` | `Record<string, ResourceSchema>?` | 선택 | D-35 | 관리형 리소스 (postgres·redis) |
| `deploy` | `{ profile, region? }` | 필수 | D-36 | 배포 프로필 선택 |
| `overrides` | `Record<string, Record<string, unknown>>?` | 선택 | D-04 | 프로필별 필드 덮어쓰기 |
| `expose` | `{ domain?, tls, paths? }?` | 선택 | D-46 | 외부 라우팅 (도메인·HTTPS·경로) |

추가로 `missing_resources_decisions?` 필드가 있다 (D-37). 프로필에 없는 리소스에 대한 사용자 결정을 기록한다.

**IrSchema.parse() 시나리오**

```typescript
import { IrSchema } from "@camellia/ir-schema";

// 1. 검증 + 타입 보장 (성공 시)
const ir = IrSchema.parse(rawYamlData);
// ir.services["api"].port → number (타입 보장)

// 2. 안전하게 검증 (실패해도 throw 안 함)
const result = IrSchema.safeParse(rawYamlData);
if (!result.success) {
  result.error.issues.forEach(i =>
    console.error(i.path.join("."), i.message)
  );
}
```

**YAML 예시 3종이 커버하는 케이스**

| 파일 | 케이스 |
|------|--------|
| `tests/fixtures/todo-app.yaml` | Node 단일 서비스, Dockerfile 있음, 온프레미스 배포 |
| `tests/fixtures/blog-api.yaml` | Node + postgres, secrets 있음, AWS 배포, overrides 있음 |
| `tests/fixtures/order-system.yaml` | MSA (http + worker 2개 서비스), depends_on, missing_resources_decisions |

order-system.yaml에서 worker 서비스 예시:

```yaml
# packages/ir-schema/tests/fixtures/order-system.yaml:11
order-worker:
  type: worker
  expose: internal          # 외부 노출 없음
  depends_on:
    - api
```

---

### 3.3 packages/analyzer — 규칙 기반 감지

**파일별 역할**

| 파일 | 역할 |
|------|------|
| `src/index.ts` | `analyze()`, `analyzeWithAI()` 공개 진입점 |
| `src/stager.ts` | 경로 존재 확인, 디렉터리 검증 |
| `src/service-splitter.ts` | 서비스 경계 감지 (docker-compose > 모노레포 > 단일) |
| `src/ir-builder.ts` | `ServiceCandidate[]` → Zod IR 조립 + safeParse |
| `src/types.ts` | `AnalysisResult`, `ServiceCandidate`, `UnresolvedField` 등 타입 |
| `src/detectors/nodejs.ts` | package.json, framework 감지, port, env |
| `src/detectors/python.ts` | requirements.txt/pyproject.toml, uvicorn 포트 |
| `src/detectors/docker.ts` | Dockerfile, EXPOSE, CMD |
| `src/detectors/database.ts` | npm/pip 의존성으로 postgres·mysql·redis 감지 |
| `src/detectors/env.ts` | .env 파일 + 소스 파일에서 env 이름 추출 |

**detectors 5종 감지 규칙과 한계**

| 감지기 | 감지 방법 | 한계 |
|--------|-----------|------|
| `nodejs.ts` | `package.json` 존재, `dependencies`에서 프레임워크, `scripts.start`/`main`에서 커맨드, `.listen(PORT)` 정규식으로 포트 | 포트가 변수면 감지 못함 (`process.env.PORT`) |
| `python.ts` | `requirements.txt`/`pyproject.toml`/`Pipfile` 존재, `uvicorn.run(port=N)` 정규식 | 기본 8000으로 fallback + unresolved 등록 |
| `docker.ts` | `Dockerfile` 탐색, `EXPOSE N` 파싱, `CMD [...]` 파싱 | 멀티스테이지 Dockerfile의 최종 스테이지만 볼 수 없음 |
| `database.ts` | npm dep(`pg`, `redis`, `mysql2`), pip dep(`psycopg2`, `redis`), `.db`/`.sqlite` 파일, `DATABASE_URL` 패턴 | SQLite 감지 시 `ANL-06-SQLITE` 경고 + postgres 후보로 등록 |
| `env.ts` | `.env`/`.env.example` 키 이름, `process.env.X` 정규식, `os.environ["X"]` 정규식 | 값은 절대 추출 안 함 (D-50) |

**analyze() 호출 흐름**

```typescript
// packages/analyzer/src/index.ts:41
export async function analyze(sourcePath: string): Promise<AnalysisResult> {
  // 1. 경로 검증
  const { resolvedPath } = await stage(sourcePath);          // :43

  // 2. 서비스 경계 감지
  const serviceRoots = await splitServices(resolvedPath);    // :46

  // 3. 서비스별 감지 (for 루프)
  for (const svcRoot of serviceRoots) {
    // 3개 감지기 병렬 실행
    const [nodeResult, pyResult, dockerResult] = await Promise.all([  // :58
      detectNodejs(svcDir),
      detectPython(svcDir),
      detectDocker(svcDir),
    ]);

    // DB 감지 (node deps 파싱 후)
    const dbResult = await detectDatabase(svcDir, nodeDeps, pyPackages); // :96

    // env 이름 감지
    const envResult = await detectEnvNames(svcDir);                      // :97
  }

  // 4. 루트 package.json에서 앱 이름·버전
  const { appName, appVersion } = await readAppMeta(resolvedPath, services); // :167

  // 5. IR 조립
  const irResult = buildIr({ appName, appVersion, services, resources, ... }); // :170

  return { services, resources, warnings, unresolved, ir_draft, ir_valid, ... };
}
```

**ServiceCandidate → IR 매핑 룰**

```typescript
// packages/analyzer/src/ir-builder.ts:56
for (const svc of input.services) {
  // type: "unknown" 이면 "http" 기본값 + unresolved 등록
  let serviceType: IrService["type"] = "http";
  if (svc.type === "http" || svc.type === "worker" ...) {
    serviceType = svc.type;
  } else {
    unresolved.push({ path: `services.${name}.type`, reason: "..." }); // :64
  }

  // command 없으면 unresolved 등록
  if (!svc.command) {
    unresolved.push({ path: `services.${name}.command`, reason: "..." }); // :89
  }

  // deploy.profile 항상 기본값 + unresolved (오케스트레이터가 덮어씀)
  const deploy = { profile: "aws-ecs-basic" };
  unresolved.push({ path: "deploy.profile", reason: "Default..." }); // :131
}
```

---

### 3.4 packages/analyzer/src/ai — AI 빈칸 채우기

#### 언제 호출되는가

`analyze()` 결과의 `unresolved` 배열이 비어있지 않으면 AI fill을 호출할 수 있다. `analyzeWithAI()`가 두 단계를 묶어서 실행한다.

```typescript
// packages/analyzer/src/index.ts:197
export async function analyzeWithAI(
  sourcePath: string,
  opts?: FillOptions
): Promise<AnalysisResult & { ai: AiFillResult }> {
  const analysis = await analyze(sourcePath);           // 규칙 기반 분석
  const ai = await fillUnresolved(analysis, opts ?? {}); // AI 빈칸 채우기
  // ...
}
```

#### fill-unresolved.ts 로직 스텝

```
1. API key 없으면 → skipped=true 즉시 반환
2. unresolved 비어있으면 → 즉시 반환
3. client 획득 (주입된 것 우선, 없으면 createClient() 동적 생성)
4. userPayload 조립 (services·resources·warnings·unresolved) + redact
5. Anthropic API 호출 (최대 maxRetries+1 회, 지수 backoff)
6. tool_use 블록에서 fields 추출
7. setByPath()로 ir_draft에 필드 적용
8. IrSchema.safeParse()로 재검증
9. 실패 시 retry, 성공 또는 소진 시 결과 반환
```

#### Anthropic SDK dynamic import 이유

```typescript
// packages/analyzer/src/ai/anthropic-client.ts:21
const { default: Anthropic } = await import("@anthropic-ai/sdk");
```

`@anthropic-ai/sdk`가 설치되지 않은 환경(SDK 없이 쓰는 경우)에서도 모듈 로드 자체는 성공해야 한다. 정적 import였으면 SDK 없을 때 모듈 로드 단계에서 바로 에러 난다. dynamic import는 실제 호출될 때만 로드를 시도한다.

#### prompt caching 적용 방식 (D-52)

```typescript
// packages/analyzer/src/ai/prompts.ts:41
export function getSystemBlocksWithCache(): SystemBlock[] {
  const blocks = [...SYSTEM_PROMPT_BLOCKS];
  const last = blocks[blocks.length - 1];
  return [
    ...blocks.slice(0, -1),
    {
      ...last,
      cache_control: { type: "ephemeral" },  // 마지막 블록에만 붙임
    },
  ];
}
```

Anthropic API는 system 블록 배열의 마지막 항목에 `cache_control: { type: "ephemeral" }`을 붙이면 그 지점까지 캐싱한다. 같은 system prompt가 반복 호출되면 `cache_read_input_tokens`이 증가하고 요금이 줄어든다.

#### 시크릿 redact 5 패턴 (D-50)

```typescript
// packages/analyzer/src/ai/redact.ts:21
const REDACT_RULES = [
  { pattern: /\bAKIA[A-Z0-9]{16}\b/g, ... },                       // 1. AWS Access Key ID
  { pattern: /aws_secret_access_key\s*[=:]\s*[A-Za-z0-9/+]{40}/gi }, // 2. AWS Secret
  { pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/g, ... },           // 3. Bearer 토큰
  { pattern: /-----BEGIN[A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END/, }, // 4. PEM 키 블록
  { pattern: /\b(password|passwd|secret|token)\s*[=:]\s*[^\s"',}{]{4,}/gi }, // 5. password= 할당
];
```

AI에 보내기 전 `redactPayload(userPayload)`를 호출한다. JSON 직렬화 후 문자열에 5가지 패턴을 적용해서 `[REDACTED]`로 치환한다.

#### 토큰 사용량 기록 (CST-01)

```typescript
// packages/analyzer/src/ai/tokens.ts:61
export function buildTokenUsage(model: string, usage: { ... }): TokenUsage {
  return {
    model,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
    estimated_cost_usd: estimateCost(usage),  // USD 추정값
    timestamp: new Date().toISOString(),
  };
}
```

각 API 호출 후 `usageList.push(usageEntry)`, `opts.onUsage?.(usageEntry)` 콜백 호출. 오케스트레이터가 나중에 DB에 기록할 수 있다.

#### API key 없을 때 skip 동작

```typescript
// packages/analyzer/src/ai/fill-unresolved.ts:88
const hasKey =
  opts.client !== undefined ||
  opts.apiKey !== undefined ||
  (process.env["ANTHROPIC_API_KEY"] !== undefined &&
    process.env["ANTHROPIC_API_KEY"] !== "");

if (!hasKey) {
  return {
    ir_before,
    ir_after: ir_before,      // 변경 없음
    ir_valid_after: analysis.ir_valid,
    skipped: true,
    skip_reason: "no ANTHROPIC_API_KEY",
    // ...
  };
}
```

key가 없으면 에러를 던지지 않고 `skipped: true`로 반환한다. 호출자가 이를 확인해서 unresolved 필드를 수동으로 채우거나 사용자에게 알릴 수 있다.

#### test mock 방식

```typescript
// packages/analyzer/tests/ai/fill-unresolved.test.ts:63
function makeMockClient(fields: Array<{ path: string; value: unknown }>): AnthropicLike {
  const mockCreate = vi.fn().mockResolvedValue({
    content: [
      {
        type: "tool_use",
        id: "mock_tool_use_1",
        name: "fill_unresolved_ir_fields",
        input: { fields },
      },
    ],
    usage: { input_tokens: 100, output_tokens: 50 },
  });

  return { messages: { create: mockCreate } };
}

// 사용
const client = makeMockClient([{ path: "deploy.profile", value: "aws-ecs-basic" }]);
const result = await fillUnresolved(analysis, { client });
```

실제 API를 호출하지 않고 `FillOptions.client`에 mock 주입. `AnthropicLike` 인터페이스만 맞으면 된다.

---

### 3.5 테스트 실행 방법

```bash
# 전체 패키지 테스트
pnpm -r --if-present test

# analyzer만
pnpm --filter @camellia/analyzer test

# 특정 파일만 (디버그)
pnpm --filter @camellia/analyzer test -- tests/analyze.test.ts

# ir-schema만
pnpm --filter @camellia/ir-schema test

# 타입 체크 (빌드 없이)
pnpm --filter @camellia/analyzer typecheck
```

**실패 로그 읽는 법**

```
 FAIL  tests/analyze.test.ts > fixture: node-http > ir_draft passes IrSchema.parse()
AssertionError: expected false to be true

   - Expected: true
   + Received: false

  ir_errors: ["deploy.profile: ..."]
```

- `FAIL` 다음이 파일 > describe > it 경로
- `Expected`/`Received`가 기대값/실제값
- `ir_errors` 배열이 있으면 어느 필드가 왜 실패했는지 확인

**새 테스트 추가 예제**

`analyze()`가 감지한 서비스의 `detected_from`에 특정 파일이 포함되는지 검증하고 싶다면:

```typescript
// packages/analyzer/tests/analyze.test.ts에 추가
describe("fixture: node-http", () => {
  it("detected_from includes package.json", async () => {
    const result = await analyze(resolve(fixturesDir, "node-http"));
    const svc = result.services[0];
    expect(svc.detected_from).toContain("package.json");
  });
});
```

fixture가 새로 필요하면 `packages/analyzer/tests/fixtures/` 아래 디렉터리 하나 만들고 최소 `package.json`만 넣으면 된다.

---

## 4. 통합 지점 (팀원 이어받을 인터페이스)

### 은영 (빌드·프로비저닝)

`analyzeWithAI()` 결과에서 은영이 소비하는 필드:

```typescript
const result = await analyzeWithAI(sourcePath);
const ir = result.ai.ir_after;  // 검증된 최종 IR (Partial<Ir>)

// 빌드 핸들러가 읽는 것들:
ir.services["api"].build?.dockerfile   // Dockerfile 경로
ir.services["api"].build?.context      // build context 디렉터리
ir.services["api"].env                 // 주입할 env 이름 목록
ir.services["api"].size                // "small"|"medium"|"large"
ir.resources?.["db"]?.type             // "postgres"|"redis"
ir.deploy.profile                      // "aws-ecs-basic"|"onprem-docker-basic"
```

온프레미스 에이전트(롱 폴링) 응답에도 같은 IR이 포함된다. 에이전트 잡 응답 구조는 `docs/api-spec-v0.md` §8 참조.

### 김민서 (검증)

VERIFY handler가 이 데이터를 기준으로 배포 결과를 매칭한다:

```typescript
// VERIFY handler가 사용하는 것 (예정)
result.ai.ir_after.services["api"].port       // 헬스체크 포트
result.ai.ir_after.services["api"].health     // { path, expected_status, timeout_seconds }
// + deployment_id (DB에서 조회)
```

Q3 결정(VERIFY digest 확인 범위 A vs B) 보류 중. 이정 P0 코드 완료 후 민서와 별도 논의 예정 (`.omc/specs/deep-interview-backend-decisions.md` Card 3 참조).

### 김민성 (프론트)

`docs/api-spec-v0.md` 엔드포인트 12개 참조. 현재 직접 HTTP 통신. `packages/contracts` 공유 예정이지만 **아직 미구현**이다.

민성이 주로 쓰는 엔드포인트:

| 엔드포인트 | 용도 |
|-----------|------|
| `POST /deployments` | 배포 시작 |
| `GET /deployments/:id/events` (SSE) | 실시간 진행 상태 |
| `GET /deployments/:id/ir` | IR 확인 |
| `PATCH /deployments/:id/ir` | IR 수정 |
| `POST /deployments/:id/approvals` | 승인 게이트 |

SSE 이벤트 형식은 `docs/api-spec-v0.md` §4 참조.

### 조서현·안우진 (잠정 관측)

P2 범위. 메트릭 + Loki 로그 (D-45). 현재는 미착수. 향후 `apps/api`에서 메트릭 엔드포인트 노출하면 연결할 예정.

---

---

## 4.5 새 통합 지점 상세 (v2)

### 4.5.1 API → worker (pg-boss job)

`DeploymentService`가 소스 업로드 후 `analyze` job을 enqueue한다. worker가 이를 소비한다.

```typescript
// apps/api/src/services/deployment-service.ts (개념)
await boss.send("analyze", {
  deployment_id: dep.id,
  source_storage_key: storageKey,
  sha256,
  source_version_id: svId,
});
```

worker는 `registerAll(boss, deps)`에서 `boss.work("analyze", handler)`로 등록한다.

---

### 4.5.2 worker → API (pg_notify → SSE)

worker가 상태 전이 후 `pg_notify("deployment_events", JSON)`를 호출한다.

```
worker: notifier.notify(deployment_id, "state_changed", { status })
  → pool.query("SELECT pg_notify('deployment_events', $1)", [JSON.stringify({...})])
  → Postgres NOTIFY
  → API pg-listener client receives notification
  → sseBroker.publish(deploymentId, { event, data })
  → SSE clients receive event
```

프론트(민성)는 `GET /api/v1/deployments/:id/events` SSE로 실시간 상태를 받는다.

---

### 4.5.3 IR에 target_profile 적용 흐름

```
POST /api/v1/deployments (body: { target_profile: "aws-ecs-basic" })
  → deployments 테이블에 target_profile 저장
  → boss.send("analyze", { deployment_id, ... })
  → worker handleAnalyze()
       → analyzeWithAI() → ir_draft (deploy.profile = "aws-ecs-basic" 기본값)
       → SELECT target_profile FROM deployments WHERE id = $1
       → ir["deploy"]["profile"] = targetProfile  ← 덮어쓰기
       → INSERT ir_versions (ir_json = 덮어쓴 IR)
```

즉, analyzer가 도출한 IR의 `deploy.profile`은 항상 worker에서 `target_profile`로 최종 확정된다.

---

### 4.5.4 은영과의 인터페이스 (v2 업데이트)

은영의 `build`·`provision` 핸들러는 `apps/worker/src/handlers/build.ts`, `provision.ts`에 stub으로 있다. 은영이 구현할 때 필요한 데이터:

```typescript
// ir_versions 테이블에서 최신 IR 조회
const row = await pool.query(
  "SELECT ir_json FROM ir_versions WHERE deployment_id=$1 ORDER BY id DESC LIMIT 1",
  [deployment_id]
);
const ir: Partial<Ir> = row.rows[0].ir_json;

// 은영이 읽는 것
ir.deploy?.profile         // "aws-ecs-basic" | "onprem-docker-basic"
ir.services["api"].build   // { dockerfile, context }
ir.services["api"].size    // "small"|"medium"|"large"
ir.resources?.["db"]?.type // "postgres"
```

프로필 capabilities는 `getProfile(ir.deploy.profile)` 로 확인한다 (`@camellia/profiles`).

---

### 4.5.5 민서와의 인터페이스 (v2 업데이트)

`apps/worker/src/handlers/verify.ts` stub. 민서가 구현할 때:

```typescript
// verify handler가 사용하는 것
ir.services["api"].port       // 헬스체크 포트
ir.services["api"].health     // { path, expected_status, timeout_seconds }
ir.services["api"].expose     // "public" → ALB URL, "internal" → 내부 DNS
```

Q-01 (VERIFY digest 확인 범위 A vs B)은 2026-09-30 회의에서 **close** 됐다. 민서와 직접 sync 필요.

---

### 4.5.6 민성과의 인터페이스 (v2 업데이트)

`docs/api-spec-v1.md`에 48개 엔드포인트 전체 명세가 있다. v0의 12개에서 확장됨. 민성이 주로 쓰는 엔드포인트는 변경 없음:

| 엔드포인트 | 용도 |
|-----------|------|
| `POST /api/v1/deployments` | 배포 시작 (target_profile 포함) |
| `GET /api/v1/deployments/:id/events` (SSE) | 실시간 진행 상태 |
| `GET /api/v1/deployments/:id/ir` | IR 확인 |
| `PATCH /api/v1/deployments/:id/ir` | IR 수정 (user_edited source) |
| `POST /api/v1/deployments/:id/approvals` | 승인 게이트 (target/plan/patch) |

SSE 이벤트 형식은 `docs/api-spec-v1.md` §SSE 참조.

---

## 5. 실행·디버그 치트시트

```bash
# 의존성 설치
pnpm install

# ── DB 관련 (v2 신규) ─────────────────────────────────────────────
# Postgres 컨테이너 올리기 (5433 포트)
pnpm db:up

# SQL 마이그레이션 적용
pnpm db:migrate

# 컨테이너 + 볼륨 초기화
pnpm db:reset

# Postgres 로그 확인
pnpm db:logs

# ── 개발 서버 (v2 신규) ───────────────────────────────────────────
# API + worker 동시 실행 (concurrently)
pnpm dev

# API만
pnpm dev:api

# worker만
pnpm dev:worker

# ── 테스트 ────────────────────────────────────────────────────────
# 전체 패키지 테스트
pnpm -r --if-present test

# 패키지별
pnpm --filter @camellia/analyzer test
pnpm --filter @camellia/db test
pnpm --filter @camellia/storage test
pnpm --filter @camellia/profiles test
pnpm --filter @camellia/profile-matcher test
pnpm --filter @camellia/api test
pnpm --filter @camellia/worker test

# ── 타입 체크 ──────────────────────────────────────────────────────
pnpm --filter @camellia/analyzer typecheck
pnpm --filter @camellia/ir-schema typecheck

# ── 의존성 추가 ────────────────────────────────────────────────────
pnpm add fast-glob --filter @camellia/analyzer
pnpm add -D @types/node --filter @camellia/analyzer

# ── git ────────────────────────────────────────────────────────────
git log --oneline -10
git status --short
git diff HEAD~1
git log --oneline packages/analyzer/src/index.ts

# ── AWS ────────────────────────────────────────────────────────────
aws sts get-caller-identity --profile camellia
```

**새 패키지 만드는 절차 (예: `packages/contracts`)**

```bash
# 1. 폴더 생성
mkdir -p packages/contracts/src

# 2. package.json 작성
cat > packages/contracts/package.json << 'EOF'
{
  "name": "@camellia/contracts",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./src/index.ts", "import": "./src/index.ts" } },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "devDependencies": { "typescript": "^5.6.0", "vitest": "^2.1.0" }
}
EOF

# 3. tsconfig.json (analyzer/tsconfig.json 복사해서 수정)
# 4. src/index.ts 작성
# 5. 다른 패키지에서 사용
pnpm add @camellia/contracts@workspace:* --filter @camellia/analyzer
```

**`tsc --noEmit` 직접 실행** (typecheck 스크립트 미설정 패키지의 경우)

```bash
cd packages/ir-schema
npx tsc --noEmit
```

---

## 6. 자고 일어나서 30분 리포 파악 순서

1. **최근 커밋 확인**
   ```bash
   git log --oneline -10
   ```
   마지막으로 어디까지 작업했는지 파악.

2. **테스트 상태 확인**
   ```bash
   pnpm -r --if-present test
   ```
   PASS면 OK. FAIL이면 어느 케이스인지 확인.

3. **unresolved 필드 확인** (테스트 실패 시)
   테스트 에러 메시지의 `ir_errors` 배열에서 어떤 필드가 빠졌는지 확인.

4. **팀원 커밋 확인**
   ```bash
   git log --oneline --all -20
   ```
   다른 브랜치(main, 은영·민서·민성 브랜치) 변경사항 있으면 `docs/decisions.md` 최신 항목 확인.

5. **decisions.md 최신 결정 확인**
   ```bash
   grep -n "D-[0-9]\+\|Q-[0-9]\+" docs/decisions.md | tail -20
   ```
   새로운 D-XX 결정이 있으면 내 코드에 영향 여부 파악.

6. **DB 상태 확인** (v2 신규)
   ```bash
   # 컨테이너 떠있는지 확인
   docker ps | grep camellia-postgres
   # 안 떠있으면
   pnpm db:up && pnpm db:migrate
   ```

7. **타입 체크**
   ```bash
   pnpm --filter @camellia/analyzer typecheck
   pnpm --filter @camellia/ir-schema typecheck
   ```
   TS 에러가 있으면 어떤 파일 몇 번 줄인지 확인.

8. **오늘 할 일 확인**
   ```bash
   cat docs/todo-jeong.md
   ```
   가장 번호 작은 미완성 태스크부터 시작.

---

---

## 6.5 실행 시나리오 확장 (v2)

### 6.5.1 로컬 풀스택 실행 (docker compose + API + worker)

```bash
# 1. DB 올리기
pnpm db:up
# Postgres 16 컨테이너, 5433 포트, 볼륨 camellia-postgres-data

# 2. .env 준비 (.env.example 복사)
cp .env.example .env
# DATABASE_URL=postgres://camellia:camellia@localhost:5433/camellia
# STORAGE_ROOT=./storage
# ANTHROPIC_API_KEY=sk-ant-...  (선택)

# 3. 마이그레이션
pnpm db:migrate

# 4. API + worker 동시 실행
pnpm dev
# API  → http://localhost:3000
# worker → pg-boss consumer (별도 프로세스)
```

헬스 체크:
```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

---

### 6.5.2 두 target_profile 시나리오

**AWS ECS (기본)**

```bash
curl -X POST http://localhost:3000/api/v1/deployments \
  -H "Content-Type: multipart/form-data" \
  -F "source=@myapp.zip" \
  -F "target_profile=aws-ecs-basic"
# → deployment_id: 1
# → status: received → analyzing → awaiting_target_confirmation
```

worker의 analyze 핸들러가 `target_profile="aws-ecs-basic"`을 IR `deploy.profile`에 반영한다.

**온프레미스 Docker**

```bash
curl -X POST http://localhost:3000/api/v1/deployments \
  -H "Content-Type: multipart/form-data" \
  -F "source=@myapp.zip" \
  -F "target_profile=onprem-docker-basic"
```

`onprem-docker-basic` 프로필은 `max_services=5`, `cloud=onprem`. profile-matcher가 IR과 대조해서 `compatible` 여부를 판단한다.

**프로필 capabilities 차이**

| 항목 | aws-ecs-basic | onprem-docker-basic |
|------|--------------|---------------------|
| cloud | aws | onprem |
| max_services | 10 | 5 |
| sizes | small/medium/large | small/medium |
| default_region | ap-northeast-2 | local |

---

### 6.5.3 SSE 실시간 이벤트 수신

```bash
# 배포 ID 1의 이벤트 스트림 구독
curl -N http://localhost:3000/api/v1/deployments/1/events \
  -H "Accept: text/event-stream"
```

수신되는 이벤트 예시:
```
id: evt_a1b2c3d4e5f6g7h8
event: state_changed
data: {"status":"analyzing"}

id: evt_b2c3d4e5f6g7h8i9
event: analysis.progress
data: {"step":"detecting"}

id: evt_c3d4e5f6g7h8i9j0
event: state_changed
data: {"status":"awaiting_target_confirmation"}

id: evt_d4e5f6g7h8i9j0k1
event: approval_requested
data: {"gate":"target"}
```

재연결 시 `Last-Event-Id` 헤더를 보내면 SseBroker 버퍼(최근 100개)에서 누락 이벤트를 재전송한다.

---

### 6.5.4 실제 AI 호출 측정 결과 요약

`docs/measurement-2026-09-30.md` 전체 내용. 2026-09-29T23:52:10 KST 측정.

| Fixture | zip 크기 | 총 시간 | 입력 tokens | 비용 USD | IR valid |
|---------|---------|---------|------------|---------|---------|
| Express | 0.7 KB | 4.10s | 1,306 | $0.0244 | ✓ |
| Python FastAPI | 0.4 KB | 4.07s | 1,315 | $0.0245 | ✓ |
| Node + Postgres | 0.9 KB | 4.07s | 1,376 | $0.0254 | ✓ |
| MSA (2 서비스) | 1.3 KB | 4.07s | 1,469 | $0.0283 | ✓ |
| **합계** | | **4.08s 평균** | **5,466** | **$0.1027** | **4/4** |

- AI 호출 1회당 평균 **$0.0257** (하루 100회 → ~$2.57)
- 모든 fixture에서 `ir_valid: true`
- 캐시 미사용 (첫 측정) — 반복 호출 시 `cache_read_input_tokens` 증가로 비용 절감 가능
- 모델: claude-opus-4-5 (측정 시점)

상세 IR JSON 결과는 `docs/measurement-2026-09-30.md` 참조.

---

## 7. FAQ (예상 질문)

**Q1. 왜 `workspace:*` 프로토콜?**

`"@camellia/ir-schema": "workspace:*"`는 npm 레지스트리 대신 이 workspace 안의 패키지를 직접 쓰겠다는 의미다. `*`는 "workspace에 있는 버전 그대로". `pnpm publish` 할 때 자동으로 실제 버전으로 치환된다. 심링크로 연결되므로 `packages/ir-schema/src/schema.ts`를 수정하면 `packages/analyzer`에서 즉시 반영된다.

---

**Q2. 왜 `exports`를 `src/schema.ts`로 직접 가리키나?**

```json
// packages/ir-schema/package.json
"exports": {
  ".": { "types": "./src/schema.ts", "import": "./src/schema.ts" }
}
```

보통은 빌드 후 `dist/schema.js`를 가리키는데, 이 패키지는 vitest가 직접 TS를 실행하기 때문에 빌드 없이 소스를 바로 쓴다. `analyzer`도 vitest 환경에서는 TS를 직접 import하므로 `.ts` 경로가 더 단순하다. 배포용 빌드가 필요해지면 `dist/`로 바꿔야 한다.

---

**Q3. vitest가 왜 TS 파일 직접 실행 가능?**

vitest는 내부적으로 `esbuild`(또는 `vite` 플러그인)로 `.ts`를 즉석에서 트랜스파일한다. `tsc`를 따로 돌릴 필요 없이 소스 파일을 바로 import하고 실행한다. 그래서 `pnpm test`가 빌드 단계 없이 바로 된다.

---

**Q4. Zod parse가 왜 throw하나?**

```typescript
IrSchema.parse(data)  // 실패 시 ZodError throw
```

이건 의도된 설계다. "이 데이터는 반드시 맞아야 한다"는 불변식을 코드로 표현하는 것이다. 실패하면 프로그램을 계속 진행할 수 없다는 의미. 반면 `safeParse`는 "맞을 수도 있고 아닐 수도 있는데 결과를 직접 처리하겠다"는 경우에 쓴다.

이 리포에서는 `ir-builder.ts`와 `fill-unresolved.ts`에서 `safeParse`를 써서 에러를 `unresolved` 또는 `ir_errors`로 돌려준다. 최상위 오케스트레이터에서 최종 검증할 때 `parse()`를 써서 이 시점 이후론 IR이 맞다는 보장을 만들 것이다.

---

**Q5. async 함수 리턴 타입은 왜 항상 `Promise<T>`?**

`async function f(): Promise<T>` — async 함수는 항상 Promise를 반환한다. `return value`를 쓰면 JS 엔진이 `Promise.resolve(value)`로 감싼다. `await`는 그 Promise를 풀어서 값을 꺼낸다. 그래서 async/await는 사실 Promise 문법 설탕이다.

```typescript
async function getPort(): Promise<number> {
  return 3000;  // 실제로는 Promise.resolve(3000)
}

const port = await getPort();  // 3000
```

---

**Q6. dynamic import는 왜 사용?**

```typescript
// packages/analyzer/src/ai/anthropic-client.ts:21
const { default: Anthropic } = await import("@anthropic-ai/sdk");
```

두 가지 이유:
1. **선택적 의존성**: SDK가 설치 안 된 환경에서도 다른 기능은 동작해야 한다. 정적 import면 파일 로드 시점에 에러 남. dynamic import는 실제 호출할 때만 로드를 시도한다.
2. **트리 셰이킹**: 빌드 도구가 사용되지 않는 경로의 코드를 제거하기 쉽다.

API key가 없으면 `createClient()`를 호출하지 않으므로 `@anthropic-ai/sdk`도 로드 안 된다.

---

**Q7. ESM이 왜 요즘 표준인가?**

CommonJS(`require()`)는 Node.js 초창기 방식이다. ESM(`import/export`)은 브라우저 표준 모듈 시스템이고, Node.js 12+부터 공식 지원한다.

ESM의 장점:
- 브라우저·Node 동일 코드 (패키지 재사용)
- 정적 분석 가능 → 트리 셰이킹·빠른 빌드
- 순환 의존 처리 더 예측 가능

이 리포에서는 `package.json`에 `"type": "module"`을 설정해서 모든 `.js`를 ESM으로 처리한다. 그래서 `require()`를 쓰면 에러 난다.

---

## 변경 이력

| 날짜 | 버전 | 내용 |
|------|------|------|
| 2026-09-30 | v1 | 초안 작성 (이정용) — ir-schema·analyzer·통합 지점·TS 기초 |
| 2026-09-30 | v2 | packages/db·storage·profiles·profile-matcher 추가; apps/api·worker 추가; docker-compose·.env.example; 루트 scripts(db:up/migrate/reset, dev); 노션 DB 링크; 결정 D-52·D-53·Q-01 close; 버그픽스(analyze.ts deploy.profile 하드코딩); §2.5·§4.5·§6.5 신규 섹션; §6 step 6(DB 상태) 추가 |
