# 팀 인계 문서 — camellia team (2026-09-30 기준)

이정 담당 파트(분석 · IR · API · 워커) 개발이 1차 정리된 시점에서, 팀원(은영 · 민서 · 민성)에게 넘겨줄 문서 · 자산 · 인터페이스 모음. **각자 담당 파트에 필요한 것만 골라 보시면 됩니다.**

---

## 1. 지금까지 확보된 것 (2026-09-30 14:39 KST)

- **P0 파이프라인 구현 완료**: 분석기(규칙+AI) → IR → API 서버 → 워커 큐 → DB
- **e2e 통합 검증**: 4 fixture(Express · FastAPI · Node+Postgres · MSA)에서 실 zip → 실 Claude API → 실 IR까지 100% 통과
- **GitHub 이슈 11개 / PR 12개** (전부 머지 완료)
- **로컬 실행 가능**: docker + Postgres + API + Worker + 실 Claude API 호출

## 2. 담당자별 필독 3종

### 은영님 (어댑터 · 빌드 · 프로비저닝 · 배포)

**핵심 인터페이스**:
- IR: `packages/ir-schema/src/schema.ts` — 이걸 받아 프로필로 매핑
- 프로필 카탈로그: `packages/profiles/src/{aws-ecs-basic,onprem-docker-basic}.ts`
- 매처: `packages/profile-matcher/src/index.ts` — IR ↔ 프로필 검증
- 잡 핸들러 stub: `apps/worker/src/handlers/{build,provision}.ts` — TODO 표시된 곳 채우면 됨

**읽어야 할 문서**:
- `docs/ir-spec-for-team.md` — IR 필드별 의미·매핑 가이드
- `docs/integration-guide.md` — 파이프라인 전체 흐름 (§ 어댑터·프로비저닝 절)
- `docs/diagrams/usecase/usecase-eunyoung.md` — 담당 파트 유즈케이스
- `docs/decisions.md` — 특히 D-35 · D-52 · D-53

**시작하기**:
```ts
// apps/worker/src/handlers/provision.ts
import { stateMachine } from "../state-machine.js";

export async function provisionHandler(job: PgBoss.Job<ProvisionInput>) {
  await stateMachine.transition(job.data.deployment_id, "provisioning");
  // Terraform apply 로직 여기에 채우면 됩니다.
  // IR은 job.data.ir로 접근. 프로필은 job.data.target_profile.
  await stateMachine.transition(job.data.deployment_id, "provisioned");
}
```

---

### 민서님 (검증 · 롤아웃)

**핵심 인터페이스**:
- verify 핸들러 stub: `apps/worker/src/handlers/verify.ts`
- 상태 머신: `apps/worker/src/state-machine.ts` — 16 상태 + 유효 전이표
- 헬스체크 결과 저장: `packages/db/src/schema.ts` → `deployment_steps` 테이블
- API 로그 조회: `GET /api/v1/deployments/:id/logs?step=verify` (구현 완료)

**읽어야 할 문서**:
- `docs/ir-spec-for-team.md` — 검증 대상 (services/healthcheck 필드)
- `docs/integration-guide.md` (§ 검증·롤아웃 절)
- `docs/diagrams/usecase/usecase-minseo.md`

**시작하기**:
```ts
// apps/worker/src/handlers/verify.ts
export async function verifyHandler(job: PgBoss.Job<VerifyInput>) {
  await stateMachine.transition(job.data.deployment_id, "verifying");
  // 3회 연속 헬스체크 통과 대기 로직.
  // deployment_steps.message에 로그 append 하면 GET /logs에서 조회됨.
  await stateMachine.transition(job.data.deployment_id, "verified");
}
```

---

### 민성님 (프론트)

**핵심 계약** (필독):
- **`docs/api-spec-v1.md`** — 48 API 전체 명세 (요청·응답·에러 코드 다 있음)
- **`docs/functional-spec-v3.md`** — 화면·플로우 명세
- `apps/api/tests/server.test.ts` — 실제 요청/응답 예시 (Copy&paste 가능)

**API Base URL**: `http://localhost:3000/api/v1`
**Health check**: `GET http://localhost:3000/health`

