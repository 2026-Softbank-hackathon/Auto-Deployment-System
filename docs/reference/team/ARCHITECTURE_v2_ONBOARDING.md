# 아키텍처 v2 · 온보딩 기획서 (2026-09-29)

> **상태**: pending approval · 목표 아키텍처(target state) 를 온보딩 문법으로 서술한 기획서
> **관계**: `docs/ARCHITECTURE_IMPROVEMENTS_v1.md` 의 Top 10 권고를 전량 채택했다고 가정. 현행 코드 대비 델타는 각 절 끝 "델타" 박스에 명시.
> **읽는 사람**: 팀에 처음 합류한 개발자 · 심사 자료를 준비하는 팀원 · 발표 스크립트 저자
> **목표**: 이 문서 하나만 읽으면 (1) 시스템 전체를 30분 안에 이해 (2) 새 기능/새 클라우드/새 AI 도구를 어디에 붙이는지 즉시 판단 (3) 데모 시연 흐름을 따라갈 수 있게 함
> **자매 문서**: 현행(2026-09-28) 상태 온보딩은 `docs/ONBOARDING_GUIDE.md`, 트레이드오프 근거는 `docs/ARCHITECTURE_IMPROVEMENTS_v1.md`, 결정 로그는 `docs/decisions.md`.

---

## 목차

| 부 | 절 | 대상 독자 |
|---|---|---|
| **A. 시작** | §0 이 문서 · §1 30초 요약 · §2 왜 존재하나 · §3 한 장 아키텍처 | 신규 합류자 |
| **B. 핵심 개념** | §4 4 레이어 · §5 IR · §6 Adapter · §7 Approval · §8 State Machine · §9 Queue · §10 Executor · §11 Secret 3+1 · §12 관측 · §13 SSE · §14 AI 파이프라인 | 백엔드 · 인프라 |
| **C. 코드 지도** | §15 리포지토리 · §16 데이터 모델 · §17 서비스 실행 단위 | 온보딩 첫날 |
| **D. 실습** | §18 Quickstart · §19 개발 흐름 · §20 유스케이스 5종 | 실전 |
| **E. 확장** | §21 새 서비스 · §22 새 클라우드 · §23 새 MCP tool · §24 새 관측 백엔드 | 기능 추가 |
| **F. 품질** | §25 테스트 · §26 관측·디버깅 · §27 트러블슈팅 | 운영 |
| **G. 참고** | §28 용어 · §29 안티패턴 · §30 Roadmap · §31 FAQ · §32 참고 문서 | 리퍼런스 |

---

# 파트 A · 시작

## 0. 이 문서 · 무엇이고 무엇이 아닌가

**이 문서는**:
- 목표 아키텍처(target) 를 확정된 사실처럼 서술한다. 채택 여부는 팀 회의에서 승인. 채택 전에는 `pending approval`.
- 신규 팀원이 30분 안에 시스템 전체를 이해할 수 있는 온보딩 지도.
- 심사 자료 · 발표 스크립트의 원본. §2 심사 매핑 · §20 유스케이스는 그대로 발표에 재활용.

**이 문서가 아닌 것**:
- **현행 코드 스냅샷 아님** — 그건 `docs/ONBOARDING_GUIDE.md`.
- **결정의 근거 문서 아님** — 왜 이 선택인지는 `docs/ARCHITECTURE_IMPROVEMENTS_v1.md` § "옵션 · 절충" 절에 있음.
- **API 레퍼런스 아님** — `packages/contracts/openapi.yaml` 참조.

**절 끝 "델타 박스" 표기법**:
- 🆕 = 이 문서에서 신규 도입
- 🔧 = 현행 코드 있으나 개선
- ✅ = 현행 유지 (변경 없음)

---

## 1. 30초 요약

**한 문장**: 로컬에서 만든 웹앱 zip 을 올리면, 규칙과 AI 가 협업해 배포 명세(IR) 를 만들고, 클라우드(AWS · GCP · Azure) 또는 온프레미스에 원클릭으로 배포하는 배포 시스템 (호스팅 플랫폼 아님 · 사용자 계정에 배포).

**세 문장 요약**:
1. **명세 중심 (IR)**: 앱을 클라우드 중립 명세로 먼저 바꾸고, 환경마다 다른 것은 프로바이더 어댑터가 흡수한다.
2. **AI 는 판단만, 실행은 코드**: 분석·패치·진단·설명은 Claude, 실행은 검증된 Terraform/OpenTofu 어댑터. `requires_approval` 도구는 API 서버가 코드로 강제.
3. **컨트롤 플레인 / 데이터 플레인 분리**: 컨트롤이 멈춰도 배포된 앱은 살아있다. 새 클라우드는 어댑터 하나 추가로 지원.

**대회 테마**: One Action, Infinite Clouds.

---

## 2. 왜 존재하는가 · 심사 매핑

### 2-1. 문제

기존 배포 도구들은 하나의 클라우드에 종속되거나(Vercel, Fly.io), Kubernetes 를 필수로 요구하거나, 사용자가 명세를 손으로 써야 한다. "손으로 만든 웹앱 → 원하는 환경 → 원클릭" 이 여전히 매끄럽지 않다.

### 2-2. 이 시스템의 차별점

| 축 | 우리 접근 |
|---|---|
| **다중 클라우드** | IR + 어댑터 → 새 클라우드 = 어댑터 폴더 하나 |
| **온프레미스** | 에이전트 Pull + Cloudflare Tunnel → 방화벽 · NAT 뒤에도 동작 |
| **AI 활용** | 규칙 우선 · AI 는 규칙 못푸는 것만 · prompt caching 으로 반복 프롬프트 90% 절약 |
| **UX** | 웹 · CLI · Slack · MCP 4채널 동일 API → Claude Code 로도 배포 가능 |
| **안전성** | 3-gate 승인(patch · target · plan) + OIDC 페더레이션(장기 키 0) + 파일 릴레이 시크릿 |

### 2-3. 심사 100점 매핑

| 항목 | 배점 | 이 아키텍처의 근거 |
|---|---:|---|
| 완성도 · 데모 | 30 | e2e 5종 검증(온프레미스 · AWS Fargate · 카나리 롤백 · MSA · Go 하이브리드) + 다운타임 0 블루그린 |
| 클라우드 활용 | 30 | 4개 어댑터 + IR overrides + OpenTofu state 암호화 + OIDC 페더레이션 + OTel 사이드카 |
| 팀 개발 · 문서화 | 20 | `docs/decisions.md` D-01~D-34 + `ARCHITECTURE_IMPROVEMENTS_v1.md` 절충 + 이 문서 |
| 독창성 | 10 | MCP · llms.txt · CLI 3-layer / 파일 릴레이 시크릿 / 하이브리드 워커 |
| AI 활용 | 10 | prompt caching · tool_use · `requires_approval` 코드 강제 · 사용량 대시보드 |

### 2-4. 대회 규칙 요약

- 사전 개발 9/29 ~ 10/2 · 제출 10/3 10:00 · 중간보고 10/3 14:00 · 최종 발표 10/4 15:00 (5분 · 슬라이드 금지)
- 인프라 예산 ₩300,000 (AI API 비용 포함 여부 미확인 · §31 FAQ 참고)
- 심사관 관점: "환경 차이 흡수 · 이식성 · 클라우드 고유 기능" 이 30점의 핵심

---

## 3. 아키텍처 한 장 요약

```
┌──────────────────────────── 사용자 표면 (Client) ─────────────────────────┐
│  Web 대시보드 (Next.js 15)  ·  CLI (softbank)  ·  Slack Bot  ·  MCP 서버 │
│  ── 모두 같은 REST API + SSE 를 사용한다 ──                                │
└──────────────────────────────────┬────────────────────────────────────────┘
                                   │ HTTPS · SSE (Last-Event-ID)
┌──────────────────────── 컨트롤 플레인 (Control Plane) ────────────────────┐
│  API 서버 (Fastify · N대 · 무상태)                                        │
│  ├─ Orchestrator (활성 1 + 대기 1 · Postgres advisory lock 리더 선출)    │
│  │   └─ 상태 머신 16개 · env_locks · approvals · 재시작 자동 재개        │
│  ├─ AI 에이전트 (Anthropic Claude · prompt caching · 파일 릴레이 시크릿) │
│  ├─ Obs-Gateway (환경 어댑터 조회 → Loki forward)                        │
│  ├─ Recommender (규칙 + pricing-catalog)                                 │
│  └─ Workers                                                              │
│      analyzer · builder(BuildKit multi-arch) · provisioner(Terraform)   │
│      verifier(Go 하이브리드 · k6 는 TS)                                  │
│                                                                          │
│  📦 저장소:                                                              │
│    Postgres  (단일 진실 · 작업 큐 SKIP LOCKED + LISTEN/NOTIFY)          │
│    Redis     (SSE 이벤트 스트림만 · 캐시)                                │
│    MinIO     (소스 · 로그 · 결정된 IR 아카이브)                          │
│    Registry  (빌드 이미지)                                               │
│    OpenBao   (시크릿 · KV v2 · dev=file / prod=KMS auto-unseal)         │
│    SOPS+age  (부팅 시크릿 · git 커밋 가능)                               │
└──────────────────────────────────┬────────────────────────────────────────┘
                                   │ Cloud API Push · OIDC federation
                                   │ 온프레미스: 에이전트 Pull (롱 폴링)
┌──────────────────────── 데이터 플레인 (Data Plane) ───────────────────────┐
│  AWS ECS Fargate (native blue/green · IR canary → CANARY_10PCT_5M)      │
│  GCP Cloud Run   (traffic split)                                         │
│  Azure Container Apps (revision)                                         │
│  온프레미스: Docker Compose (헬스 게이트 블루그린 · <name>-next 스왑)    │
│              + Cloudflare Tunnel 사이드카 (Traefik 라벨 스왑)            │
│  ── 각 어댑터는 Executor 인터페이스 뒤에 셸/SSH/컨테이너를 감춘다 ──     │
└──────────────────────────────────┬────────────────────────────────────────┘
                                   │ OTel Collector 사이드카 자동 주입
┌──────────────────────── 관측 · 피드백 (Observation) ─────────────────────┐
│  Grafana + Prometheus + Loki + Pyroscope (본선: + Tempo · Mimir)        │
│  대시보드: 배포 처리량 · 스텝 소요 · 비용 · 인시던트 post-mortem         │
│  각 클라우드 백엔드(CloudWatch · Cloud Logging · Azure Monitor) 는       │
│  어댑터 조회 → Loki forward → 하나의 뷰                                  │
└──────────────────────────────────────────────────────────────────────────┘
```

