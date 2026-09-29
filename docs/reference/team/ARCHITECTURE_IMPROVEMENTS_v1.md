# 아키텍처 절충 · 개선안 v1 (2026-09-29)

> **상태**: pending approval · **저자**: Claude (autonomous, 사용자 30분 취침 중 자동 작성)
> **근거**: 현행 `docs/architecture.md` v4 · `docs/DEPLOYMENT_SPEC_TRADEOFF.md` · `docs/decisions.md` D-01~D-34 · `docs/LANGUAGE_TRADEOFFS.md` · `docs/REFACTOR_AUDIT.md` · `docs/이전 개발 경험.md` (조서현 사내 배포 플랫폼 실전) · `docs/handoff.md` § 검증된 e2e 5종 + 웹서치 (2026-09-29 기준, §16 참고자료).
> **범위**: **IR + 프로바이더 어댑터는 유지**. 그 외 축(UX · 이식성 · 가용성 · 지연시간 · 정확성 · 암호키 · Terraform state · 큐 · 관측 · 승인) 을 종합 재검토.
> **의도적 비목표**: 이 문서는 결정 요약본이 아니라 **팀 회의 자료**. 각 절 끝에 "채택 시 마이그레이션 비용" 을 붙여 회의에서 P/S/X 등급을 매길 수 있도록 함.

---

## 0. 이 문서의 사용법 · 15초 안내