**이정 담당 P0 엔드포인트 12개** (구현 완료 · 다 붙일 수 있음):
```
POST /projects                                # 프로젝트 생성
GET  /projects                                # 리스트
GET  /projects/:id                            # 상세
POST /deployments                             # 배포 생성 (multipart zip 업로드)
GET  /deployments/:id                         # 배포 조회
GET  /deployments/:id/events (SSE)            # 실시간 상태 스트림
GET  /deployments/:id/ir                      # IR 조회
PATCH /deployments/:id/ir                     # IR 편집 (낙관적 락)
POST /deployments/:id/missing-resources       # 빠진 요소 결정 제출
POST /deployments/:id/approvals/:gate         # 승인/거부 (env_lock)
GET  /deployments/:id/logs?step&tail          # 단계별 로그
GET  /deployments/:id/analysis-report         # 분석 리포트
```

**SSE 사용법**:
```ts
const es = new EventSource(`/api/v1/deployments/${id}/events`);
es.addEventListener('state_changed', (e) => {
  const data = JSON.parse(e.data);
  updateUi(data);
});
```

**읽어야 할 문서**:
- `docs/diagrams/usecase/usecase-minseong.md` — 프론트 유즈케이스
- `docs/integration-guide.md` (§ 프론트 통합 절)

---

## 3. 핵심 파일 지도

```
Auto-Deployment-System/
├── packages/
│   ├── ir-schema/          # IR Zod 스키마 (계약)
│   ├── analyzer/           # 소스 zip → IR (규칙 + AI)
│   ├── profiles/           # 인프라 프로필 카탈로그 (aws-ecs, onprem-docker)
│   ├── profile-matcher/    # IR ↔ 프로필 매칭
│   ├── storage/            # 로컬 fs 오브젝트 스토리지
│   └── db/                 # Postgres 스키마 · migration · pg-boss init
├── apps/
│   ├── api/                # Fastify API 서버 (12 P0 엔드포인트)
│   └── worker/             # pg-boss 컨슈머 (analyze 실 · build/provision/verify TODO)
├── tests/e2e/              # 통합 테스트 (upload-to-ir · samples · measure)
├── docs/
│   ├── team-handoff-2026-09-30.md      # 이 문서
│   ├── ir-spec-for-team.md             # 팀원 전달 IR 상세
│   ├── integration-guide.md            # 파이프라인 통합 가이드
│   ├── api-spec-v1.md                  # API 48 엔드포인트
│   ├── functional-spec-v3.md           # 기능 명세
│   ├── ir-schema-v0.md                 # IR 스키마 요약
│   ├── decisions.md                    # D-01 ~ D-53 결정 로그
│   ├── open-items.md                   # 미결·리스크
│   ├── final-report-2026-09-30.md      # 최종 종합 보고서
│   ├── ir_measurement-2026-09-30.md    # 실 API 측정
│   └── diagrams/usecase/               # 담당자별 유즈케이스 mermaid
├── docker-compose.yml                   # Postgres 16-alpine (5433 포트)
├── package.json                         # pnpm scripts (db:up, db:migrate, dev, test:e2e)
└── .env.example                         # 로컬 환경변수 예시
```

## 4. 로컬 세팅 (5분)

**전제**: Docker Desktop · pnpm(v9+) · Node 20+ 설치

```bash
git clone https://github.com/2026-Softbank-hackerton/Auto-Deployment-System.git
cd Auto-Deployment-System
pnpm install
cp .env.example .env    # DATABASE_URL 등 확인

pnpm db:up              # Postgres 5433 컨테이너 시작
pnpm db:migrate         # 스키마 초기화

pnpm dev                # api + worker 병렬 실행 (기본 API 3000 포트)
```

**AI 보강 계층 활성화 (선택)**:
```bash
# credentials/credentials.env (gitignore)
echo "ANTHROPIC_API_KEY=sk-ant-..." >> credentials/credentials.env
echo "ANTHROPIC_MODEL=claude-sonnet-4-6" >> credentials/credentials.env

set -a && source credentials/credentials.env && set +a
pnpm test:e2e           # measure 포함 실 API 호출 (~$0.05)
```