### 요청 흐름 한 줄

**"zip 업로드 → 분석 → 3-gate 승인 → 빌드 → 프로비저닝 → 검증 → 공개 URL"** — 사람 개입 3회, 나머지는 자동.

---

# 파트 B · 핵심 개념

## 4. 4 레이어 · 각각의 존재 이유

| 레이어 | 역할 | "이 레이어가 없으면?" |
|---|---|---|
| **Client** | 사람 · 외부 AI 도구의 입구. 웹 · CLI · Slack · MCP · CI 모두 같은 API 를 소비 | 웹만 있으면 AI 도구 통합 불가, 승인 병목 |
| **Control Plane** | 배포를 지휘. 상태 · 결정 · 판단이 여기에 | 데이터 플레인이 도구 없이 배포 · 재시도 · 롤백 불가 |
| **Data Plane** | 사용자 앱이 실제로 실행되는 곳 | 배포 대상이 없다 |
| **Observation** | 데이터 플레인 상태를 컨트롤 플레인으로 되돌리는 피드백 루프 | AI 진단 · 카나리 자동 롤백 불가 |

**분리 원칙**: 컨트롤 플레인이 죽어도 데이터 플레인은 살아있다. 컨트롤 플레인을 다시 띄우면 미완 배포를 이어서 진행한다.

---

## 5. 핵심 개념 1 · IR (Intermediate Representation)

### 무엇인가

앱을 **클라우드 중립적인 배포 명세** 로 먼저 바꾼 다음, 환경마다 다른 코드(=어댑터) 가 실제 리소스로 번역. LLVM IR 과 같은 개념.

### 6개 최상위 필드

```yaml
schemaVersion: "0.1.0"
metadata:
  name: todo-app                # 이 앱이 무엇인지
services:
  api:                          # 무엇을 실행할지 (Docker Compose · K8s Deployment 개념)
    build: ./
    port: 3000
    public: true
    healthcheck: /health
    env: [DATABASE_URL]
    dependsOn: [db]
resources:                      # 어떤 관리형 인프라가 필요한지 (Terraform · Crossplane)
  db:
    type: postgres
    version: "16"
deploy:                         # 어떻게 롤아웃할지 (Argo Rollouts · Deployment.strategy)
  strategy: canary
  canary:
    steps: [{weight: 10}, {weight: 50}, {weight: 100}]
    rollbackConditions:
      errorRate: 0.05
overrides:                      # 클라우드마다 다른 튜닝 (Helm values · Kustomize overlays)
  aws:  { db: { instanceClass: "db.t3.small" } }
  gcp:  { api: { concurrency: 80 } }
expose:                         # 외부 노출 방식 (K8s Ingress · Cloudflare Zero Trust)
  cloudflareTunnel: true
  otel: true                   # OTel Collector 사이드카 자동 주입 (default true)
```

### 왜 IR 인가 (짧게)

- **N+M 변환**: 앱 N × 환경 M 조합 대신, 앱 N → IR → 환경 M. `docs/DEPLOYMENT_SPEC_TRADEOFF.md` §5-3 참조.
- **AI 출력 스키마 검증 가능**: Zod → JSON Schema → LLM 프롬프트 · `IrSchema.parse()` 로 즉시 검증.
- **탈출 통로**: `overrides` 는 `z.record(z.record(z.unknown()))` — 어떤 필드가 오든 파싱 통과, 해당 어댑터만 해석.

### 어디에 있나

- Zod 스키마: `packages/ir-schema/src/index.ts`
- JSON Schema export: `packages/contracts/openapi.yaml` (Zod → OpenAPI 3.1)
- 위상 정렬(`dependsOn`): `packages/ir-schema/src/topo.ts`
- 오버라이드 병합: `packages/ir-schema/src/overrides.ts`

### 델타

- ✅ IR 스키마 자체는 현행 유지 (D-03)
- 🆕 `expose.otel` 필드 신규 (기본 true · OTel Collector 사이드카 자동 주입)
- 🔧 IR diff 유틸 (`packages/ir-schema/src/diff.ts`) — 웹 대시보드 "AI 가 바꾼 것" 뷰용

---

## 6. 핵심 개념 2 · Provider Adapter

### 인터페이스 계약

```typescript
interface ProviderAdapter {
  capabilities(): Capabilities
  plan(ir: IR, target: Target): Promise<Plan>
  apply(plan: Plan, ctx: DeployContext): Promise<ApplyResult>
  rollout(strategy: Strategy, ctx: DeployContext): Promise<RolloutResult>
  rollback(toVersion: string, ctx: DeployContext): Promise<void>
  destroy(target: Target): Promise<void>
  endpoints(ctx: DeployContext): Promise<string[]>
}

interface ObsAdapter {
  query(q: ObsQuery): Promise<NormalizedResult>
}
```

### 어댑터 목록

| 프로바이더 | 위치 | 컴퓨트 | 관측 |
|---|---|---|---|
| `onprem` | `packages/adapters/onprem` | Docker Compose (헬스 게이트 블루그린 스왑) | Loki + Prometheus (사이드카) |
| `aws` | `packages/adapters/aws` | ECS Fargate + ALB (native blue/green) | CloudWatch → Loki forward |
| `gcp` | `packages/adapters/gcp` | Cloud Run (traffic split) | Cloud Logging → Loki forward |
| `azure` | `packages/adapters/azure` | Container Apps (revision) | Azure Monitor → Loki forward |

### `capabilities()` 의 힘

추천 엔진과 오케스트레이터가 "이 환경이 카나리를 지원하는가?" 를 어댑터에 묻는다. 예:

```typescript
const caps = adapter.capabilities()
if (!caps.strategies.includes('canary') && ir.deploy.strategy === 'canary') {
  return {
    warning: 'This adapter does not natively support canary; falling back to blue-green.',
    fallbackStrategy: 'blue-green',
  }
}
```

### 델타

- 🔧 AWS 어댑터에 ECS native blue/green (2025-10 GA) 매핑 — `packages/adapters/aws/terraform/ecs-service.tf` 의 `deployment_configuration.strategy = "BLUE_GREEN"` + `traffic_shift.type = "CANARY_10_PERCENT_5_MINUTES"`
- 🔧 온프레미스 어댑터에 헬스 게이트 블루그린 스왑 (조서현 §경험1)
- ✅ 어댑터 인터페이스 자체는 유지

---

## 7. 핵심 개념 3 · Approval Gate

### 3개 게이트 (사람 개입 순간)

| # | 게이트 | 언제 | 사용자가 결정할 것 |
|---|---|---|---|
| 1 | `patch` | AI 가 코드 수정안(diff) 을 제시했을 때 | Approve · Reject · Modify |
| 2 | `target` | 추천 엔진이 후보 환경을 제시했을 때 | 어느 환경(어느 클라우드/리전) 에 배포할지 |
| 3 | `plan` | Terraform plan 이 나왔을 때 | 어떤 리소스가 생성/변경/삭제될지 확인 |

### 4채널 승인

같은 승인을 **웹 · CLI · Slack · MCP** 어디서든 결정할 수 있다. 첫 결정만 반영(`approvals.decided_by` unique).

**웹**: `ApprovalWidget.tsx` 카드에 diff/preview 통합
**Slack**: Block Kit "Approve/Reject/Comment" 인터랙티브 버튼 → `POST /slack/interactions`
**CLI**: `softbank deploy` 가 SSE 스트림에서 `approval_requested` 이벤트 오면 TTY 에 diff 렌더 + `[a]pprove / [r]eject / [w]eb` 프롬프트
**MCP**: `approve(deployment_id, kind, decision)` tool

### `requires_approval` 강제

에이전트 도구 스키마에 `requires_approval: true` 인 도구는 API 서버가 승인 이벤트 없이 실행하지 않는다. 프롬프트로 강제하지 않고 **코드로 강제**.

```json
{
  "name": "apply_plan",
  "description": "Apply Terraform plan to create/update infrastructure",
  "input_schema": { ... },
  "requires_approval": true
}
```

### 만료 정책

