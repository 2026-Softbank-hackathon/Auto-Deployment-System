# API Spec v1 — Auto Deployment System (전체 커버)

> **이 문서는 api-spec-v0.md의 확장입니다.**
> - **v0**: P0 데모 완주 기준, 엔드포인트 16개 (인증·프로젝트·배포 핵심·에이전트)
> - **v1**: functional-spec-v3의 P0/P1/P2 전체 기능 커버. 총 **47개** 엔드포인트 + MCP 섹션
>
> 기준 아키텍처: v5.4.1 (2026-09-30)
> 작성일: 2026-09-30
> 스택: TypeScript · Fastify · Zod · pg-boss

---

## 우선순위 색상 규칙

| 우선순위 | 의미 | Notion 색상 |
|---------|------|------------|
| **P0** | 데모 필수 (10/1 20:00) | 초록 |
| **P1** | 해커톤 제출 목표 (10/3 10:00) | 주황 |
| **P2** | 시간 여유 시 구현 | 회색 |

---

## 담당자 범례

| 약칭 | 담당자 | 역할 |
|------|--------|------|
| 이정 | 이정 | 분석·IR·발표 |
| 은영 | 신은영 | 어댑터·빌드·프로비저닝·환경 락 |
| 민서 | 김민서 | 배포 검증 |
| 민성 | 김민성 | 프론트엔드 |
| 서현/우진 | 조서현·안우진 | 관측·확장 |
| 공통 | — | 공통 인프라 |

---

## 목차