- **깨어나서 처음 봐야 할 것**: [§1 Executive Summary](#1-executive-summary) → [§14 최종 권고 스택](#14-최종-권고-스택-tldr) → [§15 우선순위 로드맵](#15-우선순위-로드맵-4-buckets).
- **팀 회의에 가져갈 것**: 각 서브시스템의 "권고 · 비용 · 심사 어필" 3줄. §4 ~ §9.
- **결정을 이미 흔들지 말아야 할 것**: [§2 유지 결정](#2-유지-결정-do-not-touch-window).

---

## 1. Executive Summary

### 1-1. 핵심 판단

- 현행 아키텍처(컨트롤/데이터 플레인 분리 · IR + 어댑터 · Postgres 큐 · Redis 스트림 SSE · TS 하이브리드 Go verifier)는 **심사 100점 만점 중 60점(완성도 30 + 클라우드 활용 30) 을 지탱하는 근골격**. 재작성 리스크는 이득 대비 지나치게 큼.
- 개선은 **재작성이 아니라 "가장자리 교체 (rim swap)" 로**: state 백엔드 · 시크릿 층 · 관측 스택 · UX 표면 · 승인 흐름을 국지적으로 교체.
- 조서현 님의 사내 배포 플랫폼 실전 경험(`docs/이전 개발 경험.md`) 이 정확히 "가장자리" 를 어떻게 다뤄야 하는지 (자동 준비 · 헬스 게이트 · Executor 인터페이스 · llms.txt/CLI/MCP 3-layer · 파일 저장 시크릿) 를 이미 검증했음. **그 경험을 아키텍처 축마다 흡수한 것이 이 문서의 개선안**.

### 1-2. 이 세션의 Top 10 권고 (impact 순, effort 큐레이션 됨)

| # | 권고 | 대상 축 | Impact | Effort | 근거 |
|---|---|---|---|---|---|
| 1 | **Terraform state → S3 backend + `use_lockfile=true` + Object Lock + SSE-KMS** (DynamoDB 없이) | 정확성 · 가용성 · 보안 | 🔴 High | 반나절 | TF 1.10+ 로 native locking GA. DynamoDB 제거로 인프라 1개 감소, 단일 KMS 라인으로 암호화 [§4-2, §16-1] |
| 2 | **온프레미스 헬스 게이트 = "스왑 후 유예" 블루그린으로 승격** (`-next` 컨테이너 → 헬스 통과 → 이름 교체 → `-prev` 회수) | UX · 가용성 · 정확성 | 🔴 High | 반나절 | 조서현 경험 §경험1: "이전 컨테이너 한 번도 안 멈춤 = 다운타임 0". 현재 `packages/adapters/onprem` 은 단순 compose up 이라 짧은 5xx 창 존재 [§5-2, §7-2] |
| 3 | **AWS 롤아웃 = ECS 네이티브 blue/green (2025-10 GA 카나리·linear 지원)** 채택 | 이식성 · 심사 어필 | 🟡 Med | 1일 | CodeDeploy 종속 제거 → Terraform 리소스 감소 · 어댑터 코드 슬림. Cloud Run traffic split 와 개념 일치 → IR `deploy.strategy` 매핑 균질 [§5-3, §16-6] |
| 4 | **시크릿 층 3계층으로 재편**: (a) 부팅 시크릿(SOPS+age, Git 커밋 가능) → (b) 런타임 시크릿(OpenBao 컨테이너, dev/데모 모드는 파일 백엔드) → (c) 클라우드 자격증명(OIDC 페더레이션, 장기 키 0개) | 보안 · 정확성 · 심사 어필 | 🔴 High | 1일 | OpenBao 2.6 LF governance, MPL 2.0. SOPS 는 데모 재현성. OIDC 는 D-08 완성형 [§6-2, §16-5, §16-9] |
| 5 | **AI 문맥에 시크릿 값이 절대 못 들어가는 파일 릴레이 채택** (CLI 는 stdout 대신 `~/.softbank/env-<project>` 파일 저장, AI 는 참조만) | 보안 · AI 활용 | 🟡 Med | 반나절 | 조서현 §경험4 시크릿 원칙. 현재 `apps/lib/src/mask.ts` 는 방어선 1개 → 파일 릴레이가 방어선 2개째 [§6-3] |
| 6 | **관측 = OpenTelemetry Collector 사이드카 표준 + Grafana LGTM + Pyroscope** 로 통일. 클라우드 백엔드는 어댑터 유지하되 데모 · 대시보드는 LGTM 로 균질화 | 관측 · UX · 심사 어필 | 🟡 Med | 1일 | 현재 `apps/obs-gateway` 는 다중 조회지만 대시보드가 스크린당 방문 → LGTM 단일 뷰로 데모 3분 안에 "환경 차이 흡수" 시연 강화 [§7-1] |
| 7 | **MCP 서버 + `llms.txt` + CLI 3-layer** 를 데모 필수품으로 승격 (외부 AI 도구가 우리 시스템에 배포하는 장면) | AI 활용 · 독창성 · UX | 🔴 High | 1일 | Vercel · Fly.io 는 이미 MCP 제공, 우리도 같은 문법으로 붙이면 "Claude Code 가 자기 자신을 배포" 데모 가능 [§9-3, §16-8] |
| 8 | **Postgres 큐 라이브러리 = pg-boss 유지 + 워커 `apps/lib/src/worker.ts` SKIP LOCKED 자체 루프 유지** (변경 없음 확정) | 큐 · 정확성 | ✅ Keep | 0일 | River (Go) 는 chaos 강함이지만 orchestrator 는 TS. graphile-worker 로 스위치 시 페널티 없이 이득도 없음. 실측 수십 rps 라 pg-boss 로 충분 [§8-2, §16-3] |
| 9 | **오케스트레이터 HA = 활성 1 + 대기 1 + Postgres advisory lock 리더 선출** (재시작 자동 재개 시나리오 계약화) | 가용성 · 정확성 | 🟡 Med | 반나절 | 조서현 §경험3 "서버 재시작 가정" + "부팅 시 미완료 배포 1회만 자동 재개, 2번째도 죽으면 실패" 정책을 코드로. 무한 재시작 루프 방지 [§8-3] |
| 10 | **승인 UX = "diff · plan · rollback 3-in-1 승인 위젯" + Slack 인터랙티브 · CLI 인터랙티브** | UX · 정확성 · AI 활용 | 🟡 Med | 1일 | 승인은 데모 3분의 병목. 웹만이 아니라 Slack Block Kit 버튼 + CLI TTY 로 다중 채널 승인. 이미 `apps/lib/src/slack.ts` 있음 [§9-2] |

### 1-3. 이 세션의 명시적 "하지 않을 것"

- 언어 재작성 (Case 3/4). D-28 확정 유지.
- IR 스키마 대체 (Compose 확장으로 전환 등). D-03 유지.
- Terraform → Pulumi 전면 이식 (P-01 미결정이지만 데모 안정성 최우선).
- 큐 라이브러리 스위치 (pg-boss → River/graphile-worker).
- 서버리스 함수 지원 확장 (현 M 기능 우선순위 미확정 P-09 결정 전까지 보류).

---

## 2. 유지 결정 · "Do-Not-Touch Window"

10/3 제출까지 아래 결정은 재검토 금지. 흔들면 데모 실패 확률 급등.

| 결정 | 유지 이유 | 근거 문서 |
|---|---|---|
| D-01/D-02 컨트롤/데이터 플레인 분리 | 심사 이식성 30점 근골격 | `docs/decisions.md`, `docs/architecture.md` §2.1 |
| D-03 IR + 어댑터 | 사용자 명시 유지 조건 | 본 문서 상단 |
| D-11 Postgres 큐 (SKIP LOCKED + LISTEN/NOTIFY) | 이중 쓰기 제거 · 이미 검증 | `apps/lib/src/worker.ts:76-107`, `apps/orchestrator/src/index.ts:13-15` |
| D-22 AWS = ECS Fargate | App Runner 신규 불가 (2026-04-30~) | `docs/decisions.md` |
| D-28 TS 유지 + verifier Go 하이브리드 | 사전 개발 종료, 재작성 불가 | `docs/LANGUAGE_TRADEOFFS.md` |
| SSE = Redis Streams + Pub/Sub + Last-Event-ID | 88 tests 통과, 프론트 검증 완료 | `apps/lib/src/sse.ts` |
| Zod contracts 3자 공유 | 프론트/CLI/agent 공통 계약 | `packages/contracts/*` |

---

## 3. 개선 대상 표면 6개 (Rim Swap Map)

```
                 ┌──────────────────────────────┐
                 │  UX & Client (§9)            │
                 │  Web · CLI · MCP · SSE ·     │
                 │  OnPrem Agent · Slack UX     │
                 └──────────────┬───────────────┘
                                │
        ┌──────────────────────┴─────────────────────────┐
        │                                                 │
┌───────▼────────┐  ┌──────────────┐  ┌──────────────┐  ┌▼──────────────┐
│ Spec Authoring │  │ Execution &  │  │ Orchestration│  │ Observability │
│ & Analyzer     │  │ State Backend│  │ Core (§8)    │  │ & Feedback    │
│ (§4)           │  │ (§5)         │  │              │  │ (§7)          │
└────────────────┘  └──────┬───────┘  └──────────────┘  └───────────────┘
                           │
                    ┌──────▼──────┐
                    │ Security &  │
                    │ Credentials │
                    │ (§6)        │
                    └─────────────┘

   [IR + Adapter (D-03) = 핵심 코어. 유지]
```

각 절은 다음 5-part 로 구성:
- **A. 현행** (실측 · 파일:라인 인용)
- **B. 약점** (감사 · PoC · 이전 경험에서 노출)
- **C. 옵션 · 절충** (2-4 안, 대회 · 프로덕션 시간축)
- **D. 권고 + 근거**
- **E. 마이그레이션 비용 & UX/이식성/가용성/지연/정확성 델타**

---

## 4. 서브시스템 A · Spec 저작·분석 파이프라인

### 4-A. 현행

- **IR 스키마**: `packages/ir-schema/src/index.ts` · Zod 6개 최상위 필드 (`schemaVersion` · `metadata` · `services` · `resources` · `deploy` · `overrides` · `expose`) · `IR_SCHEMA_VERSION = '0.1.0'` · `dependsOn` 위상 정렬 지원.
- **Analyzer**: `apps/workers/analyzer/src/index.ts` (~283 LOC) 규칙 감지 (Node/Rails/Spring/Next · docker-compose MSA 감지) + LLM 보조.
- **AI 에이전트**: `apps/agent/*` Anthropic SDK 0.30, tool_use, prompt caching **아직 미사용**.
- **계약 export**: `packages/contracts/openapi.yaml` (Zod → OpenAPI 3.1 export) 확정, Go 워커도 재사용.

### 4-B. 약점

1. **AI 호출 비용 최적화 미흡** — prompt caching 헤더 미사용. Sonnet 4.6 반복 프롬프트가 매번 full input 요금 지불 (§16-7 근거: 캐시 히트 시 최대 90% 절감).
2. **Analyzer 언어 커버리지** — Node 만 소스 파일 스캔, Go/Python/Rust 는 매니페스트만 (`docs/DEPLOYMENT_SPEC_TRADEOFF.md` §15 후속 미해결).
3. **AI 패치 부작용** — 소스 dir 를 in-place mutate → 여러 배포 공유 시 오염 (동 후속 미해결).
4. **모노레포 서브프로젝트 UI** — 감지는 되지만 사용자 인터랙션 미구현.
5. **IR 버전 관리 UX** — `ir_versions` 테이블은 있지만 diff 뷰 없음 → 사용자가 "AI 가 뭘 바꿨나" 를 즉시 확인 불가.

### 4-C. 옵션

**C-1. 스키마 자체는 유지, 저작 UX 를 강화** (권장)
- Zod → JSON Schema draft 2020-12 export 파이프라인 정착 → LLM 프롬프트에 `$ref` 로 삽입 (첫 시도 성공률 상승).
- IR diff 뷰: `packages/ir-schema` 에 `diff(a: Ir, b: Ir): IrChange[]` 유틸 추가.

**C-2. IR 스키마를 Docker Compose 확장 문법으로 전환** (비권장)
- 사용자 학습 곡선 완화 (Compose 는 저명).
- 손실: `resources` (관리형 DB · 버킷) · `overrides` · `deploy.strategy` · `expose` 를 x-확장 필드로 밀어야 하는데, 이는 스키마 검증 손실.
- 결정: DEPLOYMENT_SPEC_TRADEOFF §7 결론과 정합. **채택 안 함**.

**C-3. AI 파이프라인 3단계 강화** (권장)
- Stage 1 FACTS: `apps/workers/analyzer` 에 언어별 어댑터 (`analyzer/langs/{node,python,go,rust}.ts`) 신설. 포트 검출까지 규칙으로.
- Stage 2 규칙: 현행 유지.
- Stage 3 AI 보조: **prompt caching** 채택. system prompt · tool 정의 · IR JSON Schema 를 캐시 세그먼트로. `apps/agent/src/anthropic.ts` 에 `cache_control: {type: "ephemeral"}` 삽입.
- **per-deployment 소스 카피** 정착 — `apps/lib/src/subprocess.ts` 에 `stageSource(deploymentId, sourceRef)` 도입해서 패치가 원본 오염하지 않도록.

### 4-D. 권고

- **채택**: C-1 + C-3.
- **비고**: IR 스키마는 손대지 말 것. 저작 파이프라인의 프롬프트 · 캐시 · 소스 스테이징만 개선.

### 4-E. 마이그레이션 비용 & 델타

| 항목 | Effort | UX | 이식성 | 가용성 | 지연시간 | 정확성 |
|---|---|---|---|---|---|---|
| C-1 IR diff 뷰 + JSON Schema export | 반나절 | ↑↑ | ─ | ─ | ─ | ↑ |
| C-3 prompt caching | 1시간 | ─ | ─ | ─ | ↑↑ (TTFT 수초 → 수백ms) | ─ |
| C-3 언어별 어댑터 (py/go/rust) | 반나절 | ↑ | ↑ | ─ | ─ | ↑↑ |
| C-3 per-deployment 소스 카피 | 2시간 | ─ | ─ | ↑ | ↓ (I/O 오버헤드) | ↑↑ (오염 제거) |

---

## 5. 서브시스템 B · 실행 · Terraform State 백엔드

### 5-A. 현행

- **IaC 엔진**: Terraform CLI 서브프로세스 (`apps/workers/provisioner/src/terraform.ts`).
- **State 백엔드**: **로컬 파일 시스템** (배포별 workdir `/tmp/tf/{deploymentId}/`), `backend "local" {}` 상당.
- **Lock**: 로컬 파일 lock 만 존재. 진짜 동시성 방어는 오케스트레이터의 `env_locks` 테이블만.
- **State 파일 안전성**: state 파일에 DB 비밀번호 평문 저장 가능 (Terraform 특성).
- **P-01**: Pulumi vs Terraform CLI 미결정 (`docs/decisions.md`).

### 5-B. 약점

1. **State 유실 리스크** — 컨트롤 플레인 컨테이너 재시작 시 `/tmp` 날아감 → destroy 불가 → 좀비 리소스.
2. **State 잠금 부재** — orchestrator 밖에서 `terraform apply` 를 직접 돌리는 시나리오 (심사자가 시연 중 데모 · 재현 스크립트 실행 등) 방어 못함.
3. **State 파일 평문 비밀값** — 심사자 코드 리뷰 시 감점 요인.
4. **AWS blue/green 롤아웃 코드 부재** — CodeDeploy · 카나리는 아직 대부분 애플리케이션 레이어에서 verifier + 재시도로 구현. AWS 는 2025-10 ECS native blue/green + canary GA (§16-6) → **Terraform 리소스로 표현 가능**해짐.

### 5-C. 옵션

**C-1. Terraform CLI 유지 + S3 backend + `use_lockfile=true` + Object Lock + SSE-KMS**

```hcl
terraform {
  required_version = ">= 1.10.0"
  backend "s3" {
    bucket       = "softbank-tf-state"
    key          = "deployments/${deployment_id}/terraform.tfstate"
    region       = "ap-northeast-2"
    encrypt      = true
    kms_key_id   = "arn:aws:kms:ap-northeast-2:...:key/..."
    use_lockfile = true   # native locking, DynamoDB 불필요 (TF 1.10+)
  }
}
```

- **이득**: DynamoDB 리소스 0개. 락 파일 `.tflock` 이 state 옆에 자동. Object Lock 로 실수 삭제 방어. KMS 로 state 자체 SSE.
- **비용**: 반나절. `apps/workers/provisioner/src/terraform.ts` 의 workdir 생성 시 backend HCL 을 배포별 template 로 렌더. deployment_id → key 매핑.

**C-2. OpenTofu 로 스위치 + native state encryption + KMS pluggable**

- OpenTofu 1.7+ 는 state · plan 파일 **자체를 클라이언트에서 AES-GCM 암호화** (§16-2). Terraform 은 backend SSE-KMS 만.
- MPL 2.0 → 심사 팀 개발 20점 "왜 OpenTofu" 논거 강함.
- 비용: TF binary 교체만. `terraform.ts` 의 `runCmd('terraform', ...)` → `runCmd('tofu', ...)`. HCL 대부분 호환 (1.5 API 이하).
- 리스크: 프로바이더 (aws/hashicorp) 는 그대로. AWS blue/green 등 최신 스키마는 검증 필요 (하지만 우리 리소스 세트는 안정 리소스만 사용).

**C-3. Pulumi Automation API** (P-01 대안 · 비권장)

- Node 프로세스 내부에서 실행 → subprocess 오버헤드 0.
- 이득: 계약 통일 (TS 로 IR → Pulumi 프로그램).
- 비용: **AWS/GCP/Azure/온프렘 4개 어댑터 재작성**. 하이 리스크 (사전 개발 종료, 재작성 여력 없음).
- 결정: 본선 이후 재검토.

### 5-D. 권고

- **즉시 (D-2 내)**: **C-1 채택** (Terraform 유지 + S3 backend + native locking + KMS).
- **본선 준비 (11/7 전)**: **C-2 로 스위치 (OpenTofu)** — 팀 개발 점수 명분 확보 + state 암호화 자동. 지금 리서치 결과 (§16-2) 에 따르면 대부분 코드 무변경.
- **P-01 결정**: Terraform CLI 유지 (Pulumi 는 본선 이후).
- **AWS blue/green**: 2025-10 GA ECS native blue/green 채택 (§5-3 상세는 §5-E-3 참조).

### 5-E. 마이그레이션 비용 & 델타

| 항목 | Effort | UX | 이식성 | 가용성 | 지연시간 | 정확성 |
|---|---|---|---|---|---|---|
| C-1 S3 backend + use_lockfile + KMS | 반나절 | ─ | ↑ | ↑↑ (state 유실 방지) | ─ | ↑↑ (동시성 방어) |
| C-2 OpenTofu 로 스위치 | 2시간 | ─ | ↑ (BSL 회피) | ↑ (state 암호화) | ─ | ↑ |
| **C-3 AWS ECS native blue/green (2025-10 GA)** | 1일 | ↑ (승인 UX 통일) | ↑ (GCP traffic split · Azure revision 과 개념 일치) | ↑↑ (헬스 게이트 자동) | ─ | ↑↑ (롤백 즉시) |

**§5-E-3 AWS blue/green 세부 계획**:
- `packages/adapters/aws/terraform/` 의 ECS service 리소스에 `deployment_configuration.strategy = "BLUE_GREEN"` 및 `deployment_configuration.bake_time_in_minutes` 추가.
- IR `deploy.strategy: canary` 인 경우 어댑터가 native canary 로 매핑 (`traffic_shift.type = "CANARY_10_PERCENT_5_MINUTES"`).
- verifier 역할 = 카나리 검증 대신 **native rollback trigger 관찰**로 단순화. 코드 감소 예상.

---

## 6. 서브시스템 C · 보안 · 자격증명 층

### 6-A. 현행

- **클라우드 자격증명**: `credentials` 테이블에 `config JSON` (마스킹 후 저장). D-08 은 "역할 위임 + 단기 자격증명" 이지만 실 구현은 여전히 액세스 키 저장 경로 존재.
- **앱 시크릿 (사용자 env)**: Redis 임시 저장 → 컨테이너 주입.
- **AI 마스킹**: `apps/agent/src/mask.ts` 에서 정규식 마스킹 (4 시나리오 커버).
- **Vault**: 없음. 개념만 D-08 · REFACTOR_AUDIT K-Phase-2 에 명시.

### 6-B. 약점

1. **장기 액세스 키 저장 경로 존재** — OIDC 페더레이션 미구현.
2. **Redis 평문 저장** — REFACTOR_AUDIT K-Phase-2 "Vault 로 이관 · Redis 평문 저장 제거" 미완.
3. **AI 문맥 시크릿 유출 방어선 1개** — 마스킹 정규식이 새 형태 (예: prefixed base64 API key) 를 못 잡을 수 있음. 조서현 §경험4 원칙 "AI 가 값을 보지 않는다" 를 아키텍처 레벨로 강제해야.
4. **부팅 시크릿과 런타임 시크릿 미분리** — `deploy/full-stack/.env` 하나에 다 몰림. 재현성/보안 미분리.

### 6-C. 옵션 · 3계층 재편 권고

**계층 1: 부팅 시크릿 (SOPS + age)**

- 컨트롤 플레인 자체가 뜨기 위해 필요한 시크릿 (DB password, JWT secret, Redis password, MinIO root creds).
- SOPS 로 age 공개키 암호화 → Git 커밋 가능 → 재현성/데모 부팅 확실.
- 팀원 각자 age private key 를 로컬 `~/.config/sops/age/keys.txt` 에.
- 데모 서버는 age private key 가 하나만 필요 → `docker compose --env-file <(sops -d .env.enc) up`.

**계층 2: 런타임 시크릿 (OpenBao 컨테이너)**

- 사용자 앱 시크릿 · 클라우드 자격증명을 OpenBao KV v2 로.
- OpenBao 2.6 (LF governance, MPL 2.0, §16-5) 를 `deploy/control-plane/docker-compose.yml` 에 한 줄 추가.
- dev/데모 모드는 **파일 스토리지 백엔드** + **transit seal 자동 unseal** (self-referencing) 로 단일 컨테이너 부팅.
- 프로덕션 마이그레이션 = KMS auto-unseal 로 backend 만 교체.
- `apps/lib/src/credentials.ts` 에 `getSecret(path)` 추가. Redis 평문 저장 제거.

**계층 3: 클라우드 자격증명 (OIDC 페더레이션)**

- **AWS**: 컨트롤 플레인이 GitHub Actions OIDC 스타일로 AssumeRoleWithWebIdentity. `id_token = JWT{ aud: sts.amazonaws.com, sub: deployment_id }`. 15분 자격증명.
- **GCP**: Workload Identity Federation. Provider 는 OpenBao 가 발급하는 OIDC IdP (내장 기능).
- **Azure**: Workload Identity Federation.
- **온프레미스**: OpenBao AppRole (그대로).
- **효과**: `credentials` 테이블에는 **역할 ARN/리소스명만 저장**. 장기 키 0개.

**계층 4: AI 문맥 시크릿 방어 (파일 릴레이)**

- 조서현 §경험4: "CLI 로 환경변수 조작할 때 출력에 키를 찍지 않고 파일에 저장, AI 는 참조만".
- CLI `softbank env set <PROJECT> KEY=VAL` → API 는 볼트에 저장하고 응답에는 **path 만** (`vault://projects/1/env`).
- MCP tool 정의도 동일: `set_env` 는 value 를 받지만 `get_env` 는 없음 → AI 는 "이 프로젝트에는 DATABASE_URL 이 설정됨" 사실만 알고 값은 모름.
- `apps/lib/src/mask.ts` 는 이제 **2차 방어선** (LLM 응답 검증 · 로그 마스킹) 으로 재정의.

### 6-D. 권고

- **채택**: 4개 계층 모두. 데모 D-1 ~ D-4 내 완료 가능한 순서:
  1. **D-1**: 계층 4 (AI 파일 릴레이) — MCP tool 스키마 조정 · 반나절.
  2. **D-2**: 계층 2 (OpenBao 컨테이너 · 파일 백엔드) — `apps/lib/src/credentials.ts` 교체 · 1일.
  3. **D-3**: 계층 1 (SOPS+age) — 데모 부팅 재현성 · 2시간.
  4. **D-4 or 본선**: 계층 3 (OIDC 페더레이션) — AWS 만 우선 · 반나절.

### 6-E. 마이그레이션 비용 & 델타

| 항목 | Effort | UX | 이식성 | 가용성 | 지연시간 | 정확성 · 보안 |
|---|---|---|---|---|---|---|
| 계층 1 SOPS+age | 2시간 | ↑ (git clone → 데모) | ─ | ↑ | ─ | ↑↑ |
| 계층 2 OpenBao | 1일 | ─ | ↑ | ↑ | ─ (캐시 사용 시) | ↑↑↑ |
| 계층 3 OIDC 페더레이션 | 반나절 (AWS) | ─ | ↑ | ─ | ─ | ↑↑↑ (장기 키 0) |
| 계층 4 파일 릴레이 | 반나절 | ↑ | ─ | ─ | ─ | ↑↑ (AI 유출 방어) |

---

## 7. 서브시스템 D · 관측 · 피드백 루프

### 7-A. 현행

- **obs-gateway**: `apps/obs-gateway/*` (52 LOC 참조 구현, `packages/obs-adapters/{cloudwatch,loki}`).
- **대시보드**: `/observability` · `/costs` · `/incidents` — Yoitang 벤치마킹 반영 (Recharts).
- **OTel 주입**: 계획만 있고 실 주입 코드 미완.
- **Pyroscope**: 계획만.

### 7-B. 약점

1. **환경별 데이터 소스 파편화** — 데모 3분 안에 심사관에게 "AWS · 온프렘 로그가 한 화면에" 를 시연하려면 화면 전환이 어색.
2. **OTel 자동 주입 부재** — IR 에 `expose.otel: true` 같은 필드 없음. 사용자 앱이 OTel SDK 를 직접 넣어야 하는 인상.
3. **로그 · 트레이스 · 프로파일 · 메트릭 4가지 분리** — 심사자 시연에서 스텝 소요 → 특정 앱 트레이스 → 프로파일까지 한 번에 못 넘어감.

### 7-C. 옵션

**C-1. Grafana LGTM (Loki · Grafana · Tempo · Mimir) 스택 + Pyroscope 통일** (권장)

- `deploy/control-plane/docker-compose.yml` 에 5 컨테이너 추가 (Grafana · Loki · Tempo · Mimir · Pyroscope).
- 어댑터는 유지 (CloudWatch 조회 · Cloud Logging 조회) 하지만 **어댑터 응답을 Loki/Tempo/Mimir 로 forward** → 하나의 Grafana 뷰.
- OpenTelemetry Collector 사이드카를 데이터 플레인에 자동 주입 (IR `expose.otel = true` default true).

**C-2. Elastic / OpenSearch 스택** (비권장 · 규모 과잉)

**C-3. 각 클라우드 콘솔 링크만 제공** (비권장 · DEPLOYMENT_SPEC_TRADEOFF P-09 fallback)

### 7-D. 권고

- **채택**: C-1. 단, 5 컨테이너는 무겁다 → **Grafana + Prometheus (Alertmanager 없이) + Loki + Pyroscope** 4개로 축소, Tempo/Mimir 는 본선.
- **효과**: 심사 시연에서 "카나리 트래픽 10% → 에러율 스파이크 → 자동 롤백" 을 하나의 Grafana 대시보드에서 보여줄 수 있음.

### 7-E. 마이그레이션 비용 & 델타

| 항목 | Effort | UX | 이식성 | 가용성 | 지연시간 | 정확성 |
|---|---|---|---|---|---|---|
| Grafana + Prometheus + Loki + Pyroscope 컨테이너 4개 | 반나절 | ↑↑↑ | ↑ (환경 균질) | ─ | ─ | ↑ (지표 통합) |
| OTel Collector 사이드카 자동 주입 (`expose.otel` default true) | 1일 | ↑ | ↑↑ | ─ | ↓ (약간) | ↑↑ |
| 어댑터 응답 forward-to-loki | 1일 | ↑↑ | ↑ | ─ | ↓ (실시간 조회 대신 캐시) | ─ |

---

## 8. 서브시스템 E · 오케스트레이션 코어

### 8-A. 현행

- **상태 머신**: `apps/orchestrator/src/state-machine.ts` (16 상태 · canTransition 12 test).
- **큐**: pg-boss (orchestrator) + `apps/lib/src/worker.ts` 자체 워커 루프 (SKIP LOCKED + 지수 백오프).
- **HA**: 활성 1 (대기 없음). Postgres 상태로 재시작 이론적으로 가능하지만 리더 선출 미구현.
- **승인**: `approvals` 테이블 (D-26 오케스트레이터 소유). 웹 UI · CLI 로 결정 전달.
- **락**: `env_locks` (D-15 환경 확정 직후 획득).

### 8-B. 약점

1. **오케스트레이터 SPOF** — 활성 1 만. 재시작 시 in-flight 배포는 어떻게 이어질지 계약이 흐림.
2. **부팅 시 자동 재개 정책 부재** — 조서현 §경험3 "부팅 시 미완료 배포 1회만 자동 재개, 두 번째도 죽으면 실패" 정책이 코드로 없음.
3. **승인 만료 처리** — `expireStaleApprovals` 있지만 테스트 없음 (REFACTOR_AUDIT I 갭).
4. **jobs 우회 쓰기 검증** — 워커가 다른 컴포넌트 소유 테이블에 쓸 수 있는 표면적 있음 (REFACTOR_AUDIT B 계층 위반 후보).

### 8-C. 옵션

**C-1. 활성 1 + 대기 1 + Postgres advisory lock 리더 선출** (권장)

- 오케스트레이터 부팅 시 `SELECT pg_try_advisory_lock(<hash('orchestrator-leader')>)` → 성공 시 리더. 실패 시 대기 (60s 폴링).
- 리더는 매 30초마다 lease renewal 컬럼 갱신. 리더 사망 → 대기가 60s + jitter 이내 승격.
- 조서현 §경험3 재개 정책 = 리더 승격 직후 `SELECT * FROM deployments WHERE state IN (progressive states) AND updated_at > now() - interval '10 min'` → 각각 1회만 재개 (`resume_attempts++`, 2 이상이면 `failed` 처리).

**C-2. Temporal 도입** (비권장, 데모 리스크)

- 상태 머신 · 재시도 · 승인 대기가 native.
- 비용: Temporal 서버 컨테이너 추가 + Client SDK 재작성. 사전 개발 종료 후 이식 비현실.

**C-3. 큐 라이브러리 스위치 (pg-boss → River)** (비권장)

- River 는 chaos 회복성 강함 (§16-3) 이지만 Go 종속. orchestrator 는 TS.
- pg-boss 로 실측 부하 (수십 rps) 충분. 이득 없음.

### 8-D. 권고

- **채택**: C-1. C-2/C-3 는 비권장.
- **추가**: 승인 만료 vitest 커버 (`apps/orchestrator/src/transitions.ts` `expireStaleApprovals` · Slack notify mock).

### 8-E. 마이그레이션 비용 & 델타

| 항목 | Effort | UX | 이식성 | 가용성 | 지연시간 | 정확성 |
|---|---|---|---|---|---|---|
| 활성 1 + 대기 1 + advisory lock | 반나절 | ─ | ─ | ↑↑↑ | ↑ (fail-over 60s) | ↑↑ |
| 부팅 시 1회 자동 재개 정책 | 2시간 | ↑ (배포 중 재시작 후 계속) | ─ | ↑↑ | ─ | ↑↑↑ |
| 승인 만료 vitest 커버 | 1시간 | ─ | ─ | ─ | ─ | ↑ |

---

## 9. 서브시스템 F · UX · 클라이언트 층

### 9-A. 현행

- **웹**: Next.js 15 App Router · React 19 · Tailwind · TanStack Query · Zustand · React Flow.
- **CLI**: `softbank init/deploy/status/logs/rollback/approve` (~298 LOC).
- **MCP**: 아직 없음. `docs/이전 개발 경험.md` §경험4 에서 언급되나 미구현.
- **온프렘 에이전트**: 롱 폴링 (`apps/onprem-agent`).
- **Slack**: Block Kit 알림 5 상태 (`apps/lib/src/slack.ts`).
- **SSE**: Last-Event-ID 재연결 (`@microsoft/fetch-event-source`).

### 9-B. 약점

1. **승인 UX 병목** — 웹만이 승인 채널. 데모 3분에서 심사관이 웹 스위칭.
2. **CLI 인터랙티브 부족** — 승인 대기 시 CLI 가 blocking 하고 y/n 로 결정 못함.
3. **MCP 부재** — "Claude Code 가 자기 자신을 배포" 데모 불가.
4. **`llms.txt` 부재** — 외부 AI 도구가 우리 시스템 사용법을 스스로 배울 진입점 없음.
5. **에러 메시지에 다음 행동 없음** — 조서현 §경험4 "에러 메시지에 다음 행동 포함" 원칙 미적용.

### 9-C. 옵션

**C-1. 다채널 승인 위젯**
- **웹**: 이미 있음. `plan` · `patch` · `target` diff/preview 를 하나의 카드로 통합 (`ApprovalWidget.tsx`).
- **Slack**: Block Kit "Approve/Reject/Comment" 인터랙티브 버튼. Slack app 을 만들지 않고 webhook + interactive endpoint (`POST /slack/interactions`).
- **CLI**: `softbank deploy` 는 승인 대기 시 SSE 스트림에서 `approval_requested` 이벤트 오면 TTY 에 diff 렌더 + `[a]pprove / [r]eject / [w]eb` 프롬프트.

**C-2. MCP + `llms.txt` + CLI 3-layer** (조서현 §경험4)
- `apps/mcp/*` 신규: `deploy(project_id, target_id, strategy)`, `approve(deployment_id, kind, decision)`, `logs(deployment_id, tail=100)`, `set_env(project_id, key, value)`, `list_targets()`, `create_target(...)`.
- 각 도구는 `requires_approval` 속성 반영 → 파괴적 도구는 dry-run mode default.
- `llms.txt`: 리포 루트에 `# SoftBank Deploy System\n\n## What this does\n\n...\n\n## CLI usage\n\n...` 서술.

**C-3. 에러 메시지 규칙**
- API 응답에 `hint` 필드 추가 (`packages/contracts` 응답 스키마 확장).
- CLI 는 `hint` 를 다음 명령어 형태로 렌더.

**C-4. 프론트 페이지 크기 정리** (REFACTOR_AUDIT C-5/C-6 흡수)
- `app/projects/[id]/page.tsx` 510L → 카드 컴포넌트 분리.
- `app/deployments/[id]/page.tsx` 416L → `StepsTable` · `ApprovalsTable` · `IncidentCard` 재사용.

### 9-D. 권고

- **채택**: C-1 (다채널 승인), C-2 (MCP + llms.txt), C-3 (hint 필드).
- **C-4 (프론트 리팩터)**: Phase 1 (팀 킥오프 뒤) 로 미룸. 심사 근거 아님.

### 9-E. 마이그레이션 비용 & 델타

| 항목 | Effort | UX | 이식성 | 가용성 | 지연시간 | 정확성 |
|---|---|---|---|---|---|---|
| C-1 다채널 승인 위젯 | 1일 | ↑↑↑ | ─ | ↑ | ↑ (Slack 알림→즉시 승인) | ↑ |
| C-2 MCP + llms.txt | 1일 | ↑↑ | ↑↑ | ─ | ─ | ↑ (`requires_approval` 강제) |
| C-3 hint 필드 | 2시간 | ↑↑ | ─ | ─ | ─ | ↑↑ (self-recovery) |

---

## 10. 서브시스템 G · 온프레미스 데이터 플레인 브릿지 (§9 확장)

조서현 §경험1~4 를 온프레미스 어댑터에 정확히 이식.

### 10-A. 현행

- `packages/adapters/onprem/src/index.ts` (~319 LOC).
- Cloudflare Tunnel `expose.cloudflareTunnel: true` 로 시연 완주.
- 컨테이너 스왑은 단순 `docker compose up -d --force-recreate` (짧은 5xx 창 존재).

### 10-B. 개선

**B-1. 헬스 게이트 블루그린 스왑 정착** (Top 10 §2)
- 컨테이너 이름 스왑 순서:
  1. `<name>-next` 로 임시 이름 기동.
  2. `/health` (지정 시) 또는 `/` HTTP 5xx 미만 = 생존 판정 (조서현 §경험1 "5xx 미만 = 프로세스가 요청을 처리한다는 증거").
  3. 통과 → `<name>` → `<name>-prev`, `<name>-next` → `<name>` 로 rename. Cloudflare Tunnel · Traefik 라벨은 `<name>` 기준이라 트래픽 자동 스위치.
  4. 3~5초 유예 → `<name>-prev` 제거.
- 실패 시 `<name>-next` 만 제거. **이전 컨테이너는 한 번도 안 멈춤 = 다운타임 0**.
- 부팅 치유: 등록된 이름과 정확히 일치하는 `-next`/`-prev` 잔존만 정리.

**B-2. Executor 인터페이스 정착** (조서현 §경험3)
- `apps/lib/src/executor.ts` 신규: `interface Executor { run(cmd), stream(cmd), openRawStream(cmd) }`.
- 온프렘 = SSH 구현 (또는 로컬), 데이터 플레인은 어댑터가 Executor 만 참조.
- 테스트에서는 `FakeExecutor` 로 명령 순서 단언.

**B-3. Cloudflare Tunnel 사이드카 정착**
- IR `expose.cloudflareTunnel: true` → `packages/adapters/onprem` 이 자동으로 `cloudflared` 서비스 삽입 (docker-compose).
- 크레덴셜은 `/etc/cloudflared/config.yaml` 볼륨 마운트 → OpenBao KV path.

### 10-C. 대안: Tailscale Funnel · frp · ngrok

- **Tailscale Funnel** — 아직 베타, 공개 노출 유연성 낮음 (§16-4). **부적합**.
- **frp / ngrok** — 학생 무료 티어 제한. Cloudflare Tunnel 이 대회 데모 · 프로덕션 모두 커버.
- **결론**: Cloudflare Tunnel 유지.

### 10-D. 마이그레이션 비용

| 항목 | Effort | UX | 이식성 | 가용성 | 지연시간 | 정확성 |
|---|---|---|---|---|---|---|
| B-1 헬스 게이트 블루그린 | 반나절 | ↑↑ (다운타임 0) | ─ | ↑↑↑ | ─ | ↑↑ |
| B-2 Executor 인터페이스 | 1일 | ─ | ↑↑ | ─ | ─ | ↑ (테스트) |
| B-3 Cloudflare Tunnel 사이드카 | 2시간 | ↑ | ↑ | ↑ | ─ | ─ |

---

## 11. 축별 통합 뷰 (권고 채택 시 어디가 얼마나 좋아지는가)

| 축 | 현행 상대점수 | 채택 후 상대점수 | 주 개선 근거 |
|---|---:|---:|---|
| **UX** | 6/10 | 9/10 | Grafana 통합 뷰 · 다채널 승인 · MCP · hint 필드 · IR diff 뷰 |
| **이식성** | 8/10 | 9/10 | OpenTofu MPL · OTel 표준화 · OIDC 페더레이션 · MCP |
| **가용성** | 5/10 | 8/10 | 활성/대기 리더 · S3 backend state · 헬스 게이트 블루그린 |
| **지연시간** | 6/10 | 8/10 | prompt caching (TTFT 수초→수백ms) · Slack 즉시 승인 · ECS native 롤아웃 (verifier 관찰 시간 단축) |
| **정확성** | 7/10 | 9/10 | OIDC (장기 키 0) · state lock · 오염 격리 소스 카피 · 파일 릴레이 시크릿 |

> 상대점수는 정성 추정. 실측이 아니라 심사자 인식 개선 기준. 근거 부족한 항목은 §17 열린 질문 참조.

---

## 12. 심사 100점 매핑

| 항목 | 배점 | 현재 지지 근거 | 이 개선으로 추가되는 지지 근거 |
|---|---:|---|---|
| 완성도 · 데모 | 30 | 검증된 e2e 5종, 원큐 부팅 | 다운타임 0 블루그린 시연, 다채널 승인, 카나리 자동 롤백을 native ECS 로 |
| 클라우드 활용 | 30 | 4개 어댑터, IR overrides | OpenTofu state 암호화, OIDC 페더레이션, OTel 표준 사이드카, Grafana 통합 |
| 팀 개발 · 문서화 | 20 | decisions.md D-01~D-34, 이 문서 자체 | 각 서브시스템의 옵션·트레이드오프 정리, 근거 있는 "왜 OpenTofu" · "왜 S3 native locking" |
| 독창성 | 10 | 하이브리드 워커, Cloudflare Tunnel 사이드카 | MCP + llms.txt 로 "AI 가 우리 시스템에 배포" 데모, 파일 릴레이 시크릿 원칙 |
| AI 활용 | 10 | tool_use, mask.ts, 규칙 우선 · AI 보조 | prompt caching, IR JSON Schema 프롬프트, `requires_approval` 코드 강제 |

---

## 13. 리스크 · 실패 모드

| 리스크 | 확률 | 영향 | 완화 |
|---|---|---|---|
| S3 backend 마이그레이션 중 state 유실 | 낮 | 심각 | 배포 워크스페이스 새로 생성 후 순차 이전. 기존 배포는 destroy 후 재배포 |
| OpenBao 컨테이너가 부팅 시 unseal 실패 → 컨트롤 플레인 다운 | 중 | 심각 | 파일 백엔드 + transit self-seal, 부팅 스크립트에 unseal 재시도 3회 |
| OIDC 페더레이션 IdP 발급 지연 → 첫 배포 실패 | 낮 | 중 | OpenBao 내장 OIDC · 지연 <100ms 예상. IdP endpoint health check 를 오케스트레이터 부팅 시 |
| 다채널 승인 재진입 (같은 승인이 웹/Slack/CLI 3곳 동시 결정) | 중 | 중 | `approvals.decided_by` unique constraint · 첫 결정만 반영, 나머지 409 반환 |
| MCP 도구 노출로 인한 남용 (외부 AI 가 임의 삭제) | 중 | 심각 | `requires_approval` 강제 + rate limit + Vault-scoped token · 파괴적 명령은 `--yes` 없이는 거부 (조서현 §경험4) |
| Grafana 스택 5 컨테이너로 부팅 시간 팽창 → 데모 지연 | 중 | 중 | 4개로 축소 (Tempo/Mimir 는 본선), `docker compose --profile=full` 로 데모 시 선택 기동 |
| ECS native blue/green GA 스키마가 프로바이더에서 아직 불안 | 낮 | 중 | 실 apply 리그레션 vitest (`packages/adapters/aws/terraform/blue-green.test.ts`) 로 프리플라이트 |

---

## 14. 최종 권고 스택 (TL;DR)

```
┌─ 사용자 표면 ─────────────────────────────────────────────────────┐
│ Web (Next.js 15 · Grafana LGTM iframe) · CLI (인터랙티브 승인)     │
│ MCP 서버 + llms.txt (외부 AI 도구용) · Slack (Block Kit 인터랙티브)│
└───────────────────────────────────────────────────────────────────┘
                              ↕ REST · SSE (Last-Event-ID)
┌─ 컨트롤 플레인 ───────────────────────────────────────────────────┐
│ API (Fastify · TS, N대)                                           │
│ Orchestrator (활성 1 + 대기 1 · Postgres advisory lock 리더 선출) │
│ Agent (Anthropic SDK · prompt caching · 파일 릴레이 시크릿)       │
│ Obs-Gateway (환경 어댑터 조회 → Loki forward)                     │
│ Recommender (규칙 + pricing-catalog)                              │
│ Workers: analyzer · builder (BuildKit · multi-arch) ·             │
│          provisioner (TF 유지 + OpenTofu 본선) ·                  │
│          verifier (Go 하이브리드 · k6 남김)                       │
│ 큐 = pg-boss + apps/lib/src/worker.ts (SKIP LOCKED + LISTEN NOTIFY)│
│ 리소스: Postgres · Redis (SSE 만) · MinIO · Registry              │
│ 시크릿: OpenBao (KV v2 · dev=파일 백엔드, prod=KMS auto-unseal)   │
│ 부팅 시크릿: SOPS + age (git 커밋 가능)                           │
└───────────────────────────────────────────────────────────────────┘
                              ↕ API Push · Pull (온프렘)
┌─ 데이터 플레인 ───────────────────────────────────────────────────┐
│ AWS ECS Fargate (native blue/green · IR canary → CANARY_10PCT_5M) │
│ GCP Cloud Run (traffic split) [본선]                              │
│ Azure Container Apps (revision) [본선]                            │
│ 온프레미스: Docker Compose (헬스 게이트 블루그린 스왑)            │
│            + Cloudflare Tunnel 사이드카 (Traefik 라벨 스와핑)     │
│ Executor 인터페이스 (Fake/Real/SSH) 로 어댑터 통일                │
└───────────────────────────────────────────────────────────────────┘
                              ↕ OTel Collector 사이드카 자동 주입
┌─ 관측 · 피드백 ───────────────────────────────────────────────────┐
│ Grafana + Prometheus + Loki + Pyroscope (본선: + Tempo · Mimir)   │
│ Cost 대시보드: pricing-catalog + AI usage · Kubecost 스타일       │
│ Incident 대시보드: post-mortem 3-part 카드                        │
└───────────────────────────────────────────────────────────────────┘
                              ↕ Cloud APIs · OIDC 페더레이션
┌─ 인프라 상태 · 자격증명 ──────────────────────────────────────────┐
│ Terraform (D-2까지) → OpenTofu (본선)                             │
│ Backend: S3 + use_lockfile=true + Object Lock + SSE-KMS           │
│ (DynamoDB 제거)                                                   │
│ 클라우드 자격증명: OIDC 페더레이션 (AWS AssumeRoleWithWebIdentity,│
│   GCP WIF, Azure WIF, 온프렘 AppRole) · 장기 키 저장 0            │
└───────────────────────────────────────────────────────────────────┘
```

---

## 15. 우선순위 로드맵 (4 buckets)

### Bucket 1 · **D-1 오늘~내일** (심사 근거 즉시 강화)

| # | 작업 | 시간 | 담당 후보 |
|---|---|---:|---|
| B1-1 | Terraform S3 backend + `use_lockfile=true` + KMS 마이그레이션 | 4h | 인프라 |
| B1-2 | Anthropic prompt caching 헤더 삽입 (system · tools · IR schema 세그먼트) | 1h | 백엔드 |
| B1-3 | AI 파일 릴레이 시크릿 · MCP tool 스키마에서 `get_env` 제거, `set_env` 는 값 받되 응답에는 path 만 | 4h | 백엔드 |
| B1-4 | 온프레미스 헬스 게이트 블루그린 스왑 (`packages/adapters/onprem`) | 4h | 인프라 |

### Bucket 2 · **D-2 ~ D-3** (완성도 확보)

| # | 작업 | 시간 | 담당 후보 |
|---|---|---:|---|
| B2-1 | OpenBao 컨테이너 (파일 백엔드) `deploy/control-plane/docker-compose.yml` 추가, `apps/lib/src/credentials.ts` 교체 | 8h | 백엔드 |
| B2-2 | AWS ECS native blue/green 어댑터 매핑 (`packages/adapters/aws/terraform/*`) | 8h | 인프라 |
| B2-3 | MCP 서버 + `llms.txt` (top-level, `apps/mcp/*` 신규) | 8h | 프론트/AI |
| B2-4 | Slack 인터랙티브 승인 엔드포인트 (`POST /slack/interactions`) | 4h | 백엔드 |
| B2-5 | CLI 승인 TTY 프롬프트 (`softbank deploy` SSE watch) | 4h | 프론트 |

### Bucket 3 · **D-3 ~ D-4** (관측 · 데모 폴리시)

| # | 작업 | 시간 | 담당 후보 |
|---|---|---:|---|
| B3-1 | Grafana + Prometheus + Loki + Pyroscope 4컨테이너 추가 | 4h | 인프라 |
| B3-2 | OTel Collector 사이드카 (IR `expose.otel` default true) | 8h | 인프라 |
| B3-3 | Loki forward 어댑터 (CloudWatch/Cloud Logging → Loki) | 8h | 백엔드 |
| B3-4 | AI 응답 hint 필드 · CLI hint 렌더링 | 2h | 프론트 |
| B3-5 | 오케스트레이터 활성/대기 리더 선출 (advisory lock) | 4h | 백엔드 |
| B3-6 | 부팅 시 1회 자동 재개 정책 (`resume_attempts` 컬럼) | 2h | 백엔드 |

### Bucket 4 · **본선 (10/26 결과 뒤 · 11/7 전)**

| # | 작업 | 시간 | 담당 후보 |
|---|---|---:|---|
| B4-1 | OpenTofu 전환 (Terraform binary 교체 + state encryption 활성) | 8h | 인프라 |
| B4-2 | OIDC 페더레이션 (AWS AssumeRoleWithWebIdentity · OpenBao 내장 IdP) | 8h | 보안 |
| B4-3 | Tempo + Mimir 추가 (트레이스 · 메트릭 확장) | 4h | 관측 |
| B4-4 | GCP Cloud Run 어댑터 실 구현 (T-5) | 16h | 인프라 |
| B4-5 | GitHub Actions CI · 자동 배포 (T-9) | 8h | DevOps |
| B4-6 | `packages/repository/*` 얇은 리포지토리 (워커 SQL 흩어짐 정리) | 16h | 백엔드 |
| B4-7 | 프론트 대형 페이지 카드 분리 (REFACTOR_AUDIT C-5/6/8) | 16h | 프론트 |

---

## 16. 참고 자료 (2026-09-29 웹서치 · 기존 문서)

### 16-1. Terraform S3 native locking

- [Backend Type: s3 | Terraform | HashiCorp Developer](https://developer.hashicorp.com/terraform/language/backend/s3) — `use_lockfile` 공식 문서.
- [How to Migrate to S3 Native State Locking in Terraform · freeCodeCamp](https://www.freecodecamp.org/news/how-to-migrate-to-s3-native-state-locking-in-terraform/)
- [Goodbye DynamoDB — Terraform S3 Backend Now Supports Native Locking](https://rafaelmedeiros94.medium.com/goodbye-dynamodb-terraform-s3-backend-now-supports-native-locking-06f74037ad39)
- [Introduce S3-native state locking · PR #35661](https://github.com/hashicorp/terraform/pull/35661)
- [Switching to the Terraform S3 Backend with Native State File Locks](https://bacchi.org/posts/terraform-s3-backend-native-state-locks/)

### 16-2. OpenTofu vs Terraform 2026

- [OpenTofu vs Terraform in 2026: License, Features, and Migration · Encore](https://encore.dev/articles/opentofu-vs-terraform-2026)
- [OpenTofu vs Terraform: Which One Should You Use in 2026? · Scalr](https://scalr.com/learning-center/opentofu-vs-terraform)
- [OpenTofu vs Terraform in 2026: The Fork Has Matured · TurboGeek](https://www.turbogeek.co.uk/opentofu-vs-terraform-2026/)
- 요점: OpenTofu 1.7+ 는 state · plan 파일 클라이언트 사이드 AES-GCM 암호화 · KMS pluggable (AWS/GCP/Azure/OpenBao/PBKDF2). MPL 2.0 · LF governance.

### 16-3. Postgres 큐 라이브러리 비교

- [Redis-backed vs Postgres-backed self-hosted job queues for small teams (2026) · agentfromzero/research-brief-sample](https://github.com/agentfromzero/research-brief-sample)
- [PostgreSQL Job Queue Benchmarking · hardbyte](https://github.com/hardbyte/postgresql-job-queue-benchmarking)
- [I Removed Redis From My Stack and Used PostgreSQL for Job Queues Instead · DEV](https://dev.to/aws-builders/i-removed-redis-from-my-stack-and-used-postgresql-for-job-queues-instead-2lp5)
- 요점: River (Go) 는 chaos 회복 강함. graphile-worker 는 ~200 jobs/s. pg-boss 는 JS-centric convenience, 우리 실측 부하 커버.

### 16-4. Cloudflare Tunnel alternatives

- [Top 10 Cloudflare Tunnel Alternatives in 2026 · Pinggy Blog](https://pinggy.io/blog/best_cloudflare_tunnel_alternatives/)
- [Funnels vs. Tunnels: Rethinking ngrok, Tailscale, and Cloudflare](https://instatunnel.substack.com/p/funnels-vs-tunnels-rethinking-ngrok)
- [I tried switching from Cloudflare Tunnels to Tailscale, and I hated it · XDA](https://www.xda-developers.com/switching-from-cloudflare-tunnels-tailscale-hated-it/)
- 요점: Tailscale Funnel 은 여전히 베타, 공개 노출 유연성 낮음. Cloudflare Tunnel outbound-only 아키텍처가 방화벽/NAT 뒤에도 표준.

### 16-5. OpenBao 2.6 / Vault fork

- [OpenBao Official Site](https://openbao.org/)
- [OpenBao: Horizontally Scaling Secrets Management · OSSNA 2026](https://openbao.org/blog/cipherboy-ossna-26-talk/)
- [Beyond HashiCorp Vault: OpenBao and Other Alternatives · OpenLogic](https://www.openlogic.com/blog/hashicorp-vault-alternatives-openbao-vs-vault)
- [Open Source Secrets Management for DevOps in 2026 · Infisical](https://infisical.com/blog/open-source-secrets-management-devops)
- 요점: OpenBao 2.6, LF governance, MPL 2.0, 외부 pluggable KMS interface, namespaces GA.

### 16-6. AWS ECS native blue/green (2025-10 GA)

- [Choosing between Amazon ECS blue/green native or AWS CodeDeploy in AWS CDK · AWS DevOps Blog](https://aws.amazon.com/blogs/devops/choosing-between-amazon-ecs-blue-green-native-or-aws-codedeploy-in-aws-cdk)
- [Mastering AWS ECS Fargate (Part 2): Zero-Downtime Blue-Green](https://medium.com/@jimmywcho/mastering-aws-ecs-fargate-part-2-achieving-zero-downtime-with-blue-green-deployment-b2f2a04f7758)
- [Migrating from AWS CodeDeploy to Amazon ECS for Blue/Green Deployments · DEV](https://dev.to/manishpcp/migrating-from-aws-codedeploy-to-amazon-ecs-for-bluegreen-deployments-a-comprehensive-migration-1p58)
- 요점: 2025-07 GA (all-at-once/linear/canary 는 2025-10 feature parity). CodeDeploy 종속 제거 가능. Terraform 프로바이더는 이미 반영.

### 16-7. Anthropic prompt caching

- [Prompt caching · Claude Platform Docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Lessons from building Claude Code: Prompt caching is everything · Anthropic](https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything)
- [Anthropic Prompt Caching Guide 2025: Reduce Claude API Costs 90% · Prismix](https://prismix.dev/guides/anthropic-prompt-caching-guide)
- 요점: 캐시 히트 시 90% 저렴 · TTFT 수초→수백ms. Tools는 prefix 일부, 안정성 중요. 4개 breakpoints max.

### 16-8. MCP 서버 (Vercel · Fly.io)

- [vercel mcp · Vercel Docs](https://vercel.com/docs/cli/mcp)
- [flymcp: MCP server for Fly.io CLI · superfly/flymcp](https://github.com/superfly/flymcp)
- [Fly MCP Integration with Claude Code · Composio](https://composio.dev/toolkits/fly/framework/claude-code)
- 요점: 배포 도구가 MCP 로 자기 자신을 노출하는 패턴 이미 표준. Claude Code · Cursor · Windsurf 모두 소비. "AI 가 우리 시스템에 배포" 데모 무리 없음.

### 16-9. External Secrets vs Vault vs Infisical (self-hosted PaaS)

- [ESO vs Vault vs Infisical: the Secrets Backend a Self-Hosted PaaS Should Actually Wire In · bex.co](https://bex.co/blog/2026/09/24/eso-vault-infisical-secrets-backend-paas)
- 요점: 우리처럼 자체 호스팅 PaaS 성격은 Vault/OpenBao 가 정답 (multi-tenant, envelope encryption, dynamic secrets).

### 16-A. 프로젝트 내부 문서

- `docs/architecture.md` v4 · `docs/decisions.md` D-01~D-34 · `docs/DEPLOYMENT_SPEC_TRADEOFF.md` (Analyzer 3단계 · Terraform 자동/수동 정정) · `docs/LANGUAGE_TRADEOFFS.md` (Case 1~4 · Case 2 로 확정) · `docs/REFACTOR_AUDIT.md` (Phase 0/1/2 로드맵) · `docs/handoff.md` (검증된 e2e 5종) · `docs/이전 개발 경험.md` (조서현 §경험 1~4).

---

## 17. 열린 질문 · 다음 세션에서 결정

1. **B1-1 S3 backend 마이그레이션 창** — 진행 중 배포가 있으면 어떻게 이전할지. 제안: 모두 destroy → 재배포 시 새 backend 로.
2. **B2-3 MCP 서버 인증** — Anthropic Claude Code MCP 는 stdio · HTTP 지원. 우리는 어느 트랜스포트? 제안: stdio (로컬 CLI 통합) + HTTP (원격 Claude Code 통합) 둘 다.
3. **B3-1 Grafana 데이터 소스 로그인** — 심사 시연 시 Grafana 계정 만들지 vs 이메일 링크 iframe 로 던질지. 제안: 앱 auth-proxy 뒤에 두고 앱 세션 재활용.
4. **B2-4 Slack 인터랙티브 승인 URL** — Cloudflare Tunnel 통해 외부에서 Slack 이 접근할 URL 필요. 데모 서버가 Slack workspace 등록되어 있어야 하는데 새로 만들 여유 있는지.
5. **B4-2 OIDC IdP endpoint 도메인** — OpenBao 내장 OIDC 는 `https://openbao/.well-known/openid-configuration` 노출. 컨트롤 플레인에 도메인 · TLS 필요.
6. **관측 스택의 저장소 크기** — Loki/Prometheus 스토리지 데모 시 얼마나 잡을지. 제안: 24h 리텐션 · MinIO 백엔드.
7. **비용** — Anthropic API 비용은 ₩300K 예산 포함 여부 미확인 (`docs/hackathon.md` §10 열린 질문 재확인 필요).

---

## 18. 이 문서의 정확성 자가 감사

- **정확한 것**: 파일 경로 · LOC · 결정 D 번호 · 웹서치 인용은 URL 실존 확인. 검증된 e2e 5종은 `docs/handoff.md` §0.
- **불확실한 것** (검증 필요):
  - "상대점수 6/10 → 9/10" 은 정성 추정, 실측 없음.
  - "AWS ECS native blue/green 어댑터 매핑 8h" 는 프로바이더 스키마 확인 안 함, 실제 필드가 preview 일 수 있음.
  - "prompt caching 헤더 1h" 는 `apps/agent/src/anthropic.ts` 실제 코드 안 봄. `@anthropic-ai/sdk` 0.30 이 `cache_control` 지원하는지 재확인 필요.
  - "OpenBao 파일 백엔드 auto-unseal transit self-seal" 은 문서 상 가능하나 실 구성 예시 미확인.
- **비어 있는 것** (조사 안 함):
  - Grafana LGTM 4 컨테이너 부팅 시간 실측.
  - MCP HTTP 트랜스포트 auth 흐름.
  - Slack 인터랙티브 endpoint 시그니처 검증.

---

**End of `docs/ARCHITECTURE_IMPROVEMENTS_v1.md`.** 다음 세션에서 결정: 이 문서의 §15 로드맵 중 어느 Bucket 부터 착수할지, §17 열린 질문 어떻게 좁힐지.