승인 대기 30분 초과 → 자동 취소. 오케스트레이터가 소유(D-26).

### 델타

- ✅ 3-gate 자체는 유지 (D-07)
- 🆕 Slack 인터랙티브 · CLI 인터랙티브 · MCP tool 신규
- 🔧 `approvals.decided_by` unique constraint (중복 결정 409)

---

## 8. 핵심 개념 4 · State Machine

### 16 상태

```
received → analyzing → awaiting_patch_approval → awaiting_target_confirmation
       → [queued] → building → planning → awaiting_plan_approval
       → provisioning → deploying → verifying → succeeded

실패 경로: 어느 단계든 → diagnosing → (승인) → 재시도 or rolling_back → failed
승인 거부: → cancelled
```

### 락 획득 시점 (D-15)

**환경 확정 직후** 획득(계획 전). 이유: 배포 생성 시점에는 대상 환경이 미정(추천 후 확정) → 접수 시점에 잠글 대상이 없음.

### 활성/대기 리더 선출

```typescript
// apps/orchestrator/src/leader.ts (신규)
const ADVISORY_LOCK_KEY = hash('softbank-orchestrator-leader')

async function tryBecomeLeader(): Promise<boolean> {
  const { rows } = await pg.query(
    'SELECT pg_try_advisory_lock($1) AS acquired',
    [ADVISORY_LOCK_KEY]
  )
  return rows[0].acquired
}
```

리더 사망 → 대기 인스턴스가 60s + jitter 이내 승격. 승격 직후 미완 배포를 `resume_attempts` 컬럼으로 1회만 자동 재개.

### 재시작 자동 재개 정책 (조서현 §경험3)

```sql
UPDATE deployments
SET state = <resumable_state>,
    resume_attempts = resume_attempts + 1
WHERE id = $1
  AND resume_attempts < 1;  -- 2번째 시도는 자동 실패
```

**이유**: 배포 자체가 서버를 죽이는 경우 무한 재시작 루프 방지.

### 델타

- ✅ 상태 목록 · 락 시점은 유지
- 🆕 활성/대기 리더 선출 (advisory lock)
- 🆕 `resume_attempts` 컬럼 · 부팅 시 1회만 재개

---

## 9. 핵심 개념 5 · Job Queue (Postgres SKIP LOCKED + LISTEN/NOTIFY)

### 왜 Postgres 큐인가

- **이중 쓰기 제거**: 상태 변경(deployments UPDATE) 과 작업 생성(jobs INSERT) 을 **한 트랜잭션**으로 묶는다. Redis 큐로는 이게 불가능.
- **내구성 자동**: Postgres 백업 = 큐 백업.
- **인프라 최소**: Redis 는 SSE 이벤트 스트림만 (실시간 로그 push · 재연결 재생).

### 워커 루프 (실제 코드 · `apps/lib/src/worker.ts:76-107`)

```typescript
while (running) {
  await client.query('BEGIN')
  const job = await client.query(`
    SELECT id, type, payload FROM jobs
    WHERE status = 'pending' AND locked_until < now()
    ORDER BY priority DESC, created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  `)
  if (!job.rows[0]) { await client.query('COMMIT'); await sleep(pollInterval); continue }
  await client.query('UPDATE jobs SET locked_until = now() + $2 * interval \'1 second\', ...', [job.rows[0].id, leaseSec])
  await client.query('COMMIT')
  await handler(job.rows[0])
}
```

### LISTEN/NOTIFY (폴링 대신 이벤트)

오케스트레이터는 폴링 대신 `LISTEN "jobs.completed"` 로 대기. 워커가 `pg_notify('jobs.completed', jobId)` 로 알림.

```typescript
// apps/orchestrator/src/index.ts:13-15
await client.query('LISTEN "deployments.new"')
await client.query('LISTEN "approvals.decided"')
await client.query('LISTEN "jobs.completed"')
```

### 라이브러리 선택

- **orchestrator**: `pg-boss@10` (자체 스케줄러 · cron · pubsub 지원)
- **worker 4종**: `apps/lib/src/worker.ts` 자체 루프 (SKIP LOCKED + 지수 백오프)
- **Go verifier**: `pgx v5` 로 동일 SKIP LOCKED + `WaitForNotification`

### 델타

- ✅ 큐 아키텍처 유지 (D-11)
- ✅ 라이브러리 유지 (pg-boss + 자체 워커)

---

## 10. 핵심 개념 6 · Executor 인터페이스

### 왜 필요한가

셸 명령, `docker` CLI, `terraform` CLI, `ssh` 세션이 코드 곳곳에 흩어지면 (1) 테스트가 힘들고 (2) 로컬/원격 스위치가 힘들다. 조서현 §경험3: **모든 외부 명령을 한 인터페이스로 감쌈**.

### 인터페이스 (신규 · `apps/lib/src/executor.ts`)

```typescript
export interface Executor {
  run(cmd: Cmd): Promise<{ code: number; stdout: string; stderr: string }>
  stream(cmd: Cmd, onLine: (line: string) => void): Promise<{ code: number }>
  openRawStream(cmd: Cmd): AsyncIterable<Buffer>
}
```

### 구현체

| 이름 | 용도 |
|---|---|
| `LocalExecutor` | 컨트롤 플레인 자체 서브프로세스 · `child_process.spawn` |
| `SshExecutor` | 원격 서버 세션 (선택 · SSH 방식 fallback) |
| `FakeExecutor` | 테스트 · 명령 순서 단언 |
| `ContainerExecutor` | 샌드박스 빌드 (루트리스 BuildKit) |

### 어디에 쓰나

- provisioner: `terraform apply` · `docker compose up` (LocalExecutor)
- builder: `docker buildx build` (ContainerExecutor)
- verifier: `curl` health · `k6 run` (LocalExecutor)
- onprem-agent: 원격 셸 실행 (LocalExecutor · SshExecutor 선택)

### 델타

- 🆕 Executor 인터페이스 (현재는 5곳에 spawn 흩어짐 · REFACTOR_AUDIT D)

---

## 11. 핵심 개념 7 · Secret 3+1 계층

### 왜 3+1 인가

시크릿의 성격이 다르기 때문. 하나의 저장소에 다 넣으면 (1) 부팅이 시크릿 저장소 부팅에 의존 (2) 데모 재현성 낮음 (3) AI 문맥 유출 방어선 부족.

### 계층 1 · 부팅 시크릿 (SOPS + age)

- **대상**: Postgres password, JWT secret, Redis password, MinIO root creds
- **저장**: 리포지토리에 `.enc` 파일로 커밋 가능
- **복호화**: `sops -d deploy/full-stack/.env.enc` (age private key 필요)
- **부팅**: `docker compose --env-file <(sops -d .env.enc) up`
- **팀원 등록**: 새 팀원 age 공개키를 `.sops.yaml` 에 추가

### 계층 2 · 런타임 시크릿 (OpenBao)

- **대상**: 사용자 앱 시크릿(`DATABASE_URL`, `JWT_SECRET`, API 키), 클라우드 자격증명 · OIDC 신뢰 설정
- **저장**: OpenBao KV v2 (`secret/projects/{project_id}/env/{key}`)
- **dev/데모**: 파일 백엔드 + transit self-seal auto-unseal (컨테이너 하나로 부팅)
- **프로덕션**: KMS auto-unseal (AWS KMS / GCP KMS / Azure Key Vault) · 백엔드는 Raft
- **접근**: `apps/lib/src/credentials.ts` 의 `getSecret(path)` 만 사용. 다른 코드가 직접 접근 금지

### 계층 3 · 클라우드 자격증명 (OIDC 페더레이션)

- **AWS**: `sts:AssumeRoleWithWebIdentity` (id_token 은 OpenBao 내장 OIDC IdP 발급)
- **GCP**: Workload Identity Federation
- **Azure**: Workload Identity Federation
- **온프레미스**: OpenBao AppRole
- **효과**: `credentials` 테이블에는 **역할 ARN/리소스명만** 저장. **장기 키 0개**.

### 계층 +1 · AI 문맥 시크릿 방어 (파일 릴레이)

**원칙**: AI 는 시크릿 값을 절대 보지 못한다 (조서현 §경험4).

- **CLI**: `softbank env set <PROJECT> KEY=VAL` 실행 시 API 는 볼트에 저장하고 응답에는 **path 만** (`vault://projects/1/env`)
- **MCP tool 스키마**: `set_env(project_id, key, value)` 는 있으나 **`get_env` 없음** → AI 는 "이 프로젝트에 DATABASE_URL 이 설정됨" 사실만 알고 값 모름
- **agent → LLM 전송 전**: `apps/lib/src/mask.ts` 가 2차 방어선 (정규식 마스킹)
- **로그 · SSE**: 마스킹 적용

### 델타

- 🆕 SOPS + age (부팅 시크릿)
- 🆕 OpenBao 컨테이너 (dev 파일 백엔드)
- 🆕 OIDC 페더레이션 (AWS 우선)
- 🔧 파일 릴레이 (MCP tool 스키마 조정 · `apps/lib/src/mask.ts` 는 유지 · 방어선 2개째로 재정의)

---

## 12. 핵심 개념 8 · 관측 · OpenTelemetry

### 표준 계측

모든 사용자 앱에 **OpenTelemetry Collector 사이드카를 자동 주입**한다 (IR `expose.otel = true` default true). 다음 태그가 공통:

```
deployment.id       — 이 앱이 어느 배포로 왔는지
service.name        — services.<name>
service.version     — build sha
deployment.environment  — dev / staging / prod
```

### 스택 (Grafana LGTM)

| 도구 | 역할 | 컨테이너 |
|---|---|---|
| Grafana | 대시보드 UI | `grafana/grafana:11` |
| Prometheus | 메트릭 저장 (24h) | `prom/prometheus:latest` |
| Loki | 로그 저장 (24h) | `grafana/loki:3` |
| Pyroscope | 프로파일 저장 | `grafana/pyroscope:latest` |
| **본선**: Tempo | 트레이스 저장 | `grafana/tempo:latest` |
| **본선**: Mimir | 메트릭 장기 저장 | `grafana/mimir:latest` |

### 어댑터가 무엇을 하나

`packages/obs-adapters/{cloudwatch,cloud-logging,azure-monitor,loki}/` 는 클라우드 백엔드에서 조회한 결과를 **Loki 로 forward** 한다. 심사관은 한 화면(Grafana) 에서 온프렘 · AWS · GCP · Azure 로그를 함께 본다.

### 대시보드

- **Overview**: 활성/성공률/평균/p95, 배포 처리량 (Recharts stacked BarChart)
- **Cost**: pricing-catalog `estimateDeploymentCost` → AI vs 인프라 도넛, 프로바이더 파이, 배포별 breakdown
- **Incidents**: 실패/롤백 배포 post-mortem 3-part 카드 (문제 · 원인 · 해결)
- **Pyroscope**: 배포별 CPU/heap flame graph

### 델타

- 🆕 Grafana LGTM 4-5 컨테이너 (dev 기본 4개 · 본선 6개)
- 🆕 OTel Collector 사이드카 자동 주입
- 🔧 어댑터가 Loki forward 하도록 변경 (현재는 개별 조회만)
- ✅ 기존 웹 대시보드 (`/observability` `/costs` `/incidents`) 는 유지

---

## 13. 핵심 개념 9 · SSE · Last-Event-ID

### 왜 SSE

- 단방향 스트림으로 충분 (사용자 → 서버는 REST)
- 자동 재연결 표준 지원 (`EventSource` API)
- WebSocket 대비 인프라 단순 · HTTP/2 friendly
- Redis 스트림 뒤에 무상태 API 두면 무한 확장

### 계약

```
GET /deployments/:id/events
Last-Event-ID: <streamId>     ← 재연결 시 유실된 이벤트 재생

data: {"deployment_id":"dep_42","step":"build","line":"Step 4/9","ts":"..."}
id: 1725348234-0
```

### 구현 (실제 코드 · `apps/lib/src/sse.ts`)

- Redis Streams `XADD` + Pub/Sub `PUBLISH` 병렬 발행
- `XRANGE (streamId + '+'` 로 재연결 시 재생
- 배포 종료 시 `EXPIRE 3600s` (1시간 보관)
- `MAXLEN ~ 1000` (per deployment)

### 이벤트 타입

| type | 발행자 | 프론트 처리 |
|---|---|---|
| `state_changed` | orchestrator | 상태 뱃지 갱신 |
| `step_completed` | worker | 스텝 체크 |
| `approval_requested` | orchestrator | 승인 위젯 표시 |
| `canary_progress` | verifier | 카나리 % 표시 |
| `rollback_started` / `rollback_completed` | orchestrator | 인시던트 카드 |
| `lock.changed` | orchestrator | 락 아이콘 |
| `analysis.progress` / `analysis.completed` | analyzer | 분석 진행 바 |

### 델타

- ✅ SSE 계약 · Redis Streams 하이브리드 유지 (검증 완료)
- ✅ Last-Event-ID 재연결 유지

---

## 14. 핵심 개념 10 · AI 파이프라인 (규칙 → AI · caching · 파일 릴레이)

### 3단계 파이프라인 (원칙)

```
[Step 1] FACTS 수집   → Dockerfile · package.json · go.mod 등 파싱      (AI 미호출)
[Step 2] 규칙 기반     → 확실한 필드는 규칙으로 결정                    (AI 미호출)
[Step 3] AI 보조       → 규칙이 '모름' 낸 필드만 tool_use 로 결정      (AI 호출)
```

**원칙 (조서현 §AI 로 원클릭)**: 규칙으로 풀리는 것은 규칙으로, 규칙이 모르는 것만 AI 로.

### Prompt Caching

Anthropic Claude 는 반복 프롬프트 캐시 시 **최대 90% 저렴 · TTFT 수초→수백ms**. 우리 파이프라인의 캐시 세그먼트:

1. **Tools 정의** (에이전트 도구 스키마) — 안정, 캐시
2. **System prompt** (역할 설명 · 정책) — 안정, 캐시
3. **IR JSON Schema** (Zod → JSON Schema) — 안정, 캐시
4. **User message** (이 배포 관련 컨텍스트) — 매번 다름, 캐시 안 함

```typescript
// apps/agent/src/anthropic.ts
await client.messages.create({
  model: 'claude-3-5-sonnet-latest',
  system: [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: IR_SCHEMA_JSON, cache_control: { type: 'ephemeral' } },
  ],
  tools: TOOLS.map(t => ({ ...t, cache_control: { type: 'ephemeral' } })),
  messages: [{ role: 'user', content: userContext }],
})
```

**주의**: tool 목록 변경 시 캐시 전체 무효화. 안정한 tool surface 유지가 중요.

### tool_use 2-turn 패턴

파일 목록만 먼저 → AI 가 필요한 파일만 요청 → 관련 파일만 재전송. 80~95% 토큰 절약.

### 파일 릴레이 (§11 계층 +1 재참조)

시크릿 값이 AI 문맥에 들어가지 않도록 CLI/MCP 는 값 대신 path 로 통신. `apps/lib/src/mask.ts` 는 마지막 방어선.

### AI 사용량 대시보드

- `ai_usage` 테이블 (배포별 · 도구별 토큰/비용)
- `/costs` 페이지 AI vs 인프라 도넛
- 발표에서 "규칙이 처리한 비율 vs AI 가 처리한 비율" 시연

### 델타

- 🆕 Prompt caching 헤더 삽입
- 🆕 IR JSON Schema 를 프롬프트에 첨부 (첫 시도 성공률 상승)
- 🔧 `apps/lib/src/subprocess.ts` 에 `stageSource(deploymentId, sourceRef)` 추가 (per-deployment 소스 카피 · 오염 방지)
- 🔧 언어별 어댑터 `apps/workers/analyzer/langs/{node,python,go,rust}.ts` 신규

---

# 파트 C · 코드 지도

## 15. 리포지토리 지도 (target 상태)

```
softbank/
├─ apps/
│  ├─ api/                 Fastify · REST + SSE · Bearer 인증 · src/mappers/ 10 파일
│  ├─ orchestrator/        상태 머신 · env_locks · approvals · 리더 선출 · pipeline/ 6 파일
│  ├─ workers/
│  │  ├─ analyzer/         언어별 규칙(node/python/go/rust) + LLM 보조
│  │  ├─ builder/          BuildKit (amd64+arm64) · digest 저장
│  │  ├─ provisioner/      terraform(→ opentofu) · onprem compose · src/ 5 파일
│  │  └─ verifier/         health · smoke · k6 (TS 참조)
│  ├─ agent/               Anthropic SDK + prompt caching + tool_use
│  ├─ obs-gateway/         obs-adapters 조회 → Loki forward
│  ├─ recommender/         규칙 + pricing-catalog
│  ├─ web-next/            Next.js 15 · Grafana iframe · ApprovalWidget
│  ├─ cli/                 softbank init/deploy/status/logs/rollback/approve
│  ├─ mcp/                 🆕 MCP 서버 (stdio + HTTP · Claude Code 통합)
│  ├─ slack/               🆕 Slack Bot · Block Kit 인터랙티브 승인
│  ├─ onprem-agent/        롱 폴링 클라이언트 · Executor 사용
│  └─ lib/
│     ├─ env/logger/db/sse/worker         공용 유틸
│     ├─ subprocess.ts                    runCmd 통합
│     ├─ executor.ts       🆕 Executor 인터페이스 (Local/SSH/Fake/Container)
│     ├─ credentials.ts    🔧 OpenBao 기반으로 재구현 (Redis 평문 제거)
│     └─ mask.ts                          AI 문맥 시크릿 마스킹 (2차 방어선)
├─ services/
│  └─ verifier-go/         Go 1.22 · pgx v5 · go-redis · slog (Case 2 하이브리드)
├─ packages/
│  ├─ contracts/           Zod + openapi.yaml (SDK 자동 생성용)
│  ├─ ir-schema/           IR YAML · dependsOn 위상정렬 · overrides · 🆕 diff.ts
│  ├─ adapters/
│  │  ├─ onprem/           Docker Compose + Cloudflare Tunnel 사이드카 (헬스 게이트 블루그린)
│  │  ├─ aws/              Terraform: VPC + ECS(native blue/green) + RDS + ALB + ECR + Secrets Manager
│  │  ├─ gcp/              Terraform: Cloud Run + Cloud SQL + Secret Manager (본선)
│  │  └─ azure/            Terraform: Container Apps + Azure DB + Key Vault (본선)
│  ├─ obs-adapters/        CloudWatch · Cloud Logging · Azure Monitor · Loki
│  ├─ pipeline/            파이프라인 YAML 파서 (CLI · 오케스트레이터 공용)
│  ├─ pricing-catalog/     AWS + GCP + Azure SKU 20+
│  └─ repository/          🆕 얇은 리포지토리 계층 (deployments/jobs/iac_stacks/analysis)
├─ samples/
│  ├─ monolith-todo/       Express + SQLite (AI 가 Postgres 로 변환)
│  ├─ msa-basic/           web + api + worker (docker-compose)
│  └─ os-vm/               3 OS 에이전트 설치 스크립트
├─ deploy/
│  ├─ control-plane/       docker-compose (Postgres + Redis + MinIO + Registry + OpenBao + Grafana LGTM)
│  └─ full-stack/          위 + 앱 (원큐 부팅)
├─ tools/
│  ├─ schema_v2.py         스키마 단일 정의 → SQL · 데이터사전 생성
│  ├─ gen.py               아키텍처 다이어그램 렌더
│  └─ render_one.py        mermaid → png
├─ llms.txt                🆕 외부 AI 도구 진입점 (조서현 §경험4)
└─ docs/                   INDEX · USER_MANUAL · FINAL_REPORT · 이 문서 · ...
```