**API 없이도 규칙만으로 파이프라인 진행됩니다** (fallback 유지).

## 5. 검증 상태 (2026-09-30 14:39 KST)

| 항목 | 결과 |
|---|---|
| 단위 테스트 | **172개 통과** (ir-schema 16 + storage 9 + db 29 + profiles 11 + profile-matcher 14 + analyzer 61 + api 16 + worker 16) |
| e2e 통합 (upload-to-ir) | 4/4 통과 (3.6s) |
| e2e 통합 (samples 4 fixture) | 8/8 통과 (15.6s) |
| **e2e 실 Claude API** | **4/4 통과 (25.1s, ~$0.05)** |
| typecheck (전체 workspace) | 통과 |
| lint (전체 workspace) | 통과 (경고 있음, 오류 없음) |

**측정 상세**: `docs/ir_measurement-2026-09-30.md`

## 6. 결정 로그 핵심 (`docs/decisions.md` D-01~D-53 중)

| 결정 | 내용 |
|---|---|
| D-35 | IR = 앱 요구사항만 (환경 무관, 프로파일에서 인프라 결정) |
| D-46 | 원클릭 원칙 — 노출 기본 public + HTTPS |
| D-50 | Claude에 소스 보낼 때 시크릿 5종 자동 마스킹 |
| D-52 | 백엔드 = TypeScript + Fastify + Zod + pg-boss (Elysia·NestJS 검토 결과) |
| D-53 | 실행 모델 = ECS Fargate (Lambda 하이브리드 폐기 — 15분 리밋·상태 유지 문제) |

## 7. 이슈 · PR 현황

| 이슈 | 제목 | PR | 상태 |
|---|---|---|---|
| #1 | 설계 문서·결정 기록 확정 | #13 | ✅ 머지 |
| #2 | IR Zod 스키마 | #11 | ✅ 머지 |
| #3 | DB 스키마·pg-boss·docker-compose | #14 | ✅ 머지 |
| #4 | 업로드·아티팩트 저장소 | #12 | ✅ 머지 |
| #5 | 인프라 프로필·매처 | #15 | ✅ 머지 |
| #6 | 규칙 기반 분석기 | #16 | ✅ 머지 |
| #7 | 분석기 AI 보강 계층 | #17 | ✅ 머지 |
| #8 | 백엔드 API 서버 | #18 | ✅ 머지 |
| #9 | 백엔드 워커 · 상태 머신 | #19 | ✅ 머지 |
| #20 | API-12/API-19 후속 | #21 | ✅ 머지 |
| #10 | e2e·측정·다이어그램·IR 팀 명세 | #22 | ✅ 머지 |

## 8. 팀원 시작 순서 (권장)

1. **이 문서 훑기** (15분)
2. **자기 담당 유즈케이스 다이어그램 열기** (`docs/diagrams/usecase/usecase-{자기}.md`)
3. **`docs/integration-guide.md`에서 자기 파트 위치 확인** (10분)
4. **관련 코드 폴더로 이동** — TODO stub 채우거나 신규 파일 추가
5. **로컬 세팅** → 파이프라인 돌려보고 자기 코드 동작 확인
6. **막히면**: 노션·슬랙 또는 이 리포지토리 이슈 코멘트

## 9. 미결 · 리스크

- **AWS 계정 방식 vs PaaS 방식**: 운영진 답변 대기 중 (`docs/paas-vs-user-account.md`)
- **Terraform 실 프로비저닝**: 은영님 담당, TODO stub 상태
- **verify 헬스체크 로직**: 민서님 담당, TODO stub 상태
- **프론트**: 민성님 담당, 백엔드 API 준비 완료
- 상세: `docs/open-items.md`

## 10. 참고

- 노션 워크스페이스: 기능 명세 DB · API 명세 DB · 결정 로그 미러링 (`docs/notion-links.md`)
- 킥오프 자료: `docs/reference/`
- 팀 회의록: `docs/meetings/`
- 최종 종합 보고서: `docs/final-report-2026-09-30.md`

---

**작성**: 이정 (Pionia5375) · 2026-09-30 KST
**질문·의견**: 리포 이슈 코멘트 또는 팀 슬랙
