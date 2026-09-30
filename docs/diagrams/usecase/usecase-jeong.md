# 이정 담당 Use Case Diagram — 소스 분석 · IR 생성

> 담당 범위: 소스 업로드부터 IR 생성·편집·승인까지의 전 단계. 분석 파이프라인의 진입점이며 후속 빌드·프로비저닝 단계의 입력을 생성한다.

---

## Use Case Diagram

```mermaid
graph TB
  Dev[개발자]
  Claude["Anthropic Claude\n(LLM API)"]
  Orchestrator["오케스트레이터\n(API 서버)"]
  Worker["통합 워커\n(job_type: analyze)"]
  DB[(Postgres)]
  Storage[("오브젝트 스토리지\n(MinIO/S3)")]

  subgraph Jeong ["이정 담당 — 소스 분석 · IR 생성"]
    direction TB

    subgraph SRC ["1. 소스 관리 (SRC)"]
      UC01["SRC-01\n프로젝트 생성"]
      UC02["SRC-02\n소스 zip 업로드\n+ 배포 생성"]
      UC03["SRC-04\n소스 버전 관리\n(sha256 부여)"]
      UC04["SRC-05\n모노레포 인식\n(서비스 폴더 분리)"]
    end

    subgraph ANL ["2. 스택 분석 (ANL)"]
      UC05["ANL-01\n언어·프레임워크 감지\n(Node/Rails/Spring/SPA)"]
      UC06["ANL-02\n런타임 정보 추출\n(포트·명령·버전)"]
      UC07["ANL-03\n의존 리소스 감지\n(DB·Redis·파일 저장)"]
      UC08["ANL-04\n환경변수·비밀값 탐지\n(하드코딩 경고)"]
      UC09["ANL-05\n서비스 구조 파악\n(모놀리스/MSA 구분)"]
      UC10["ANL-06\n운영 위험 진단\n(클라우드 깨질 요소)"]
      UC11["ANL-07\n분석 결과 리포트 조회"]
      UC12["ANL-08\n분석 결과 캐시\n(동일 sha256 재사용)"]
    end

    subgraph IR ["3. IR 생성·편집 (IR)"]
      UC13["IR-01\nIR 자동 생성\n(IrSchema.parse 통과)"]
      UC14["IR-02\nIR 스키마 검증\n(Zod, 400 에러)"]
      UC15["IR-03\nIR 수동 편집\n(웹 에디터)"]
      UC16["IR-04\n환경별 오버라이드\n(ECS taskRoleArn 등)"]
      UC17["IR-05\nIR 버전 관리\n(배포마다 ir_version_id)"]
    end

    subgraph AGT ["4. AI 에이전트·빈칸 채우기 (AGT/ANL)"]
      UC18["AGT-AI\nAI 빈칸 채우기\n(unknown 필드만 tool_use)"]
      UC19["AGT-04\n가드레일\n(requires_approval 강제)"]
    end

    subgraph GATE ["5. 승인 게이트"]
      UC20["GATE-1\n빠진 요소 결정\n(확장 모듈 추가/제외)"]
      UC21["GATE-2\ntarget 승인\n(프로필·빠진 요소 확정)"]
    end

    subgraph SECRET ["6. 시크릿 관리 (DAT)"]
      UC22["DAT-02\n시크릿 저장\n(AES-GCM 암호화)"]
      UC23["DAT-02\n시크릿 목록 조회\n(이름만, 값 없음)"]
      UC24["DAT-02\n시크릿 삭제"]
    end

    subgraph MOD ["7. 확장 모듈 카탈로그"]
      UC25["MOD-01\n확장 모듈 카탈로그 조회\n(redis-elasticache, postgres-rds)"]
    end

    subgraph DIAG ["8. AI 실패 진단 (FIX)"]
      UC26["FIX-01\n실패 원인 진단\n(AI 로그 분석)"]
      UC27["FIX-02\n수정안 제시\n(patch_candidates diff)"]
      UC28["FIX-03\n승인 후 재시도\n(최대 3회)"]
      UC29["CST-01\nAI 사용량 기록\n(토큰·비용 조회)"]
    end
  end

  %% 개발자 액션
  Dev --> UC01
  Dev --> UC02
  Dev --> UC15
  Dev --> UC20
  Dev --> UC21
  Dev --> UC22
  Dev --> UC23
  Dev --> UC24
  Dev --> UC25
  Dev --> UC11
  Dev --> UC26

  %% 자동 파이프라인 흐름
  UC02 -.->|"analyze job 생성\n(한 트랜잭션)"| UC03
  UC02 -.-> UC04
  UC03 -.->|"캐시 미스 시"| UC05
  UC04 -.-> UC05
  UC05 -.-> UC06
  UC05 -.-> UC07
  UC05 -.-> UC08
  UC05 -.-> UC09
  UC09 -.-> UC10
  UC06 -.-> UC13
  UC07 -.-> UC13
  UC08 -.-> UC13
  UC13 -.-> UC14
  UC14 -.-> UC18
  UC18 -.-> UC11
  UC11 -.-> UC20
  UC20 -.-> UC21
  UC21 -.->|"env_lock 획득"| Orchestrator

  %% AI 호출
  UC18 -.->|"tool_use\n(키 이름만, 값 미전송)"| Claude

  %% 캐시 경로
  UC12 -.->|"동일 sha256\nAI 재호출 없음"| UC13

  %% 실패 경로
  UC26 -.->|"로그 꼬리 분석\n시크릿 제외"| Claude
  UC26 -.-> UC27
  UC27 -.-> UC28

  %% 저장소
  UC02 -.-> Storage
  UC13 -.-> DB
  UC17 -.-> DB
  UC22 -.-> DB
  UC29 -.-> DB
```