### "무엇을 만지면 무엇이 바뀌나"

| 원하는 변경 | 손댈 곳 |
|---|---|
| 새 IR 필드 추가 | `packages/ir-schema/src/index.ts` (+ 어댑터에 해석) |
| 새 클라우드 지원 | `packages/adapters/<name>/` + `packages/obs-adapters/<name>/` |
| 새 승인 채널 | `apps/{web-next,cli,slack,mcp}/` 중 해당 (API 는 무변경) |
| 새 대시보드 카드 | `apps/web-next/src/components/` + `apps/api/src/routes/` |
| 새 워커 타입 | `apps/workers/<name>/` + `packages/contracts/jobs.ts` |
| 새 AI 도구 (MCP) | `apps/mcp/src/tools/<name>.ts` + `packages/contracts/agent.ts` |
| DB 스키마 변경 | `tools/schema_v2.py` (SQL 직접 수정 금지) → `python3 tools/schema_v2.py` 재생성 |
| 아키텍처 다이어그램 | `docs/diagrams/mermaid/*.mmd` → `tools/render_one.py` 재렌더 |

---

## 16. 데이터 모델 개요

### Postgres 스키마 v2 (33 테이블 · FK 64)

전체: `docs/erd/데이터사전_v2.md` · DDL: `docs/erd/postgres_schema_v2.sql` (편집 금지, `tools/schema_v2.py` 로 재생성).

### 컴포넌트별 쓰기 소유 (D-12)

| 컴포넌트 | 담당 테이블 |
|---|---|
| API 서버 | users, api_tokens, projects, source_versions, pipeline_definitions, ir_versions, targets, agent_tokens, onprem_agents, secrets, audit_logs, ci_triggers |
| Orchestrator | deployments, deployment_steps, approvals, env_locks, jobs, deployment_services |
| AI 에이전트 | patches, diagnoses, ai_usage, agent_runs, agent_tool_calls |
| Analyzer | analysis_reports |
| Builder | build_artifacts |
| Provisioner | infra_plans, provisioned_resources, db_migrations, iac_stacks |
| Verifier | verifications |
| Recommender | pricing_catalog, recommendations, recommendation_candidates |

**규칙**: 다른 컴포넌트가 이 테이블을 바꿔야 할 때는 소유자에게 API · 작업 큐 · 이벤트로 요청. 직접 UPDATE 금지.

### v2 → target 델타

- 🆕 `deployments.resume_attempts INT DEFAULT 0` — 부팅 시 자동 재개 카운터
- 🆕 `approvals.decided_by TEXT UNIQUE (deployment_id, kind)` — 중복 결정 방지
- 🆕 `slack_interaction_log` 테이블 — Slack 인터랙티브 승인 이력
- 🆕 `mcp_sessions` 테이블 — MCP 클라이언트 세션 (수명 · rate limit 용)

---

## 17. 서비스 실행 단위 (Docker Compose)

### 컨트롤 플레인 (`deploy/control-plane/docker-compose.yml`)

| 서비스 | 개수 | 이미지 · 포트 · 비고 |
|---|---:|---|
| api | 2+ | Fastify · :8080 · 로드밸런서 뒤 |
| orchestrator | 2 (1 active + 1 standby) | 상태 = Postgres · advisory lock 리더 |
| worker-analyzer | 2+ | LLM 호출 |
| worker-builder | 2+ | 샌드박스 BuildKit |
| worker-provisioner | 2+ | terraform (→ opentofu) 실행 |
| worker-verifier | 1+ | TS 참조 (k6) |
| verifier-go | 1+ | Go 하이브리드 (health/smoke/canary) |
| agent | 1+ | Anthropic SDK |
| obs-gateway | 1+ | 무상태 조회 |
| recommender | 1 | 규칙 엔진 |
| mcp | 1+ | MCP HTTP · :8090 |
| slack | 1 | Slack Bot · webhook 수신 |
| web | 1+ | Next.js · :3001 |
| postgres | 1 | :5432 (프로덕션은 관리형) |
| redis | 1 | :6379 (SSE 전용) |
| minio | 1 | :9000 (소스 · 로그 · IaC state) |
| registry | 1 | :5000 (이미지) |
| openbao | 1 | :8200 (dev=파일 백엔드) |
| grafana | 1 | :3000 (대시보드) |
| prometheus | 1 | :9090 |
| loki | 1 | :3100 |
| pyroscope | 1 | :4040 |

### 온프레미스 (사용자 서버)

- `onprem-agent` 컨테이너 1개 (롱 폴링 클라이언트)
- 사용자 앱 컨테이너들 (Docker Compose)
- `cloudflared` 사이드카 (Cloudflare Tunnel)

### CLI

`apps/cli/dist/index.js` · npm 글로벌 설치 가능하도록 `bin` 지정.

---

# 파트 D · 실습

## 18. Quickstart

### 원큐 부팅 (5분 · 심사 · 데모용)

```bash
cd deploy/full-stack
sops -d .env.enc > .env      # SOPS 복호화 (age private key 필요)
docker compose up --build -d

# 데모 시드
docker compose exec postgres psql -U deploy -d deploy <<'SQL'
INSERT INTO users (id, email, name, role) VALUES (1, 'demo@x.com', 'Demo', 'admin');
INSERT INTO projects (id, owner_id, name) VALUES (1, 1, 'demo');
SELECT setval('projects_id_seq', 1);
SQL

# 브라우저
open http://localhost:3001

# CLI
export SOFTBANK_API_URL=http://localhost:8080
export SOFTBANK_API_TOKEN=dev
softbank deploy --project 1 --strategy rolling
```

### 개발 모드 (핫리로드)

```bash
# 1) 인프라만
cd deploy/control-plane && docker compose up -d

# 2) API + orchestrator (터미널 2개)
pnpm --filter @softbank-poc/api dev
pnpm --filter @softbank-poc/orchestrator dev

# 3) 워커 (하나의 터미널에 4개)
pnpm --filter @softbank-poc/worker-analyzer start &
pnpm --filter @softbank-poc/worker-builder start &
pnpm --filter @softbank-poc/worker-provisioner start &
pnpm --filter @softbank-poc/worker-verifier start &

# 4) 웹
pnpm --filter @softbank-poc/web start
```

### 필수 준비물

| 항목 | 확인 |
|---|---|
| Node 20 + pnpm 9 | `node --version && pnpm --version` |
| Docker Desktop (BuildKit) | `docker buildx ls` |
| Terraform 1.10+ | `terraform version` (본선 뒤: OpenTofu 1.7+) |
| AWS CLI 로그인 (선택) | `aws sts get-caller-identity` |
| age private key | `~/.config/sops/age/keys.txt` |
| Anthropic API key | `~/.config/softbank-poc/env` |

### 문제 발생 시 § 27 트러블슈팅

---

## 19. 개발 흐름 (Day in the life)

### 브랜치 · PR

- `main` = 시연 브랜치. 절대 붉은색 (실패) 상태로 두지 않는다.
- 기능 브랜치: `feat/<scope>-<slug>` · 리팩터: `refactor/<scope>` · 문서: `docs/<slug>` · 데모: `demo/<slug>`
- PR 템플릿: **무엇 · 왜 · 스크린샷/asciinema · 테스트 결과 · 롤백 방법**.

### 커밋 컨벤션

- Conventional Commits · Korean summary OK
- 예: `feat(orchestrator): add advisory-lock leader election`
- 예: `fix(onprem): 헬스 게이트 스왑 잔존 -next 정리`

### 로컬 테스트 습관

```bash
pnpm test              # 모든 워크스페이스 vitest (88+ passing)
pnpm test --filter @softbank-poc/orchestrator
pnpm build             # 타입 체크 + tsup 빌드
pnpm lint              # eslint (신규 룰: no-console 워커에)
make e2e               # 온프레미스 + 카나리 롤백 회귀 (실 컨테이너)
```

### AI 협업 규칙

- 새 코드 넣기 전 `pnpm test` 로 로컬 그린 확인
- LLM 문맥에는 값 대신 path (파일 릴레이 §11 계층 +1)
- 파괴적 명령은 `--yes` 없이 거부 (조서현 §경험4)
- 매 배포마다 AI 토큰/비용 기록 (`ai_usage` 테이블)