### v0 계승 (P0)
1. [인증](#1-인증)
2. [프로젝트](#2-프로젝트)
3. [배포 핵심](#3-배포-핵심)
4. [에이전트](#4-에이전트)

### v1 신규 (P0 추가)
5. [프로필](#5-프로필-p0)
6. [분석 리포트](#6-분석-리포트-p0)
7. [Terraform 플랜 조회](#7-terraform-플랜-조회-p0)
8. [헬스체크](#8-헬스체크-p0)
9. [배포 이력](#9-배포-이력-p0)

### v1 신규 (P1)
10. [환경 관리](#10-환경-관리-p1)
11. [확장 모듈 카탈로그](#11-확장-모듈-카탈로그-p1)
12. [시크릿 관리](#12-시크릿-관리-p1)
13. [비용 예측](#13-비용-예측-p1)
14. [AI 사용량](#14-ai-사용량-p1)
15. [환경 락](#15-환경-락-p1)
16. [로그 스트림](#16-로그-스트림-p1)
17. [AI 실패 진단](#17-ai-실패-진단-p1)
18. [사용자 계정](#18-사용자-계정-p1)
19. [환경 전환](#19-환경-전환-p1)

### v1 신규 (P2)
20. [관측 — 메트릭·트레이스](#20-관측--메트릭트레이스-p2)
21. [감사 로그](#21-감사-로그-p2)
22. [비용 실제 청구](#22-비용-실제-청구-p2)
23. [팀·권한](#23-팀권한-p2)
24. [CI·웹훅](#24-ciwebhook-p2)
25. [CLI 토큰](#25-cli-토큰-p2)
26. [MCP 서버](#26-mcp-서버-p2)

---

## 공통 규칙

v0와 동일. 요약:
- Base URL: `https://<control-plane-host>/api/v1`
- 인증: `Authorization: Bearer <api_key>`
- 에러 형식: `{ error: { code, message, hint }, requestId }`
- 페이지네이션: 커서 기반 (`cursor`, `limit`, `nextCursor`)
- ID: BIGINT을 문자열로 직렬화. 타임스탬프: ISO 8601 UTC

---

## 1. 인증

> v0 API-01 계승. 상세 스키마는 api-spec-v0.md 5절 참고.

### API-01 · POST /auth/session · P0 · 담당: 공통

세션 토큰 발급.

| 코드 | 의미 |
|------|------|
| `201` | 발급 성공 |
| `401` | 잘못된 API Key |
| `429` | 발급 횟수 초과 |

---

## 2. 프로젝트

> v0 API-02~04 계승.

### API-02 · POST /projects · P0 · 담당: 공통

프로젝트 생성. `SRC-01`

| 코드 | 의미 |
|------|------|
| `201` | 생성 성공 |
| `400` | 유효성 오류 |
| `409` | 이름 중복 |

---

### API-03 · GET /projects · P0 · 담당: 민성

프로젝트 목록 조회. 커서 페이지네이션.

| 코드 | 의미 |
|------|------|
| `200` | 조회 성공 |
| `401` | 인증 실패 |

---

### API-04 · GET /projects/:id · P0 · 담당: 민성

단일 프로젝트 상세.

| 코드 | 의미 |
|------|------|
| `200` | 조회 성공 |
| `404` | 없음 |

---

## 3. 배포 핵심

> v0 API-05~14 계승. 상세 스키마는 api-spec-v0.md 7절 참고.

### API-05 · POST /deployments · P0 · 담당: 이정

소스 zip 업로드 + 배포 시작. `multipart/form-data`. `SRC-02`, `DEP-01`

**요청 필드**

| 필드 | 타입 | 필수 |
|------|------|------|
| `projectId` | string | 필수 |
| `targetEnvironments` | string[] (`aws`\|`onprem`) | 필수 |
| `source` | File (zip) | 필수 |
| `profileId` | string | 선택 (기본: `aws-ecs-basic`) |

| 코드 | 의미 |
|------|------|
| `202` | 접수 성공 |
| `409` | 환경 잠금 중 |
| `413` | 파일 크기 초과 |

```json
// 202 응답
{ "deploymentId": "42", "status": "received", "eventsUrl": "/api/v1/deployments/42/events" }
```

---

### API-06 · GET /deployments/:id · P0 · 담당: 민성

배포 상태·현재 단계·승인 게이트 조회. `DEP-02`

| 코드 | 의미 |
|------|------|
| `200` | 조회 성공 |
| `404` | 없음 |

---

### API-07 · GET /deployments/:id/events · P0 · 담당: 민성

SSE 스트림. `DEP-03`
- `Accept: text/event-stream`
- `Last-Event-Id` 헤더로 재연결 시 누락 복구

이벤트 종류: `state_changed` · `analysis.progress` · `approval_requested` · `lock.changed` · `step_completed`

| 코드 | 의미 |
|------|------|
| `200` | 스트림 연결 성공 |
| `404` | 배포 없음 |

---

### API-08 · GET /deployments/:id/ir · P0 · 담당: 이정

IR(앱 명세 YAML → JSON) 조회. `IR-01`

| 코드 | 의미 |
|------|------|
| `200` | 조회 성공 |
| `404` | IR 없음 (아직 분석 전) |

---

### API-09 · PATCH /deployments/:id/ir · P1 · 담당: 이정

IR 수동 편집. 낙관적 락(`version` 필드). `IR-03`

| 코드 | 의미 |
|------|------|
| `200` | 수정 성공 |
| `409` | version 불일치 또는 편집 불가 상태 |

---

### API-10 · POST /deployments/:id/missing-resources · P0 · 담당: 이정

빠진 요소 결정 제출. `awaiting_target_confirmation` 상태에서만 유효.

**요청**

```json
{ "decisions": [{ "resource": "cache", "action": "exclude" }] }
```

| 코드 | 의미 |
|------|------|
| `200` | 결정 반영 |
| `409` | 잘못된 상태 |

---

### API-11 · POST /deployments/:id/approvals · P0 · 담당: 이정

승인 게이트 처리. `gate`: `target` | `plan`

**요청**

```json
{ "gate": "target", "decision": "approve" }
```

| 코드 | 의미 |
|------|------|
| `200` | 결정 제출 성공 |
| `409` | 게이트 만료 또는 없음 |

---

### API-12 · GET /deployments/:id/logs · P0 · 담당: 은영

단계별 로그 조회. `LOG-02`

**쿼리 파라미터**

| 파라미터 | 타입 | 설명 |
|---------|------|------|
| `step` | enum | `analyze`\|`build`\|`provision`\|`verify` |
| `tail` | number | 최근 N줄 (기본 전체) |
| `stream` | boolean | `true` = SSE 실시간 스트리밍 (P1) |

| 코드 | 의미 |
|------|------|
| `200` | 로그 반환 |
| `204` | 아직 로그 없음 |

---

### API-13 · POST /deployments/:id/rollback · P1 · 담당: 은영

이전 성공 digest로 롤백. `DEP-05`

**요청**

```json
{ "targetDeploymentId": "41", "reason": "신규 버전 오류" }
```

| 코드 | 의미 |
|------|------|
| `202` | 롤백 접수 |
| `400` | 롤백 가능한 이전 배포 없음 |
| `409` | 환경 잠금 중 |

---

### API-14 · POST /deployments/:id/switch · P1 · 담당: 은영

트래픽을 다른 환경으로 전환. `SW-01`, `SW-02`

**요청**

```json
{ "targetEnv": "onprem", "reason": "비용 절감" }
```

| 코드 | 의미 |
|------|------|
| `202` | 전환 접수 |
| `404` | 배포 없음 또는 succeeded 아님 |
| `409` | 전환 불가 상태 |

---

## 4. 에이전트

> v0 API-15~16 계승.

### API-15 · GET /agent/jobs · P0 · 담당: 은영

온프레미스 에이전트 롱 폴링. timeout 최대 30초.

| 코드 | 의미 |
|------|------|
| `200` | job 있음 |
| `204` | 타임아웃까지 job 없음 (즉시 재폴링) |

---

### API-16 · POST /agent/jobs/:id/result · P0 · 담당: 은영

에이전트 job 결과 보고.

| 코드 | 의미 |
|------|------|
| `200` | 결과 수신 |
| `409` | 이미 완료된 job |

---

## 5. 프로필 (P0)

> `REC-04` — 배포 대상 선택 UI에서 프로필 직접 선택 지원

### API-17 · GET /profiles · P0 · 담당: 민성

프로필 카탈로그 리스트. 배포 생성 시 대상 선택 UI에서 사용.

**응답 예시**

```json
{
  "items": [
    {
      "id": "aws-ecs-basic",
      "name": "AWS ECS Fargate (기본)",
      "provider": "aws",
      "capabilities": ["http", "postgres", "redis"],
      "estimatedMonthlyCost": 45.00,
      "description": "ECS Fargate + ALB + RDS (선택) 기본 구성"
    },
    {
      "id": "onprem-docker-basic",
      "name": "온프레미스 Docker Compose",
      "provider": "onprem",
      "capabilities": ["http"],
      "estimatedMonthlyCost": 0,
      "description": "Docker Compose + Cloudflare Tunnel"
    }
  ],
  "nextCursor": null
}
```

| 코드 | 의미 |
|------|------|
| `200` | 조회 성공 |

---

### API-18 · GET /profiles/:id · P0 · 담당: 민성

프로필 상세 + capabilities 선언 조회.

**응답 스키마**

```typescript
export const ProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.enum(["aws", "onprem", "gcp", "azure"]),
  capabilities: z.array(z.string()),  // 지원 리소스 타입 목록
  estimatedMonthlyCost: z.number(),
  description: z.string(),
  requiredInputs: z.array(z.object({
    key: z.string(),
    label: z.string(),
    type: z.enum(["string", "select", "boolean"]),
    options: z.array(z.string()).optional(),
  })),
});
```

| 코드 | 의미 |
|------|------|
| `200` | 조회 성공 |
| `404` | 프로필 없음 |

---

## 6. 분석 리포트 (P0)

> `ANL-07` — 분석 결과 리포트 조회

### API-19 · GET /deployments/:id/analysis-report · P0 · 담당: 이정

분석 완료 후 서비스·리소스·경고·미결 항목 조회.

**응답 스키마**

```typescript
export const AnalysisReportSchema = z.object({
  deploymentId: z.string(),
  detectedStack: z.object({
    language: z.string(),
    framework: z.string().optional(),
    runtimeVersion: z.string().optional(),
  }),
  services: z.array(z.object({
    name: z.string(),
    type: z.enum(["http", "worker", "static", "job"]),
    path: z.string().optional(),
  })),
  resources: z.array(z.object({
    name: z.string(),
    type: z.string(),   // postgres, redis, s3 등
    detected: z.boolean(),
  })),
  warnings: z.array(z.object({
    code: z.string(),
    message: z.string(),
    file: z.string().optional(),
    line: z.number().optional(),
  })),
  unresolved: z.array(z.object({
    field: z.string(),
    reason: z.string(),
  })),
  migrationTool: z.string().optional(),  // prisma, rails, flyway 등
  generatedAt: z.string().datetime(),
});
```

**응답 예시**

```json
{
  "deploymentId": "42",
  "detectedStack": { "language": "typescript", "framework": "express", "runtimeVersion": "20" },
  "services": [{ "name": "api", "type": "http", "path": "./api" }],
  "resources": [
    { "name": "db", "type": "postgres", "detected": true },
    { "name": "cache", "type": "redis", "detected": true }
  ],
  "warnings": [
    { "code": "HARDCODED_SECRET", "message": "하드코딩된 JWT_SECRET 감지", "file": "src/auth.ts", "line": 12 },
    { "code": "NO_HEALTH_CHECK", "message": "/health 엔드포인트 없음" }
  ],
  "unresolved": [],
  "migrationTool": "prisma",
  "generatedAt": "2026-09-30T03:02:00.000Z"
}
```

| 코드 | 의미 |
|------|------|
| `200` | 조회 성공 |
| `404` | 분석 리포트 없음 (분석 미완료) |

---

## 7. Terraform 플랜 조회 (P0)

> `PRV-02` — plan 승인 게이트 미리보기

### API-20 · GET /deployments/:id/plan · P0 · 담당: 은영

Terraform plan 요약. `awaiting_plan_approval` 상태에서 사용자가 리소스 목록 확인 후 승인.

**응답 스키마**

```typescript
export const TerraformPlanSummarySchema = z.object({
  deploymentId: z.string(),
  planId: z.string(),
  summary: z.object({
    toAdd: z.number().int(),
    toChange: z.number().int(),
    toDestroy: z.number().int(),
  }),
  resources: z.array(z.object({
    action: z.enum(["add", "change", "destroy", "no-op"]),
    type: z.string(),        // aws_ecs_service, aws_rds_instance 등
    name: z.string(),
    changes: z.array(z.string()).optional(),  // 변경 필드 목록
  })),
  estimatedMonthlyCost: z.number().optional(),
  generatedAt: z.string().datetime(),
});
```

**응답 예시**

```json
{
  "deploymentId": "42",
  "planId": "plan_01j9x3",
  "summary": { "toAdd": 5, "toChange": 0, "toDestroy": 0 },
  "resources": [
    { "action": "add", "type": "aws_ecs_service", "name": "todo-app-api" },
    { "action": "add", "type": "aws_lb", "name": "todo-app-alb" },
    { "action": "add", "type": "aws_lb_target_group", "name": "todo-app-tg" },
    { "action": "add", "type": "aws_security_group", "name": "todo-app-sg" },
    { "action": "add", "type": "aws_cloudwatch_log_group", "name": "todo-app-logs" }
  ],
  "estimatedMonthlyCost": 42.50,
  "generatedAt": "2026-09-30T03:10:00.000Z"
}
```

| 코드 | 의미 |
|------|------|
| `200` | plan 조회 성공 |
| `404` | plan 없음 (아직 planning 단계 전) |
| `409` | plan 조회 불가 상태 |

---

## 8. 헬스체크 (P0)

> `VRF-01`, `VRF-04` — 실시간 헬스체크 결과

### API-21 · GET /deployments/:id/health · P0 · 담당: 민서

배포의 헬스체크 현황 조회. verifying 상태에서 연속 3회 통과 여부 확인.

**응답 스키마**

```typescript
export const HealthStatusSchema = z.object({
  deploymentId: z.string(),
  status: z.enum(["pending", "checking", "passed", "failed"]),
  checks: z.array(z.object({
    attempt: z.number().int(),
    timestamp: z.string().datetime(),
    statusCode: z.number().int().optional(),
    latencyMs: z.number().int().optional(),
    passed: z.boolean(),
    error: z.string().optional(),
  })),
  consecutivePassed: z.number().int(),  // 연속 통과 횟수 (3 = succeeded)
  requiredPasses: z.number().int(),     // 필요 횟수 (3)
  targetUrl: z.string().optional(),
});
```

**응답 예시**

```json
{
  "deploymentId": "42",
  "status": "checking",
  "checks": [
    { "attempt": 1, "timestamp": "2026-09-30T03:20:00Z", "statusCode": 200, "latencyMs": 45, "passed": true },
    { "attempt": 2, "timestamp": "2026-09-30T03:20:10Z", "statusCode": 200, "latencyMs": 38, "passed": true }
  ],
  "consecutivePassed": 2,
  "requiredPasses": 3,
  "targetUrl": "https://todo-app.ecs.example.com/health"
}
```

| 코드 | 의미 |
|------|------|
| `200` | 조회 성공 |
| `404` | 배포 없음 |

---

## 9. 배포 이력 (P0)

> `LOG-01`

### API-22 · GET /projects/:id/deployments · P0 · 담당: 민성

프로젝트별 배포 이력 목록.

**쿼리 파라미터**

| 파라미터 | 타입 | 설명 |
|---------|------|------|
| `cursor` | string | 페이지 커서 |
| `limit` | number | 기본 20, 최대 100 |
| `status` | string | 상태 필터 (`succeeded`\|`failed`\|`queued` 등) |

**응답 예시**

```json
{
  "items": [
    {
      "id": "43",
      "status": "succeeded",
      "sourceVersion": "sha256:abc...",
      "targetEnvironments": ["aws"],
      "createdAt": "2026-09-30T04:00:00Z",
      "succeededAt": "2026-09-30T04:22:00Z"
    },
    {
      "id": "42",
      "status": "succeeded",
      "sourceVersion": "sha256:xyz...",
      "targetEnvironments": ["aws", "onprem"],
      "createdAt": "2026-09-30T03:00:00Z",
      "succeededAt": "2026-09-30T03:22:00Z"
    }
  ],
  "nextCursor": null,
  "total": 2
}
```

| 코드 | 의미 |
|------|------|
| `200` | 조회 성공 |
| `404` | 프로젝트 없음 |

---

## 10. 환경 관리 (P1)

> `REC-01` — 온프레미스 VM·AWS 자격증명 등록

### API-23 · POST /environments · P1 · 담당: 은영

사용자 환경(AWS 계정·온프레미스 VM) 등록.

**요청 스키마**

```typescript
export const CreateEnvironmentRequestSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(["aws", "onprem"]),
  // AWS: AssumeRole 방식 권장
  awsConfig: z.object({
    roleArn: z.string(),
    externalId: z.string().optional(),
    region: z.string().default("ap-northeast-1"),
  }).optional(),
  // 온프레미스: 에이전트 등록 토큰
  onpremConfig: z.object({
    agentRegistrationToken: z.string(),
    hostname: z.string().optional(),
  }).optional(),
});
```

| 코드 | 의미 |
|------|------|
| `201` | 등록 성공 |
| `400` | 유효성 오류 |
| `409` | 이름 중복 |

---

### API-24 · GET /environments · P1 · 담당: 은영

등록된 환경 목록.

| 코드 | 의미 |
|------|------|
| `200` | 조회 성공 |

---

### API-25 · GET /environments/:id · P1 · 담당: 은영

환경 상세 + 에이전트 상태.

**응답 예시**

```json
{
  "id": "1",
  "name": "prod-aws",
  "type": "aws",
  "status": "connected",
  "agentStatus": null,
  "lastSeenAt": null
}
```

| 코드 | 의미 |
|------|------|
| `200` | 조회 성공 |
| `404` | 없음 |

---

### API-26 · DELETE /environments/:id · P1 · 담당: 은영

환경 삭제. 진행 중인 배포가 있으면 거부.

| 코드 | 의미 |
|------|------|
| `204` | 삭제 성공 |
| `409` | 진행 중인 배포 존재 |

---

## 11. 확장 모듈 카탈로그 (P1)

> `U-05` 미결 항목 — `missing_resources` 결정 시 `add_module` 선택 후보 목록

### API-27 · GET /modules · P1 · 담당: 이정

사용 가능한 확장 모듈 카탈로그. `POST /missing-resources`의 `moduleId` 목록 조회용.

**응답 예시**

```json
{
  "items": [
    {
      "id": "redis-elasticache",
      "name": "Redis (ElastiCache)",
      "resourceType": "redis",
      "provider": "aws",
      "estimatedMonthlyCost": 15.00,
      "description": "AWS ElastiCache Redis 싱글 노드"
    },
    {
      "id": "postgres-rds",
      "name": "PostgreSQL (RDS)",
      "resourceType": "postgres",
      "provider": "aws",
      "estimatedMonthlyCost": 25.00,
      "description": "AWS RDS PostgreSQL db.t3.micro"
    }
  ],
  "nextCursor": null
}
```

| 코드 | 의미 |
|------|------|
| `200` | 조회 성공 |

---

## 12. 시크릿 관리 (P1)

> `DAT-02` — Postgres AES-GCM 암호화 저장. 값은 응답에 평문 노출 불가.

### API-28 · POST /secrets · P1 · 담당: 이정

시크릿 저장. 값은 AES-GCM 암호화 후 DB 저장.

**요청**

```json
{ "name": "JWT_SECRET", "value": "super-secret-value", "projectId": "1" }
```

**응답** — 값 필드 없음

```json
{ "name": "JWT_SECRET", "projectId": "1", "createdAt": "2026-09-30T03:00:00Z" }
```

| 코드 | 의미 |
|------|------|
| `201` | 저장 성공 |
| `409` | 동일 이름 중복 |

---

### API-29 · GET /secrets · P1 · 담당: 이정

시크릿 목록 (이름만, 값 없음). `projectId` 쿼리로 필터.

**응답 예시**

```json
{
  "items": [
    { "name": "JWT_SECRET", "projectId": "1", "updatedAt": "2026-09-30T03:00:00Z" },
    { "name": "DATABASE_URL", "projectId": "1", "updatedAt": "2026-09-30T03:01:00Z" }
  ]
}
```

| 코드 | 의미 |
|------|------|
| `200` | 조회 성공 |

---

### API-30 · DELETE /secrets/:name · P1 · 담당: 이정

시크릿 삭제.

| 코드 | 의미 |
|------|------|
| `204` | 삭제 성공 |
| `404` | 없음 |

---

## 13. 비용 예측 (P1)

> `CST-03`, `REC-06` — 프로필 + 크기 기준 월 예상 비용

### API-31 · GET /projects/:id/cost/estimate · P1 · 담당: 서현/우진

프로필별 월 예상 비용 계산. 가격 카탈로그 기반.

**쿼리 파라미터**

| 파라미터 | 타입 | 설명 |
|---------|------|------|
| `profileId` | string | 필수 (예: `aws-ecs-basic`) |
| `size` | string | `small`\|`medium`\|`large` (기본: `small`) |
| `resources` | string | 쉼표 구분 리소스 타입 (예: `postgres,redis`) |

**응답 예시**

```json
{
  "projectId": "1",
  "profileId": "aws-ecs-basic",
  "size": "small",
  "breakdown": [
    { "item": "ECS Fargate (0.25 vCPU, 0.5 GB)", "monthlyCost": 8.50 },
    { "item": "Application Load Balancer", "monthlyCost": 16.20 },
    { "item": "RDS PostgreSQL db.t3.micro", "monthlyCost": 14.40 },
    { "item": "CloudWatch Logs", "monthlyCost": 1.50 }
  ],
  "totalMonthly": 40.60,
  "currency": "USD",
  "note": "트래픽·스토리지 제외 기본 인스턴스 비용 기준"
}
```

| 코드 | 의미 |
|------|------|
| `200` | 계산 성공 |
| `400` | 프로필 또는 크기 오류 |

---

## 14. AI 사용량 (P1)

> `CST-01` — 배포당 토큰·비용 기록

### API-32 · GET /deployments/:id/ai-usage · P1 · 담당: 이정

배포 1회당 AI API 토큰·비용 조회.

**응답 스키마**

```typescript
export const AiUsageSchema = z.object({
  deploymentId: z.string(),
  totalTokenIn: z.number().int(),
  totalTokenOut: z.number().int(),
  totalCostUsd: z.number(),
  breakdown: z.array(z.object({
    step: z.enum(["analyze", "patch", "diagnose"]),
    model: z.string(),
    tokenIn: z.number().int(),
    tokenOut: z.number().int(),
    costUsd: z.number(),
  })),
});
```

**응답 예시**

```json
{
  "deploymentId": "42",
  "totalTokenIn": 12400,
  "totalTokenOut": 3200,
  "totalCostUsd": 0.048,
  "breakdown": [
    { "step": "analyze", "model": "claude-sonnet-4-5", "tokenIn": 8000, "tokenOut": 2000, "costUsd": 0.030 },
    { "step": "patch", "model": "claude-sonnet-4-5", "tokenIn": 4400, "tokenOut": 1200, "costUsd": 0.018 }
  ]
}
```

| 코드 | 의미 |
|------|------|
| `200` | 조회 성공 |
| `404` | 배포 없음 |

---

## 15. 환경 락 (P1)

> `LCK-01`, `LCK-02`

### API-33 · GET /env-locks · P1 · 담당: 은영

현재 활성 환경 락 목록.

**응답 예시**

```json
{
  "items": [
    {
      "lockId": "lock_01j9x3",
      "environment": "aws",
      "projectId": "1",
      "deploymentId": "42",
      "acquiredAt": "2026-09-30T03:05:00Z",
      "expiresAt": "2026-09-30T04:05:00Z"
    }
  ]
}
```

| 코드 | 의미 |
|------|------|
| `200` | 조회 성공 |

---

### API-34 · GET /deployments?status=queued · P1 · 담당: 은영

대기열 배포 목록. `LCK-02` — 락 해제 후 순번 표시용.

기존 `GET /projects/:id/deployments` 에 `status=queued` 필터로 처리 가능. 별도 엔드포인트 불필요. 위 API-22에 포함.

---

## 16. 로그 스트림 (P1)

> `LOG-02` — 실시간 로그 스트리밍

### API-35 · GET /deployments/:id/logs/stream · P1 · 담당: 은영

진행 중인 단계의 실시간 로그 라인 SSE 스트리밍. `stream=true` 파라미터를 API-12에 추가하는 방식으로 구현 가능. 또는 별도 엔드포인트.

**요청**

```
GET /api/v1/deployments/:id/logs/stream?step=build
Authorization: Bearer <api_key>
Accept: text/event-stream
```

**이벤트 형식**

```
event: log_line
data: { "line": "[00:45] 빌드 완료. digest: sha256:deadbeef...", "ts": "2026-09-30T03:15:45Z" }
```

| 코드 | 의미 |
|------|------|
| `200` | 스트림 연결 |
| `404` | 배포 없음 |

---

## 17. AI 실패 진단 (P1)

> `FIX-01`, `FIX-02`

### API-36 · GET /deployments/:id/diagnosis · P1 · 담당: 이정

실패 배포의 AI 진단 결과 조회. 원인 요약 + 수정 후보.

**응답 스키마**

```typescript
export const DiagnosisSchema = z.object({
  deploymentId: z.string(),
  failedStep: z.enum(["analyze", "build", "provision", "verify"]),
  summary: z.string(),  // AI 원인 요약
  patchCandidates: z.array(z.object({
    file: z.string(),
    diff: z.string(),
    reason: z.string(),
  })),
  generatedAt: z.string().datetime(),
});
```

**응답 예시**

```json
{
  "deploymentId": "42",
  "failedStep": "build",
  "summary": "Dockerfile에서 NODE_ENV 환경변수가 누락되어 빌드 중 npm ci 실패",
  "patchCandidates": [
    {
      "file": "Dockerfile",
      "diff": "@@ -5,0 +5 @@\n+ENV NODE_ENV=production",
      "reason": "NODE_ENV 기본값 설정 추가"
    }
  ],
  "generatedAt": "2026-09-30T03:16:00Z"
}
```

| 코드 | 의미 |
|------|------|
| `200` | 진단 성공 |
| `404` | 배포 없음 또는 실패 상태 아님 |

---

## 18. 사용자 계정 (P1)

> `USR-01`

### API-37 · POST /users · P1 · 담당: 공통

사용자 계정 생성.

**요청**

```json
{ "email": "user@example.com", "password": "...", "name": "홍길동" }
```

| 코드 | 의미 |
|------|------|
| `201` | 생성 성공 |
| `409` | 이메일 중복 |

---

### API-38 · GET /users/me · P1 · 담당: 공통

현재 인증된 사용자 정보.

**응답 예시**

```json
{ "id": "1", "email": "user@example.com", "name": "홍길동", "createdAt": "2026-09-30T03:00:00Z" }
```

| 코드 | 의미 |
|------|------|
| `200` | 조회 성공 |
| `401` | 인증 실패 |

---

## 19. 환경 전환 (P1)

> `SW-01~03` — 9/30 데모 포인트. `POST /deployments/:id/switch`는 API-14로 이미 정의.

추가 전용 엔드포인트:

### API-39 · POST /environments/:id/switch · P1 · 담당: 은영

환경 단위 트래픽 전환. 고정 도메인의 라우팅 대상 변경.

**요청**

```json
{ "targetDeploymentId": "42", "reason": "AWS → 온프레미스 전환" }
```

**응답 예시**

```json
{
  "switchJobId": "sw_01j9...",
  "from": "aws",
  "to": "onprem",
  "estimatedSwitchSec": 15,
  "domainUrl": "https://todo-app.example.com"
}
```

| 코드 | 의미 |
|------|------|
| `202` | 전환 접수 |
| `409` | 전환 불가 |

---

## 20. 관측 — 메트릭·트레이스 (P2)

> `OBS-02`, `OBS-03` (OBS-04 트레이스 폐기)

### API-40 · GET /deployments/:id/metrics · P2 · 담당: 서현/우진

배포의 CPU·메모리·요청 수 메트릭. Prometheus 연동.

**쿼리 파라미터**

| 파라미터 | 타입 | 설명 |
|---------|------|------|
| `from` | string | ISO 8601 시작 시각 |
| `to` | string | ISO 8601 종료 시각 |
| `resolution` | string | `1m`\|`5m`\|`1h` |

**응답 예시**

```json
{
  "deploymentId": "42",
  "metrics": {
    "cpuPercent": [{ "ts": "2026-09-30T03:00:00Z", "value": 12.5 }],
    "memoryMb": [{ "ts": "2026-09-30T03:00:00Z", "value": 245.0 }],
    "requestsPerMin": [{ "ts": "2026-09-30T03:00:00Z", "value": 48 }]
  }
}
```

| 코드 | 의미 |
|------|------|
| `200` | 조회 성공 |
| `404` | 배포 없음 |

---

## 21. 감사 로그 (P2)

> `LOG-03` — 설정 변경·시크릿 수정·권한 변경 이력

### API-41 · GET /audit-logs · P2 · 담당: 서현/우진

감사 로그 목록. `projectId` 또는 `userId` 필터 가능.

**쿼리 파라미터**

| 파라미터 | 타입 | 설명 |
|---------|------|------|
| `projectId` | string | 프로젝트 필터 |
| `action` | string | 행동 필터 (`secret.updated`\|`approval.granted` 등) |
| `from` | string | 시작 시각 |
| `cursor` | string | 페이지 커서 |

**응답 예시**

```json
{
  "items": [
    {
      "id": "audit_01j9x3",
      "action": "secret.updated",
      "actor": { "userId": "1", "name": "홍길동" },
      "resource": { "type": "secret", "name": "JWT_SECRET" },
      "projectId": "1",
      "timestamp": "2026-09-30T03:00:00Z"
    }
  ],
  "nextCursor": null
}
```

| 코드 | 의미 |
|------|------|
| `200` | 조회 성공 |

---

## 22. 비용 실제 청구 (P2)

> `CST-04` 참고

### API-42 · GET /projects/:id/cost/actual · P2 · 담당: 서현/우진

실제 AWS 청구 비용 조회. Cost Explorer API 연동.

**쿼리 파라미터**

| 파라미터 | 타입 | 설명 |
|---------|------|------|
| `month` | string | `YYYY-MM` 형식 (기본: 이번 달) |

**응답 예시**

```json
{
  "projectId": "1",
  "month": "2026-09",
  "totalCostUsd": 38.42,
  "breakdown": [
    { "service": "Amazon ECS", "costUsd": 18.50 },
    { "service": "Amazon RDS", "costUsd": 14.40 },
    { "service": "Elastic Load Balancing", "costUsd": 5.52 }
  ],
  "currency": "USD"
}
```

| 코드 | 의미 |
|------|------|
| `200` | 조회 성공 |
| `503` | AWS Cost Explorer 연동 실패 |

---

## 23. 팀·권한 (P2)

> `USR-02`

### API-43 · POST /teams · P2 · 담당: 공통

팀 생성.

```json
// 요청
{ "name": "camellia-team", "projectId": "1" }
```

| 코드 | 의미 |
|------|------|
| `201` | 생성 성공 |

---

### API-44 · GET /teams · P2 · 담당: 공통

팀 목록.

| 코드 | 의미 |
|------|------|
| `200` | 조회 성공 |

---

### API-45 · POST /teams/:id/members · P2 · 담당: 공통

팀 멤버 추가.

```json
// 요청
{ "userId": "2", "role": "member" }
```

| 코드 | 의미 |
|------|------|
| `201` | 추가 성공 |
| `409` | 이미 멤버 |

---

## 24. CI·Webhook (P2)

> `CI-01`, `CI-02`

### API-46 · POST /webhooks/github · P2 · 담당: 서현/우진

GitHub push 이벤트 수신 → 자동 배포 트리거.

**헤더**

```
X-GitHub-Event: push
X-Hub-Signature-256: sha256=<hmac>
```

**요청**: GitHub push payload (표준 형식)

| 코드 | 의미 |
|------|------|
| `202` | 트리거 접수 |
| `400` | 서명 검증 실패 |

---

## 25. CLI 토큰 (P2)

> `UI-02`

### API-47 · POST /cli/tokens · P2 · 담당: 공통

CLI용 장기 토큰 발급.

```json
// 요청
{ "name": "my-laptop", "expiresInDays": 90 }
// 응답
{ "tokenId": "tok_01j9...", "token": "cli-sk-xxxx", "name": "my-laptop", "expiresAt": "2026-12-29T00:00:00Z" }
```

> 주의: 토큰 값은 발급 시점 1회만 반환. 재조회 불가.

| 코드 | 의미 |
|------|------|
| `201` | 발급 성공 |

---

### API-48 · DELETE /cli/tokens/:id · P2 · 담당: 공통

CLI 토큰 폐기.

| 코드 | 의미 |
|------|------|
| `204` | 폐기 성공 |
| `404` | 없음 |

---

## 26. MCP 서버 (P2)

> `UI-05` — 외부 AI 도구(IDE 등)에서 배포 기능 호출. REST API 아님, 별도 프로토콜.

MCP(Model Context Protocol) 서버는 표준 stdio 또는 SSE 트랜스포트로 연결.

### 엔드포인트

```
MCP Transport: stdio | SSE (http://localhost:3000/mcp)
```

### 제공 Tool 목록

| Tool 이름 | 설명 | 우선순위 |
|-----------|------|---------|
| `create_project` | 프로젝트 생성 | P2 |
| `deploy` | 소스 업로드 + 배포 시작 | P2 |
| `get_deployment_status` | 배포 상태 조회 | P2 |
| `approve` | 승인 게이트 처리 | P2 |
| `rollback` | 롤백 | P2 |
| `get_logs` | 로그 조회 | P2 |
| `list_deployments` | 배포 이력 조회 | P2 |

### Resource 목록

| Resource URI | 설명 |
|-------------|------|
| `deployment://{id}` | 배포 상태 리소스 |
| `ir://{deploymentId}` | IR 명세 리소스 |

### 연결 예시 (Claude Desktop)

```json
// claude_desktop_config.json
{
  "mcpServers": {
    "camellia-deploy": {
      "command": "npx",
      "args": ["@camellia/mcp-server"],
      "env": { "CAMELLIA_API_KEY": "sk-camellia-xxx" }
    }
  }
}
```

---

## 에러 코드 목록 (v1 추가분)

v0 에러 코드에 추가:

| code | HTTP | 설명 | hint |
|------|------|------|------|
| `ENVIRONMENT_NOT_FOUND` | 404 | 환경 없음 | GET /environments 로 등록된 환경 확인 |
| `ENVIRONMENT_LOCKED` | 409 | 환경에 진행 중인 배포 존재 | GET /env-locks 로 현재 락 확인 |
| `SECRET_ALREADY_EXISTS` | 409 | 동일 이름 시크릿 중복 | DELETE /secrets/:name 후 재등록 |
| `PLAN_NOT_READY` | 404 | Terraform plan 미생성 | awaiting_plan_approval 상태 진입 후 조회 |
| `SWITCH_IN_PROGRESS` | 409 | 이미 전환 중 | SSE state_changed 이벤트로 완료 대기 |
| `DIAGNOSIS_UNAVAILABLE` | 404 | 진단 결과 없음 (실패 상태 아님) | failed 상태 배포에서만 사용 가능 |
| `MODULE_NOT_FOUND` | 400 | moduleId가 카탈로그에 없음 | GET /modules 로 유효한 모듈 목록 확인 |
| `COST_ESTIMATE_UNAVAILABLE` | 503 | 비용 카탈로그 조회 실패 | 잠시 후 재시도 |

---

## functional-spec-v3 기능 ID 커버리지

| 기능 그룹 | 기능 ID | 커버 API | 상태 |
|-----------|---------|---------|------|
| SRC (소스) | SRC-01 | API-02 | 커버 |
| SRC | SRC-02 | API-05 | 커버 |
| SRC | SRC-03 | — (P2, Git 연동 별도) | 미구현 P2 |
| SRC | SRC-04 | API-05 (sha256) | 커버 |
| SRC | SRC-05 | API-19 (services[]) | 커버 |
| ANL (분석) | ANL-01~06 | API-19 | 커버 |
| ANL | ANL-07 | API-19 | 커버 |
| ANL | ANL-08 | API-05 (캐시 내부) | 커버 |
| AGT (에이전트) | AGT-01~03 | API-15~16 (내부) | 커버 |
| AGT | AGT-04 | API-11 (approvals) | 커버 |
| PAT (패치) | PAT-01 | API-19 (Dockerfile) | 커버 |
| PAT | PAT-02~08 | API-36 (diagnosis+patch) | 커버 |
| IR | IR-01 | API-08 | 커버 |
| IR | IR-02 | API-08 (Zod 검증) | 커버 |
| IR | IR-03 | API-09 | 커버 |
| IR | IR-04~05 | API-09 (overrides) | 커버 |
| REC | REC-01 | API-23~26 | 커버 |
| REC | REC-02~03 | — (P2 추천 엔진) | 미구현 P2 |
| REC | REC-04 | API-17~18 | 커버 |
| REC | REC-05 | API-05 (multi-target) | 커버 |
| REC | REC-06 | API-31 | 커버 |
| BLD | BLD-01~04 | API-15~16 (내부) | 커버 |
| PRV | PRV-01 | API-20 (plan) | 커버 |
| PRV | PRV-02 | API-20 | 커버 |
| PRV | PRV-03~04 | API-15~16 (에이전트) | 커버 |
| PRV | PRV-05~06 | — (P2 GCP/Azure) | 미구현 P2 |
| PRV | PRV-07~09 | API-15~16 (내부) | 커버 |
| PRV | PRV-10~11 | — (P2 Lambda/EC2) | 미구현 P2 |
| SCL | SCL-01~04 | API-05 (내부 IR) | 커버 |
| SCL | SCL-05 | — (P2 부하 테스트) | 미구현 P2 |
| DAT | DAT-01 | API-09 (PATCH /ir env) | 커버 |
| DAT | DAT-02 | API-28~30 | 커버 |
| DAT | DAT-03~04 | API-15~16 (내부 RDS) | 커버 |
| DAT | DAT-05~06 | — (P2) | 미구현 P2 |
| MIG | MIG-01~04 | API-19 (detection) + 내부 | 커버 |
| MIG | MIG-05 | — (P2) | 미구현 P2 |
| DEP | DEP-01 | API-05 | 커버 |
| DEP | DEP-02 | API-06 (상태 머신) | 커버 |
| DEP | DEP-03 | API-07 (SSE) | 커버 |
| DEP | DEP-04 | API-21 (health) | 커버 |
| DEP | DEP-05 | API-13 (rollback) | 커버 |
| DEP | DEP-06~07 | — (P2 블루그린/카나리) | 미구현 P2 |
| DEP | DEP-08~09 | API-15~16 (내부) | 커버 |
| SW | SW-01~03 | API-14, API-39 | 커버 |
| NET | NET-01~03 | API-06 (publicUrls) | 커버 |
| NET | NET-04~05 | API-23~26 (내부 VPC) | 커버 |
| NET | NET-06 | — (P2 커스텀 도메인) | 미구현 P2 |
| OBS | OBS-01 | API-12 (logs) | 커버 |
| OBS | OBS-02~03 | API-40 (metrics) | 커버 |
| OBS | OBS-04~05 | — (폐기) | 폐기 |
| OBS | OBS-06 | — (P2) | 미구현 P2 |
| LOG | LOG-01 | API-22 | 커버 |
| LOG | LOG-02 | API-12, API-35 | 커버 |
| LOG | LOG-03 | API-41 | 커버 |
| LOG | LOG-04 | — (P2) | 미구현 P2 |
| FIX | FIX-01~02 | API-36 | 커버 |
| FIX | FIX-03~04 | API-13 (retry) 내부 | 커버 |
| LCK | LCK-01 | API-05/11 (락 획득) | 커버 |
| LCK | LCK-02 | API-22 (status=queued) | 커버 |
| LCK | LCK-03 | API-20 (plan+S3 state) | 커버 |
| LCK | LCK-04 | — (폐기) | 폐기 |
| LCK | LCK-05 | API-33 (heartbeat 내부) | 커버 |
| CST | CST-01 | API-32 | 커버 |
| CST | CST-02 | — (analytics 별도 미결) | 미결 |
| CST | CST-03 | API-31 | 커버 |
| CST | CST-04 | — (P2) | 미구현 P2 |
| CI | CI-01 | API-46 | 커버 |
| CI | CI-02~04 | — (P2) | 미구현 P2 |
| UI | UI-01 | 전체 | 커버 |
| UI | UI-02 | API-47~48 | 커버 |
| UI | UI-03~04 | API-07 (SSE) | 커버 |
| UI | UI-05 | 26절 MCP | 커버 |
| UI | UI-06 | — (P2 Slack) | 미구현 P2 |
| USR | USR-01 | API-37~38 | 커버 |
| USR | USR-02 | API-43~45 | 커버 |
| USR | USR-03 | — (P2) | 미구현 P2 |
| USR | USR-04 | API-05 (동시 처리) | 커버 |
| USR | USR-05 | — (P2) | 미구현 P2 |
| USR | USR-06 | API-15~16 (job 복구) | 커버 |
| VRF | VRF-01 | API-21 | 커버 |
| VRF | VRF-02 | API-21 (smoke) | 커버 |
| VRF | VRF-03 | API-21 (digest 확인) | 커버 |
| VRF | VRF-04 | API-21 | 커버 |
| SMP | SMP-01~04 | 별도 샘플 앱 저장소 | 해당 없음 |
| DMO | DMO-01~02 | 운영 스크립트 | 해당 없음 |

**매핑 미결**: CST-02 (`GET /analytics/ai-roi`) — 별도 추가 필요 (P1)

---

## 미결 항목 (v1 추가)

| # | 항목 | 상태 | 비고 |
|---|------|------|------|
| V-01 | CST-02 `GET /analytics/ai-roi` 엔드포인트 미명세 | 미결 | P1. AI 효과 지표 (자동 복구 성공률 등) |
| V-02 | 에이전트 등록 `POST /agent/register` | 미결 | 1회용 토큰 → 장기 API Key 교환 (v0 U-10) |
| V-03 | `GET /ci/workflow` GitHub Actions 파일 생성 | 미결 | P2. CI-02 |
| V-04 | Slack 알림 연동 | 미결 | P2. UI-06 |
| V-05 | GCP·Azure 환경 등록 스키마 | 미결 | P2. PRV-05~06 |
| V-06 | `POST /deployments/:id/build` 빌드 재시도 | 검토 필요 | FIX-03 구현 시 필요할 수 있음 |

---

*생성: 2026-09-30 · 기준: functional-spec-v3.md + api-spec-v0.md + 아키텍처 v5.4.1*
