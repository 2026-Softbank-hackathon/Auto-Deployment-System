<div align="center">

# 🌺 TEAM Camellia — AI 원클릭 멀티 환경 배포 시스템

SoftBank Hackathon 2026 · team camellia · One Action, Infinite Clouds.

## 👥 Core Team

> 각 구성원의 주 담당 도메인을 기준으로 정리했습니다. 설계·리뷰·통합 작업은 팀 전체가 함께 수행했습니다.

| Contributor | Primary Domain | Key Contributions |
| :---: | --- | --- |
| <a href="https://github.com/Pionia5375"><img src="https://github.com/Pionia5375.png?size=80" width="56" alt="@Pionia5375"/></a><br/><b>이정</b><br/><sub><b>TEAM LEAD</b></sub><br/><sub><a href="https://github.com/Pionia5375">@Pionia5375</a></sub> | **Product · System Architecture · Control Plane** | 제품·시스템 설계와 기술 의사결정, 규칙·AI 분석기와 IR, Fastify API, PostgreSQL Job Queue, 배포 상태 머신·오케스트레이션 |
| <a href="https://github.com/csh1668"><img src="https://github.com/csh1668.png?size=80" width="56" alt="@csh1668"/><br/><sub><b>조서현</b></sub><br/><sub>@csh1668</sub></a> | **Cloud Infrastructure · Platform Operations** | AWS 배포 프로필과 플랫폼 인프라, Terraform 상태·캐시·롤아웃 최적화, 플랫폼 배포·운영 관측 |
| <a href="https://github.com/awj1052"><img src="https://github.com/awj1052.png?size=80" width="56" alt="@awj1052"/><br/><sub><b>안우진</b></sub><br/><sub>@awj1052</sub></a> | **Authentication · API Security** | 운영 환경 API Key 검증, Session·Bearer 인증, 인증 실패 시 차단하는 보안 정책 |
| <a href="https://github.com/gpffh20"><img src="https://github.com/gpffh20.png?size=80" width="56" alt="@gpffh20"/><br/><sub><b>신은영</b></sub><br/><sub>@gpffh20</sub></a> | **Build · Provisioning · Deployment Engine** | IR Adapter, Docker Buildx·ECR 이미지 파이프라인, Terraform ECS 프로비저닝, Cloudflare·Agent Job 연동 |
| <a href="https://github.com/minseong99"><img src="https://github.com/minseong99.png?size=80" width="56" alt="@minseong99"/><br/><sub><b>김민성</b></sub><br/><sub>@minseong99</sub></a> | **Frontend · Product UX** | React Web Console, 프로젝트·배포·환경 전환 UX, 실시간 진행 상태와 결과 화면, 한국어·일본어 지원 |
| <a href="https://github.com/kmsdevdata-sketch"><img src="https://github.com/kmsdevdata-sketch.png?size=80" width="56" alt="@kmsdevdata-sketch"/><br/><sub><b>김민서</b></sub><br/><sub>@kmsdevdata-sketch</sub></a> | **Verification · On-Prem Runtime · Failover** | 후보 Endpoint·최종 URL 검증, On-Prem Agent와 Compose·Tunnel 실행, 복구·정리 정책, 장애 감지·AWS Failover |

</div>

## 1. Overview
사용자가 자신의 앱을 본인의 클라우드, 온프레미스 등의 다양한 환경에 배포하고, 그 사이를 자유롭게 전환하는 배포 시스템
## 2. Architecture
<img width="2303" height="1584" alt="camellia-overview-reference" src="https://github.com/user-attachments/assets/ad93d23c-1fa2-407d-b849-fa3d22a7ed53" />

## 3. Deployment Pipeline
<img width="2048" height="768" alt="deployment_pipeline" src="https://github.com/user-attachments/assets/027781e4-75e2-4960-8090-13770e9057ef" />

## 4. Orchestration & Reliability
> API 서버는 배포 상태를 저장하고 PostgreSQL 기반 Job Queue에 작업을 등록하며, Worker가 각 단계를 순차적으로 실행합니다.
<img width="1672" height="941" alt="Orchestration" src="https://github.com/user-attachments/assets/5f024070-f2dc-449f-8967-065c1c84dd78" />


## 5. Supported Deployment Profiles
>배포 프로필은 **애플리케이션의 실행 특성과 배포 환경의 차이를 처리하기 위한 인프라 구성 템플릿**입니다. 
상시 실행 웹 서비스, 서버리스 웹, 정적 사이트, 온프레미스 배포를 지원하며, 공통 배포 명세(IR)를 각 환경에 필요한 인프라와 실행 설정으로 구체화합니다. 
사용자는 환경별 구성 방식을 직접 다루지 않고도 동일한 흐름으로 배포하고 결과를 검증할 수 있습니다.
<img width="1672" height="941" alt="supported_deployment_profiles" src="https://github.com/user-attachments/assets/37a6ce20-d9f4-4b4b-9e0a-c269156bc3c7" />