### CI (예정 · T-9)

- GitHub Actions
- 단계: install → build → test → e2e (docker compose up 기반) → 데모 배포 (main 만)
- 필요 시크릿: `ANTHROPIC_API_KEY`, `AWS_OIDC_ROLE_ARN`, `SOPS_AGE_KEY`

---

## 20. 유스케이스 워크쓰루 5종

### 20-1. UC-01 원클릭 배포 (개발자 · 첫 배포 5분)

```
1. 개발자: samples/monolith-todo/ 를 zip 으로 압축
2. 웹 대시보드 → New Deployment → zip 업로드
3. Analyzer 가 스택 감지 (Node · Express · SQLite · port 3000)
4. AI 에이전트: patch 초안 3개 제시
   - Dockerfile 추가 · SQLite→Postgres 변환 · /health 엔드포인트 삽입
   [승인 게이트 1: patch] ← 사람 개입
5. Recommender: AWS Fargate / GCP Cloud Run / 온프레미스 후보 + 월 예상 비용
   [승인 게이트 2: target 확정] ← 사람 개입
6. Orchestrator: env_lock 획득 → builder 잡 enqueue
7. Builder: BuildKit multi-arch → registry push
8. Provisioner: Terraform plan 생성 → S3 backend 에 저장
   [승인 게이트 3: plan] ← 사람 개입 (Plan: 12 to add)
9. Provisioner: apply → RDS · ALB · ECS Fargate · Secrets Manager 생성
10. Verifier: /health 200 확인 → 스모크 → k6
11. Orchestrator: succeeded → 공개 URL 반환
    → https://alb-xxx.ap-northeast-2.elb.amazonaws.com/health
```

**소요**: 첫 배포 5-8분 (관리형 DB 프로비저닝 포함). Warm 재배포 <2분.

### 20-2. UC-08 카나리 · 자동 롤백

```
1. IR deploy.strategy: canary · steps=[10, 50, 100] · rollbackConditions.errorRate=0.05
2. Provisioner: ECS service deployment_configuration.strategy=BLUE_GREEN,
   traffic_shift.type=CANARY_10_PERCENT_5_MINUTES
3. 10% 트래픽 이동
4. verifier-go 가 관찰 창(5분) 동안 CloudWatch 지표 조회
5. errorRate=0.08 감지 (fault-injection Redis 키로 시뮬레이션 가능)
6. Orchestrator 상태 = rolling_back
7. AWS ECS native rollback trigger → traffic 100% 이전 리비전
8. Orchestrator 상태 = failed · incident 대시보드에 post-mortem 카드
```

**소요**: 관찰 5분 + 롤백 30초 = 6분 이내.

### 20-3. UC-14 온프레미스 배포

```
1. 개발자: 온프레미스 서버(맥북 VM) 에 onprem-agent 설치
   $ curl -sSL https://demo.example.com/install.sh | bash
2. 설치 스크립트: 1회용 등록 토큰으로 API 등록 → agent 컨테이너 up
3. 개발자: 웹에서 target=onprem-macvm 선택
4. Orchestrator: onprem-agent 롱 폴링에 job 전달
5. Agent: registry 에서 이미지 pull
6. Agent: 헬스 게이트 블루그린 스왑
   a. api-next 로 컨테이너 up
   b. /health 200 (또는 / 5xx 미만) 확인
   c. rename: api → api-prev, api-next → api
   d. 3초 유예 → api-prev 삭제
7. Agent: cloudflared 사이드카 up · trycloudflare URL 발급
8. 결과: https://xxx.trycloudflare.com/health → 200 OK
```

**핵심**: **이전 컨테이너는 한 번도 안 멈춤 = 다운타임 0**.

### 20-4. UC-10 MSA 다중 서비스

```
1. 사용자 zip: docker-compose.yml 포함 (web + api + worker)
2. Analyzer: docker-compose 감지 → 3개 IR services entry
3. IR services.web.dependsOn: [api], services.api.dependsOn: [db]
4. Orchestrator: topoOrder → db → api → web 순서
5. 각 서비스 헬스체크 통과 뒤 다음 서비스 시작
6. Grafana: 3개 서비스 병렬 카드 표시
```

### 20-5. UC-07 실패 진단 · AI 복구

```
1. Builder 잡 실패 (Node 버전 mismatch)
2. Orchestrator 상태 = diagnosing
3. AI 에이전트: 로그 꼬리 + package.json + Dockerfile 을 LLM 에 전송
   (파일 릴레이: 시크릿 값은 절대 첨부 안 됨)
4. AI: "engines.node=20 인데 Dockerfile 은 node:18. Dockerfile 을 node:20 으로."
5. patch 초안 → [승인 게이트 · UI 에는 diff 표시]
6. 승인 → 새 source_version (source_type=patched)
7. Builder 잡 재시도 (attempt=2)
8. 3회 실패 시 → rolling_back → failed
```

**AI 사용량**: 이 시나리오 약 4k input · 1.5k output 토큰 · $0.03 예상 (Sonnet 4.6, prompt caching 히트).

---

# 파트 E · 확장

## 21. 새 서비스(컴포넌트) 추가하기

### 예: "이메일 알림 발송" 컴포넌트

1. **폴더 생성**: `apps/notifier/{package.json, src/index.ts, src/main.ts}`
2. **workspace 등록**: `pnpm-workspace.yaml` 에 자동 인식
3. **계약**: 필요 시 `packages/contracts/src/notifications.ts` 신규 · Zod 스키마 정의
4. **DB 소유**: 새 테이블이 필요하면 `tools/schema_v2.py` 에 추가 → `python3 tools/schema_v2.py` → PR
5. **워커라면**: `apps/lib/src/worker.ts` 의 `runWorker(handler)` 재사용 · 새 `JobType` 추가
6. **테스트**: `src/*.test.ts` · vitest 자동 인식
7. **Compose**: `deploy/control-plane/docker-compose.yml` 에 서비스 추가
8. **docs**: 이 문서 §17 표에 추가

### 원칙 재확인

- 다른 컴포넌트 소유 테이블에 직접 UPDATE 금지 (§16)
- 계약은 `packages/contracts` 로만 (내부 코드 import 금지)
- 무상태 (Postgres 에 상태) · 멱등 (job_id + attempt)

---

## 22. 새 클라우드 어댑터 추가하기

### 예: DigitalOcean App Platform

1. `packages/adapters/digitalocean/{package.json, src/index.ts, terraform/*.tf}` 생성
2. `ProviderAdapter` 인터페이스 구현
   ```typescript
   export class DigitalOceanAdapter implements ProviderAdapter {
     capabilities(): Capabilities {
       return { strategies: ['rolling', 'blue-green'], regions: ['nyc1','sfo3'], ... }
     }
     async plan(ir: IR, target: Target): Promise<Plan> {
       // IR → terraform HCL 생성
     }
     async apply(plan: Plan, ctx: DeployContext) { ... }
     // ...
   }
   ```
3. Terraform 모듈: `terraform/{app.tf, database.tf, outputs.tf}` — `TF_MODULE_MAP` 에 매핑
4. 관측 어댑터: `packages/obs-adapters/digitalocean/index.ts`
5. Pricing: `packages/pricing-catalog/src/digitalocean.ts`
6. Recommender 스코어링: 규칙 조건 추가
7. E2E 테스트: `scripts/demo-digitalocean.sh` (선택)
8. docs 갱신

### 원칙

- IR 은 절대 손대지 않는다. 고유 기능은 `overrides.digitalocean.*` 로 표현.
- `capabilities()` 로 미지원 전략은 fallback 알림.

---

## 23. 새 MCP tool 추가하기

### 예: `deploy` tool

1. `apps/mcp/src/tools/deploy.ts` 생성
   ```typescript
   export const deployTool = {
     name: 'deploy',
     description: 'Trigger a deployment for a project',
     input_schema: {
       type: 'object',
       properties: {
         project_id: { type: 'number' },
         target_id: { type: 'number' },
         strategy: { type: 'string', enum: ['rolling', 'blue-green', 'canary'] },
       },
       required: ['project_id'],
     },
     requires_approval: true,   // 파괴적 · 자동 실행 금지
     async handler(input, ctx) {
       return api.post('/deployments', input)
     },
   }
   ```
2. `apps/mcp/src/index.ts` 의 tool registry 에 등록
3. `packages/contracts/src/agent.ts` 스키마에 추가 (내부 에이전트도 재사용 가능)
4. `llms.txt` 에 사용법 한 줄
5. 테스트: mock 모드 with vitest

### `requires_approval` 라벨링

- `true`: 인프라 변경 · 코드 수정 · 롤백 · 배포 (사람 게이트)
- `false`: 조회 · 분석 · 진단 · 로그 (자동)

**API 서버가 코드로 강제**: `requires_approval=true` 인 tool 은 대응 approval 이벤트 없이 실행 시 API 가 403 반환.

---

## 24. 새 관측 백엔드 추가하기

### 예: DataDog

1. `packages/obs-adapters/datadog/index.ts` 생성 · `ObsAdapter` 구현
   ```typescript
   export class DatadogObs implements ObsAdapter {
     async query(q: ObsQuery): Promise<NormalizedResult> {
       // DataDog Logs/Metrics API 호출 → 정규화
     }
   }
   ```