---

## 코드 매핑 표

| Use Case | 기능 ID | 파일 위치 | 담당 API |
|---|---|---|---|
| 프로젝트 생성 | SRC-01 | `apps/api/src/routes/` | `POST /api/v1/projects` (API-02) |
| 소스 zip 업로드 + 배포 생성 | SRC-02 | `apps/api/src/routes/` | `POST /api/v1/deployments` (API-05) |
| 소스 버전 관리 (sha256) | SRC-04 | `apps/api/src/routes/` | `POST /api/v1/deployments` (API-05 내부) |
| 모노레포 인식 | SRC-05 | `packages/analyzer/src/service-splitter.ts` | `GET /deployments/:id/analysis-report` (API-19) |
| 언어·프레임워크 감지 | ANL-01 | `packages/analyzer/src/detectors/nodejs.ts`, `python.ts`, `rails.ts` | 워커 내부 |
| 런타임 정보 추출 | ANL-02 | `packages/analyzer/src/detectors/` | 워커 내부 |
| 의존 리소스 감지 | ANL-03 | `packages/analyzer/src/detectors/` | 워커 내부 |
| 환경변수·비밀값 탐지 | ANL-04 | `packages/analyzer/src/detectors/` | 워커 내부 |
| 서비스 구조 파악 | ANL-05 | `packages/analyzer/src/service-splitter.ts` | 워커 내부 |
| 운영 위험 진단 | ANL-06 | `packages/analyzer/src/` | 워커 내부 |
| 분석 결과 리포트 조회 | ANL-07 | `apps/api/src/routes/` | `GET /deployments/:id/analysis-report` (API-19) |
| 분석 결과 캐시 | ANL-08 | `packages/analyzer/src/index.ts` | 워커 내부 (sha256 비교) |
| IR 자동 생성 | IR-01 | `packages/ir-schema/src/index.ts` | `GET /deployments/:id/ir` (API-08) |
| IR 스키마 검증 | IR-02 | `packages/ir-schema/src/index.ts` (IrSchema.parse) | `GET /deployments/:id/ir` (API-08) |
| IR 수동 편집 | IR-03 | `apps/api/src/routes/` | `PATCH /deployments/:id/ir` (API-09) |
| 환경별 오버라이드 | IR-04 | `packages/ir-schema/src/index.ts` | `PATCH /deployments/:id/ir` (API-09) |
| IR 버전 관리 | IR-05 | `apps/api/src/routes/` | `PATCH /deployments/:id/ir` (API-09) |
| AI 빈칸 채우기 | AGT/ANL | `packages/analyzer/src/ai-filler.ts` | 워커 내부 |
| 가드레일 | AGT-04 | `apps/api/src/routes/` | `POST /deployments/:id/approvals` (API-11) |
| 빠진 요소 결정 | IR/PRV | `apps/api/src/routes/` | `POST /deployments/:id/missing-resources` (API-10) |
| target 승인 | DEP/LCK | `apps/api/src/routes/` | `POST /deployments/:id/approvals` (API-11, gate=target) |
| 시크릿 저장 | DAT-02 | `apps/api/src/routes/` | `POST /api/v1/secrets` (API-28) |
| 시크릿 목록 조회 | DAT-02 | `apps/api/src/routes/` | `GET /api/v1/secrets` (API-29) |
| 시크릿 삭제 | DAT-02 | `apps/api/src/routes/` | `DELETE /api/v1/secrets/:name` (API-30) |
| 확장 모듈 카탈로그 조회 | REC | `apps/api/src/routes/` | `GET /api/v1/modules` (API-27) |
| 실패 원인 진단 | FIX-01 | `apps/api/src/routes/` | `GET /deployments/:id/diagnosis` (API-36) |
| 수정안 제시 | FIX-02 | `apps/api/src/routes/` | `GET /deployments/:id/diagnosis` (API-36, patchCandidates) |
| 승인 후 재시도 | FIX-03 | `apps/api/src/routes/` | `POST /deployments/:id/rollback` (API-13) |
| AI 사용량 기록 | CST-01 | `apps/api/src/routes/` | `GET /deployments/:id/ai-usage` (API-32) |

---

## 관련 API 엔드포인트 요약

| 우선순위 | 메서드 | 경로 | 설명 |
|---|---|---|---|
| P0 | POST | `/api/v1/projects` | 프로젝트 생성 |
| P0 | POST | `/api/v1/deployments` | 소스 업로드 + 배포 생성 (multipart) |
| P0 | GET | `/api/v1/deployments/:id/ir` | IR 조회 |
| P0 | POST | `/api/v1/deployments/:id/missing-resources` | 빠진 요소 결정 |
| P0 | POST | `/api/v1/deployments/:id/approvals` | 승인 게이트 (target/plan) |
| P0 | GET | `/api/v1/deployments/:id/analysis-report` | 분석 리포트 조회 |
| P1 | PATCH | `/api/v1/deployments/:id/ir` | IR 수동 편집 |
| P1 | GET | `/api/v1/modules` | 확장 모듈 카탈로그 |
| P1 | POST | `/api/v1/secrets` | 시크릿 저장 |
| P1 | GET | `/api/v1/secrets` | 시크릿 목록 조회 |
| P1 | DELETE | `/api/v1/secrets/:name` | 시크릿 삭제 |
| P1 | GET | `/api/v1/deployments/:id/diagnosis` | AI 실패 진단 |
| P1 | GET | `/api/v1/deployments/:id/ai-usage` | AI 토큰·비용 조회 |