## 6. Repository Structure
```text
Auto-Deployment-System/
│
├── apps/
│   ├── web/                    # React 기반 사용자 콘솔
│   │   ├── 배포 요청 및 프로젝트 관리
│   │   ├── AWS·On-Prem 환경 선택 및 전환
│   │   └── 배포 진행 상태·검증 결과 표시
│   │
│   ├── api/                    # Fastify API 서버
│   │   ├── 배포·프로젝트·환경 API
│   │   ├── 상태 저장 및 Job 생성
│   │   └── On-Prem Agent 인증·통신
│   │
│   ├── worker/                 # 비동기 배포 오케스트레이터
│   │   ├── Analyze
│   │   ├── Build
│   │   ├── Provision
│   │   ├── Deploy
│   │   ├── Verify
│   │   ├── Origin 전환·복구
│   │   └── On-Prem 장애 감지·Failover
│   │
│   ├── onprem-agent/           # 사용자 로컬 환경의 배포 에이전트
│   │   ├── Job polling·Heartbeat
│   │   ├── ECR 이미지 Pull
│   │   ├── Docker Compose 실행
│   │   ├── 로컬 헬스체크
│   │   └── Cloudflare Named Tunnel 실행
│   │
│   └── samples/                # 배포·마이그레이션 검증용 예제 앱
│
├── packages/
│   ├── analyzer/               # 규칙 기반 분석 및 AI 보강
│   ├── ir-schema/              # 환경 중립 IR 타입·검증 규칙
│   ├── profile-matcher/        # IR과 배포 프로필 매칭
│   ├── profiles/               # ECS·Lambda·Static·On-Prem 프로필
│   ├── adapters/               # IR → 환경별 배포 계획 변환
│   ├── build-handler/          # 컨테이너 이미지 빌드 처리
│   ├── aws-registry/           # ECR 저장소·이미지 관리
│   ├── cloudflare/             # DNS·CNAME·Tunnel 제어
│   ├── db/                     # PostgreSQL 스키마·마이그레이션
│   ├── contracts/              # API·Job 공유 타입과 Zod 계약
│   └── storage/                # 소스 및 배포 산출물 저장
│
├── infra/
│   ├── terraform/              # 사용자 AWS 인프라 프로비저닝
│   │   ├── VPC
│   │   ├── ECS Fargate
│   │   ├── Lambda
│   │   ├── S3
│   │   ├── ALB
│   │   └── RDS
│   │
│   └── platform/               # Camellia 플랫폼 자체 배포 구성
│
├── tests/
│   └── e2e/                    # 전체 배포 흐름 종단 테스트
│
├── docs/
│   └── design/                 # 시스템·기능 설계 문서
│
└── tools/
    └── diag/                   # 배포 환경 진단 도구
```
## 7. Getting Started

<details>
<summary><strong>로컬 개발 환경 실행 방법 펼쳐보기</strong></summary>
<br />

### Prerequisites

- Node.js 20.19+ 또는 22.12+
- pnpm 9.12+
- Docker Desktop

### 1. Clone and Install

```bash
git clone https://github.com/2026-Softbank-hackerton/Auto-Deployment-System.git
cd Auto-Deployment-System

pnpm install
```

### 2. Configure Environment

```bash
mkdir -p credentials storage
```

`credentials/local.env` 파일을 생성합니다.

```env
DATABASE_URL=postgres://camellia:camellia@localhost:5433/camellia
PORT=3000
STORAGE_ROOT_DIR=/absolute/path/to/Auto-Deployment-System/storage
SECRET_MASTER_KEY=<base64-encoded-32-byte-key>
NODE_ENV=development
LOG_LEVEL=info
```

마스터 키는 다음 명령으로 생성합니다.

```bash
openssl rand -base64 32
```

환경변수를 현재 셸에 적용합니다.

```bash
set -a
source credentials/local.env
set +a
```

> 동일한 `SECRET_MASTER_KEY`를 계속 사용해야 저장된 Secret을 다시 복호화할 수 있습니다.

### 3. Start PostgreSQL

```bash
pnpm db:up
pnpm db:migrate
```

### 4. Start API and Worker

```bash
pnpm dev
```

API 서버는 `http://localhost:3000`에서 실행됩니다.

### 5. Start Web Console

새 터미널에서 실행합니다.

```bash
pnpm --filter camellia-web dev
```

브라우저에서 `http://localhost:5173`으로 접속합니다.

### External Integrations