2. `apps/obs-gateway/src/index.ts` 의 어댑터 팩토리에 등록
3. Loki forward (선택): 정규화 결과를 Loki `push` API 로 전송 → Grafana 통합 뷰
4. 대상 환경 등록 시 `target.observability = { backend: "datadog", api_key_ref: "vault://..." }`

---

# 파트 F · 품질

## 25. 테스트 전략

### 계층

| 계층 | 도구 | 대상 |
|---|---|---|
| Contract | vitest + Zod parse | `packages/contracts/*` 스키마 · API 응답 재검증 |
| Unit | vitest | 각 워크스페이스 `src/*.test.ts` |
| Integration | vitest + testcontainers | `apps/orchestrator/pipeline.test.ts` (real Postgres) |
| E2E | bash + docker compose | `scripts/e2e.sh` (온프레미스 · 카나리 롤백) |
| Load | k6 | `samples/monolith-todo/k6-{smoke,load}.js` |

### 현재 커버리지 · 갭

- 현재: 88 passing (contracts 10 · ir-schema 6 · pipeline 3 · pricing-catalog 4 · lib 7 · onprem 6 · api 3 · orchestrator 12 · analyzer 2 · agent 4 · recommender 3 · verifier 4 · slack 5 · mask 4 · pipeline_test 3 · state-machine 12)
- 목표 (본선 뒤): 70% coverage. 우선순위 (REFACTOR_AUDIT I):
  - `apps/workers/provisioner/*` — terraform · onprem 브랜치 · AWS outputs 파싱
  - `apps/orchestrator/pipeline.ts` — `generateIrFromAnalysis` MSA/monolith goldenset
  - `apps/orchestrator/transitions.ts` — `expireStaleApprovals` · Slack notify mock
  - `apps/lib/worker.ts` — SKIP LOCKED · 재시도 · dead letter

### Contract 회귀 (drift 방지)

- 모든 API 라우트 응답을 리턴 직전 `XxxResponseSchema.parse(...)` 로 재검증 (개발) · `safeParse+warn` (프로덕션)
- OpenAPI export CI 게이트: `pnpm --filter @softbank-poc/contracts run export:openapi` 결과가 커밋되어 있어야 CI 통과

---

## 26. 관측 · 디버깅

### Grafana 어디에 뭐 있나

| 대시보드 | 내용 |
|---|---|
| Overview | 활성/성공률/평균/p95, 배포 처리량 (24h) |
| Deployment #X | 특정 배포의 스텝 · 소요시간 · 로그 · 트레이스 링크 |
| Cost | AI vs 인프라 도넛 · 프로바이더 파이 · 배포별 breakdown |
| Incidents | 실패/롤백 배포 post-mortem 3-part 카드 |
| Pyroscope | CPU/heap flame graph |

### "어떻게 디버그하나" 시나리오 3개

**시나리오 A · 배포가 building 에서 멈춤**
1. Grafana Overview → 이 배포 카드 → building 스텝 소요 확인
2. 로그 (Loki) → `service=worker-builder && deployment_id=42` 필터
3. `docker exec worker-builder tail -f logs/app.log` (dev)
4. buildkit daemon 상태 확인: `docker exec worker-builder buildctl debug info`

**시나리오 B · 카나리 롤백이 안 뜸**
1. verifier-go 로그 (Loki · `service=verifier-go`)
2. Redis 이벤트 스트림 확인: `XRANGE deployments.42.events - +`
3. `verifications` 테이블 조회: 관찰 창 rows

**시나리오 C · Postgres 큐가 안 소진됨**
1. `SELECT status, count(*) FROM jobs GROUP BY status;`
2. `SELECT * FROM jobs WHERE locked_until > now() ORDER BY locked_until;` — 좀비 락 확인
3. 워커 로그: `service=worker-* && level=error`

### 자주 쓰는 쿼리

```sql
-- 현재 진행 중 배포
SELECT id, state, updated_at, target_id FROM deployments
WHERE state NOT IN ('succeeded','failed','cancelled') ORDER BY id DESC;

-- 좀비 락
SELECT deployment_id, locked_until FROM env_locks
WHERE locked_until > now() AND lease_updated_at < now() - interval '5 min';

-- AI 사용량 (오늘)
SELECT deployment_id, sum(input_tokens), sum(output_tokens), sum(cost_usd)
FROM ai_usage WHERE created_at > current_date GROUP BY deployment_id ORDER BY 4 DESC;

-- 미완 잡
SELECT id, type, deployment_id, attempt, last_error FROM jobs
WHERE status = 'failed' AND created_at > now() - interval '1 day';
```

---

## 27. 트러블슈팅 · 자주 걸리는 것 10선

| # | 증상 | 원인 | 해결 |
|---|---|---|---|
| 1 | `docker compose up` 이 pnpm install 에서 죽음 | 로컬 node_modules 심볼릭 링크 충돌 | 로컬 `node_modules` 제거 후 재빌드 |
| 2 | Terraform apply 가 "Error acquiring the state lock" | 이전 apply 실패로 lock 남음 | S3 backend 라면 `.tflock` 오브젝트 수동 삭제 (`aws s3 rm s3://.../.tflock`) |
| 3 | 온프레미스 배포 시 `-next` 컨테이너 남음 | 헬스 게이트 실패 후 정리 로직 미실행 (서버 재시작) | 부팅 치유: `docker ps -f "name=-next$"` → `docker rm` |
| 4 | AWS ECS deploy stuck at "in progress" | Target Group health check 실패 | `aws elbv2 describe-target-health` · 앱 `/health` 200 확인 |
| 5 | SSE 이벤트가 웹에 안 들어옴 | Redis 스트림에 안 쌓이거나 브라우저 재연결 실패 | Redis `XRANGE deployments.X.events - +` · 브라우저 Network 탭 `text/event-stream` 확인 |
| 6 | AI 가 patch 를 자꾸 실패 | prompt caching 캐시 무효화 반복 (tool 목록 변경) | tool surface 고정 · dev 모드에서 `messages.create` 로그의 `cache_creation_input_tokens` 확인 |
| 7 | OpenBao 컨테이너가 sealed 로 부팅 | 파일 백엔드 auto-unseal 실패 (transit self-seal 설정 미완) | `openbao operator init` · unseal keys 를 SOPS 로 저장 |
| 8 | 웹 대시보드가 blank | Next.js 15 SSR + Grafana iframe CSP 충돌 | Grafana `[security] allow_embedding=true` · Next.js middleware `frame-ancestors` |
| 9 | Slack 인터랙티브 버튼이 무반응 | Slack signing secret 미설정 or URL verification 실패 | `SLACK_SIGNING_SECRET` env · Cloudflare Tunnel URL 을 Slack app 에 등록 |
| 10 | 카나리 롤백이 즉시 안 됨 | ECS native rollback trigger 미설정 | Terraform `deployment_configuration.rollback = true` 확인 |

---

# 파트 G · 참고

## 28. 용어 사전

| 용어 | 뜻 |
|---|---|
| **IR** | Intermediate Representation. 클라우드 중립 앱 배포 명세 (YAML) |
| **Adapter** | IR 을 실제 클라우드 리소스로 번역하는 코드 (Terraform HCL · Compose) |
| **Executor** | 셸/SSH/컨테이너 실행을 감싸는 인터페이스 |
| **Env Lock** | 같은 대상 환경에 배포가 겹치지 않도록 오케스트레이터가 관리하는 락 |
| **IaC Stack** | 프로젝트 × 대상 환경 조합의 리소스 컬렉션 (D-25) |
| **Approval Gate** | 사람이 결정해야만 진행되는 3개 지점 (patch · target · plan) |
| **State Machine** | 오케스트레이터가 배포 1건을 진행시키는 16 상태 전이도 |
| **SKIP LOCKED** | Postgres 잠금 없이 다음 행을 잡는 SQL 힌트 (큐 구현 핵심) |
| **LISTEN/NOTIFY** | Postgres 비동기 알림 (폴링 제거) |
| **prompt caching** | Anthropic 반복 프롬프트 캐싱 (90% 절감) |
| **tool_use** | LLM 이 외부 도구를 필요할 때만 호출 · 2-turn 패턴 |
| **파일 릴레이** | AI 문맥에 시크릿 값이 들어가지 않도록 값 대신 path 로 통신 |
| **OpenBao** | Vault fork (LF governance, MPL 2.0) · KV v2 시크릿 저장소 |
| **OIDC 페더레이션** | 장기 키 대신 id_token 을 클라우드에 제시해 단기 자격증명 발급 |
| **Cloudflare Tunnel** | 방화벽/NAT 뒤에서도 공개 URL 노출 (outbound-only) |
| **canary_10pct_5m** | ECS native blue/green 의 카나리 프로파일 (10% 5분) |
| **LGTM** | Grafana · Loki · Tempo · Mimir (관측 스택 약칭) |

---

## 29. 안티패턴 · 절대 하지 말 것

1. **LLM 프롬프트에 시크릿 값 직접 삽입** → 파일 릴레이만 (§11 계층 +1).
2. **다른 컴포넌트 소유 테이블에 UPDATE** → API/이벤트/큐로 요청 (§16).
3. **IaC state 를 로컬 파일에 저장 (프로덕션)** → S3 backend + KMS 필수.
4. **에이전트 도구를 `requires_approval` 없이 파괴적으로 노출** → API 서버가 코드로 강제해야 함.
5. **워커를 상태 있게 만들기** → 무상태 · 멱등 (`job_id + attempt`).
6. **오케스트레이터를 활성 2대 이상** → 상태 결정 충돌. 활성 1 + 대기 1 만.
7. **CLI · MCP · 웹의 로직이 서로 다름** → 모두 같은 API 만 소비 (§9 조서현 §경험4).
8. **롤백을 별도 경로로 구현** → 헬스 게이트 스왑을 되돌리기만 (이전 이미지 태그로 재 스왑).
9. **`docker compose up` 이 자동 승인** → 로컬 개발도 3-gate 유지 · dev 모드는 자동 승인 정책이 별도.
10. **Terraform apply 를 오케스트레이터 밖에서 직접** → env_lock + state lock 우회. 데모 스크립트도 API 경유.

---

## 30. Roadmap (Now / Next / Later)

### Now (D-1 ~ D-2 · 심사 근거 즉시 강화)

- Terraform S3 backend + `use_lockfile=true` + KMS
- Anthropic prompt caching 헤더
- 파일 릴레이 MCP tool 스키마 조정
- 온프레미스 헬스 게이트 블루그린 스왑
- Executor 인터페이스 (`apps/lib/src/executor.ts`)

### Next (D-2 ~ D-4 · 완성도 확보)

- OpenBao 컨테이너 (파일 백엔드)
- AWS ECS native blue/green 어댑터 매핑
- MCP 서버 + `llms.txt`
- Slack 인터랙티브 승인
- CLI 인터랙티브 승인 프롬프트
- Grafana + Prometheus + Loki + Pyroscope 4컨테이너
- OTel Collector 사이드카 자동 주입
- 오케스트레이터 활성/대기 리더 선출
- 부팅 시 1회 자동 재개 (`resume_attempts`)

### Later (10/26 결과 뒤 · 본선 11/7 전)

- OpenTofu 로 스위치 (state client-side 암호화)
- OIDC 페더레이션 (AWS 우선 · GCP/Azure 순차)
- GCP Cloud Run 어댑터 실 구현 (T-5)
- GitHub Actions CI (T-9)
- Tempo + Mimir 추가
- `packages/repository/*` 도입 (얇은 리포지토리 계층)
- 프론트 대형 페이지 카드 분리

### Someday (본선 이후)

- Pulumi Automation API (P-01 재검토)
- 추가 워커 Go 이식 (analyzer/builder/provisioner)
- 서버리스 함수 지원 (Lambda / Cloud Functions)
- Kubernetes k3s 온프레미스 옵션 (P-05)
- 멀티 리전 배포

---

## 31. FAQ

**Q. 왜 IR 인가? Compose 확장으로 충분하지 않나?**
A. Compose 확장은 서비스 실행에는 강하지만 관리형 인프라(`resources`) · 배포 전략(`deploy.strategy`) · 오버라이드(`overrides`) 를 x-확장 필드로 밀어야 하는데 이는 스키마 검증 손실. `docs/DEPLOYMENT_SPEC_TRADEOFF.md` §7 참조.

**Q. 왜 Terraform인가? Pulumi 는?**
A. 사전 개발 종료 후 재작성 여력 없음. Pulumi Automation API 는 이점(구조체로 IR → IaC · subprocess 오버헤드 0) 이 있으나 4개 어댑터 재작성이라 본선 이후 재검토. P-01.

**Q. 왜 pg-boss 인가? River 가 더 빠르다는데?**
A. River 는 Go. 우리 orchestrator 는 TS. 실측 부하 (수십 rps) 에서 pg-boss 로 충분. graphile-worker 로 스위치도 이득 없음. `docs/ARCHITECTURE_IMPROVEMENTS_v1.md` §8-C-3.

**Q. 왜 OpenBao 인가? Vault 는 안 되나?**
A. Vault 도 되지만 BSL 라이선스. OpenBao (2.6 · LF · MPL 2.0) 는 API 호환 · 미래 라이선스 리스크 0. dev 모드 파일 백엔드로 부팅 무리 없음.

**Q. 왜 TS + Go 하이브리드인가? 전면 Go 는 왜 안 되나?**
A. `docs/LANGUAGE_TRADEOFFS.md` Case 3/4 (전면 이식) 시간 32h 안에 불가능. Case 2 하이브리드는 verifier 만 Go, 계약은 Zod → OpenAPI 3.1 export.

**Q. AI API 비용은 예산 ₩300K 에 포함?**
A. 운영진 확인 필요. `docs/hackathon.md` §10 열린 질문. Prompt caching + tool_use 2-turn 으로 배포당 $0.03-0.06 예상 → 200배 배포도 ₩10K 이내.

**Q. macOS VM 은 어떻게 데모하나?**
A. Apple Silicon 팀원 맥북. `apps/onprem-agent` 를 arm64 이미지로 (`docker buildx --platform linux/arm64,linux/amd64`).

**Q. Grafana 를 심사자에게 어떻게 보여주나?**
A. `/observability` 페이지에 Grafana 대시보드를 iframe 임베드. Grafana `[auth.anonymous] enabled=true` + `[security] allow_embedding=true`.

**Q. Slack 인터랙티브 승인은 데모에 필요?**
A. 필수 아님. 발표에서 "다채널 승인" 슬라이드로 언급 · Slack workspace 없어도 웹/CLI/MCP 3채널 시연 가능.

**Q. 온프레미스 서버 없이 데모 가능?**
A. 가능. `deploy/full-stack/docker-compose.yml` 이 컨트롤 플레인 + 사용자 앱을 같은 Docker 호스트에 띄움. Cloudflare Tunnel 로 외부에서 접근.

---

## 32. 참고 문서

### 내부

- `docs/architecture.md` v4 — 아키텍처 상세 (현행)
- `docs/decisions.md` D-01~D-34 — 결정 로그
- `docs/DEPLOYMENT_SPEC_TRADEOFF.md` — IR vs Metadata 비교 (팀 회의 자료)
- `docs/LANGUAGE_TRADEOFFS.md` — TS/Go/Java 언어 비교 (P-02 확정 근거)
- `docs/REFACTOR_AUDIT.md` — 리팩터 감사 · Phase 0/1/2 로드맵
- `docs/이전 개발 경험.md` — 조서현 사내 배포 플랫폼 실전 (§경험 1~4)
- `docs/handoff.md` — 인수인계 · 검증된 e2e 5종
- `docs/ONBOARDING_GUIDE.md` — 현행 상태 온보딩 (자매 문서)
- `docs/USER_MANUAL.md` — 사용자 매뉴얼 (5분 안에 첫 배포)
- `docs/FINAL_REPORT.md` — 최종 리포트 (발표용)
- `docs/functional-spec.md` — 기능 명세 v2
- `docs/poc-checklist.md` — PoC 진행 상태
- `docs/erd/데이터사전_v2.md` — Postgres 스키마 사전
- `docs/diagrams/architecture_v3.png` — 아키텍처 이미지
- `packages/contracts/openapi.yaml` — API 계약 export
- `llms.txt` (신규) — 외부 AI 도구 진입점

### 외부 (2026-09-29 웹서치 · v1 문서 §16 재인용)

**IaC · State**
- [Terraform S3 backend `use_lockfile`](https://developer.hashicorp.com/terraform/language/backend/s3)
- [OpenTofu vs Terraform 2026 · Encore](https://encore.dev/articles/opentofu-vs-terraform-2026)

**Queue**
- [Postgres 큐 벤치마크 2026](https://github.com/hardbyte/postgresql-job-queue-benchmarking)

**Tunneling**
- [Cloudflare Tunnel alternatives 2026 · Pinggy](https://pinggy.io/blog/best_cloudflare_tunnel_alternatives/)

**Secrets**
- [OpenBao Official](https://openbao.org/)
- [ESO vs Vault vs Infisical for PaaS · bex.co](https://bex.co/blog/2026/09/24/eso-vault-infisical-secrets-backend-paas)

**Deployment**
- [ECS Native Blue/Green (AWS) · AWS DevOps Blog](https://aws.amazon.com/blogs/devops/choosing-between-amazon-ecs-blue-green-native-or-aws-codedeploy-in-aws-cdk)

**AI**
- [Anthropic Prompt Caching Docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Lessons from building Claude Code · Anthropic](https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything)

**MCP**
- [Vercel MCP Docs](https://vercel.com/docs/cli/mcp)
- [Fly.io MCP · superfly/flymcp](https://github.com/superfly/flymcp)

---

## 부록 · 이 문서를 갱신할 때

1. **아키텍처 변경**: §3 다이어그램 + §17 실행 단위 표 + §15 리포지토리 지도.
2. **새 개념 도입**: §5~14 중 해당 절 갱신 or §5~14 다음에 새 절 추가.
3. **새 유스케이스**: §20 에 추가.
4. **결정 승격**: `docs/decisions.md` 갱신 · 이 문서 델타 박스 (`🆕/🔧/✅`) 반영.
5. **버전 태그**: 이 문서 상단 "2026-09-29" 를 갱신 날짜로. 대변경 시 `_v3.md` 로 새 파일.

---

**End of `docs/ARCHITECTURE_v2_ONBOARDING.md`.**
질문 · 이견은 `docs/decisions.md` P-01~P-09 재검토 논의로 흡수. 채택은 팀 회의 승인 후.