| 기능 | 요구사항 |
|---|---|
| AWS 배포 | 콘솔에 등록한 AWS 자격 증명, Terraform |
| 이미지 빌드 | Docker·BuildKit 실행 환경 |
| 고정 URL·환경 전환 | Cloudflare Token·Zone·Account |
| On-Prem 배포 | Camellia Agent와 Docker |
| AI 분석 보강 | Anthropic API Key |

</details>

## 8. Testing and Documentation

Camellia는 개별 모듈 테스트뿐 아니라 **실서비스 API와 실제 AWS·On-Prem 런타임**을 사용해 전체 배포 흐름을 검증했습니다.

### Test Coverage

| Area | Verified Scenarios |
| --- | --- |
| **Source Analysis & IR** | Node.js, FastAPI, PostgreSQL, Multi-Service, Static Site 분석과 유효한 IR 생성 |
| **API & State Machine** | 프로젝트·환경·시크릿·배포 API 계약, 승인과 상태 전이, IR 버전 충돌 처리 |
| **Build & Provisioning** | 이미지 빌드·digest 고정, ECR Push/Pull, Terraform 기반 AWS 리소스 생성 |
| **On-Prem Agent** | 등록 토큰, Agent 인증, Heartbeat, Job Claim·Lease, 취소와 재시작 복구 |
| **Verification** | 후보 Endpoint 헬스체크, 최종 공개 URL 검증, Verify Job 멱등성 |
| **Environment Switching** | AWS → On-Prem, On-Prem → AWS 전환과 동일 이미지 digest 확인 |
| **Failure Recovery** | 검증 실패 시 기존 Origin 유지, 환경 락 해제와 후보 배포 정리 |
| **Concurrency** | AWS·On-Prem 혼합 동시 배포, 동일 프로젝트 중복 배포 차단 |
| **Performance** | 신규·재배포 시간, API 응답시간, Queue 대기와 전체 배포 완료시간 |

### Live Environment Test Results

> 2026-10-02 · 실서비스 API와 실제 AWS/On-Prem 환경에서 측정

| Result | Measurement |
| --- | ---: |
| 테스트 시나리오 | **13종** |
| 반복 실행 | **35회** |
| 실제 배포 | **61건** |
| 예상 결과 일치 | **60 / 61건** |
| 공개 Health Check | **20 / 20 성공 · P95 144ms** |
| AWS 동일 이미지 재배포 | **중앙값 20.32초** |
| On-Prem 동일 이미지 재배포 | **중앙값 19.91초** |
| 혼합 환경 5건 동시 요청 | **10 / 10 성공** |
| AWS ↔ On-Prem 전환 | **6 / 6 성공** |
| 검증 실패·기존 서비스 유지 | **3 / 3 성공** |
| 전환 과정에서 확인된 digest | **1개 · 동일 이미지 재사용** |
| 테스트 종료 후 잔여 환경 락 | **0개** |

동일 프로젝트에 동시에 들어온 배포 요청은 한 건만 접수하고 나머지는 `409 Conflict`로 차단했으며, 작업 완료 후 모든 환경 락이 정상적으로 해제되는 것을 확인했습니다.

검증에 실패한 후보 배포 3건은 모두 실패로 판정되었고, 기존 서비스는 HTTP `200` 상태로 유지되었습니다.

> **Known Limitation**  
> On-Prem 동시 배포는 6건 중 5건이 성공했습니다. 실패한 1건은 Agent 실행 이후 검증 단계에서 발생한 DNS 조회 오류였으며, 애플리케이션 실행이나 환경 락 누수 문제는 아니었습니다.

<details>
<summary><b>성능·복원력 테스트 결과 보기</b></summary>

<br />

![Camellia Performance Test Results](./docs/performance-results/20261002-comprehensive/Camellia-배포-성능-전체결과-2026-10-02.png)

</details>

### Documentation

| Document | Description |
| --- | --- |
| [Architecture Decisions](./docs/decisions.md) | 주요 기술 선택과 트레이드오프, 변경 이력 |
| [IR Specification](./docs/ir-spec-for-team.md) | 환경 중립 IR 구조와 컴포넌트 간 계약 |
| [On-Prem & Cloudflare API](./docs/onprem-cloudflare-api.md) | Agent Job, Named Tunnel과 Origin 전환 흐름 |
| [Platform Deployment](./docs/deploy-platform.md) | Camellia 플랫폼 자체 배포와 운영 구성 |
| [Performance Test Design](./docs/performance-testing.md) | 성능·동시성·복원력 테스트 설계와 판정 기준 |
| [Full Test Report](./docs/performance-results/20261002-comprehensive/report.md) | 시나리오별 실제 측정값과 상세 분석 |
| [Frontend Design Specification](./docs/design/DESIGN_SPEC.md) | Web Console 디자인과 상태 표현 기준 |
