# Camellia 성능 테스트 계획과 실행 기록 규칙

## 목적

Camellia는 API 응답이 끝난 뒤 `analyze → build → provision → deploy → verify`가 비동기로 이어진다. 따라서 HTTP 응답시간만 재지 않고 다음 세 층을 분리한다.

1. API 수락 성능: 업로드 요청의 응답시간·성공률
2. 배포 파이프라인 성능: 큐 대기·작업 실행·전체 완료시간
3. 배포 정확성: 동일 digest, 전환 가용성, 실패 롤백, 잠금·고아 리소스 정리

공식 근거:

- k6 시나리오는 서로 다른 workload를 독립적으로 병렬 실행할 수 있다: <https://grafana.com/docs/k6/latest/using-k6/scenarios/>
- 고정 도착률 테스트는 시스템 응답이 느려져도 요청 발생률을 유지해 coordinated omission을 줄인다: <https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/>
- smoke와 average-load 기준선을 먼저 만들고 동일 조건을 반복 비교한다: <https://grafana.com/docs/k6/latest/testing-guides/automated-performance-testing/>
- 실제 사용자 흐름과 전체 아키텍처를 production-like 환경에서 검증한다: <https://docs.aws.amazon.com/wellarchitected/latest/framework/perf_process_culture_load_test.html>
- latency·traffic·errors·saturation을 함께 관찰한다: <https://sre.google/sre-book/monitoring-distributed-systems/>

## 저장 구조

```text
tests/performance/
├── k6/
│   ├── health-smoke.js
│   └── deployment-submit.js
├── scripts/
│   ├── write-metadata.mjs
│   ├── collect.mjs
│   ├── report.mjs
│   ├── compare.mjs
│   ├── comprehensive-report.mjs
│   └── agent-restart-check.mjs
├── results/                 # 로컬 원시 결과, Git 제외
└── run.sh

docs/performance-results/    # 팀 공유용으로 선별한 실행 결과
```

실행 폴더에는 다음 파일이 생성된다.

| 파일 | 내용 |
|---|---|
| `metadata.json` | 실행 목적, Git SHA, OS/아키텍처, k6 버전, fixture digest, 프로젝트·환경, Cold/Warm 조건 |
| `k6-points.json` | k6 원시 metric point. 로컬/CI Artifact 보존 |
| `k6-summary.json` | HTTP latency, 실패율, threshold 결과 |
| `submissions.json` | k6가 생성한 deployment ID |
| `deployments.json` | 상태 전이 관찰값, 최종 상태, health 결과 |
| `db-metrics.json` | DB 접근 시 pg-boss 큐 대기·실행, deployment step, Agent job, health attempt |
| `summary.csv` | 배포별 요약 데이터 |
| `report.md` | 재검토 가능한 텍스트 보고서 |
| `report.html` | 동시 배포 완료시간과 단계 통계 시각화 |

`API_TOKEN`과 `DATABASE_URL`은 산출물에 기록하지 않는다. 단계 로그를 수집할 때도 token/key 형태를 마스킹한다.

플랫폼 DB가 EC2 내부에만 있으면 SSM으로 read-only SQL을 실행해 세부 지표를 보강한다.

```bash
AWS_PROFILE=SB-hackathon \
AWS_REGION=ap-northeast-2 \
SSM_INSTANCE_ID='<platform-instance-id>' \
node tests/performance/scripts/collect-ssm-db.mjs tests/performance/results/<run-id>

node tests/performance/scripts/report.mjs tests/performance/results/<run-id>
```

## 사전 조건

- k6
- Node.js 20+
- 테스트 전용 또는 데모용 Project
- 실제 배포 테스트는 서로 다른 Project ID를 사용한다.
- 같은 Project 동시 요청은 잠금 정확성 테스트에서만 사용한다.
- AWS 생성 비용과 Agent 여유 자원을 확인한다.

## 실행 방법

### 1. 공개 Health smoke

```bash
API_BASE_URL=https://console.camellia-deploy.app \
ITERATIONS=20 \
TEST_PURPOSE='공개 프록시와 API health 기준선' \
pnpm test:performance:health
```

### 2. 단일 배포 smoke

```bash
API_BASE_URL=https://console.camellia-deploy.app/api/v1 \
API_TOKEN='<세션 또는 플랫폼 API 토큰>' \
SOURCE_ZIP='/absolute/path/to/sample.zip' \
PROJECT_IDS='101' \
ENVIRONMENT_IDS='5' \
CACHE_CONDITION='cold' \
TEST_PURPOSE='On-Prem 단일 Cold 배포 기준선' \
pnpm test:performance smoke
```

기존 성공 배포의 동일 소스·IR·digest를 재사용하는 Warm 경로는 다음처럼 측정한다. live 앱의 내용을 바꾸지 않고 Worker→대상 환경→Verify 경로를 재검증할 때 우선 사용한다.

```bash
API_BASE_URL=https://console.camellia-deploy.app/api/v1 \
API_TOKEN='<세션 또는 플랫폼 API 토큰>' \
REQUEST_KIND=redeploy \
SOURCE_DEPLOYMENT_IDS='80' \
PROJECT_IDS='6' \
ENVIRONMENT_IDS='6' \
CACHE_CONDITION='warm-same-digest' \
TEST_PURPOSE='기존 성공 digest On-Prem 재배포 기준선' \
pnpm test:performance smoke
```

### 3. 서로 다른 프로젝트 동시 2건

```bash
API_BASE_URL=https://console.camellia-deploy.app/api/v1 \
API_TOKEN='<토큰>' \
SOURCE_ZIP='/absolute/path/to/sample.zip' \
PROJECT_IDS='101,102' \
ENVIRONMENT_IDS='5,6' \
CACHE_CONDITION='warm' \
TEST_PURPOSE='서로 다른 프로젝트 On-Prem 2건 동시 요청' \
pnpm test:performance burst2
```

AWS+On-Prem 혼합은 각 Project에 맞는 `ENVIRONMENT_IDS` 순서를 지정한다. 결과의 target은 환경이 결정하므로 metadata에서 환경 ID와 프로젝트 매핑을 함께 확인한다.

### 4. 같은 프로젝트 잠금 테스트

성능이 아니라 정확성 테스트다. 정상 기대값은 두 건 모두 성공하는 것이 아니라, 정책에 따라 한 건이 `409 DEPLOYMENT_LOCKED`로 거절되는 것이다.

```bash
API_BASE_URL=https://console.camellia-deploy.app/api/v1 \
API_TOKEN='<토큰>' \
SOURCE_ZIP='/absolute/path/to/sample.zip' \
PROJECT_IDS='101' \
ENVIRONMENT_IDS='5' \
EXPECTED_ACCEPT_RATE='0.5' \
TEST_PURPOSE='같은 환경 동시 요청 잠금과 해제 검증' \
pnpm test:performance same-project-burst2
```

### 5. 고정 도착률

실제 AWS 리소스를 생성하므로 smoke와 burst 결과를 확인한 뒤 제한된 테스트 환경에서만 실행한다.

```bash
PROFILE=arrival \
ARRIVAL_RATE=1 \
ARRIVAL_TIME_UNIT=30s \
ARRIVAL_DURATION=5m \
PROJECT_IDS='101,102,103,104,105' \
ENVIRONMENT_IDS='5,6,7,8,9' \
pnpm test:performance arrival
```

## 필수 시나리오 매트릭스

| 분류 | 시나리오 | 반복 | 주요 판정 |
|---|---|---:|---|
| 기준선 | AWS Cold / Warm 단일 | 각 3회 | 단계별 중앙값, 성공률 |
| 기준선 | On-Prem Cold / Warm 단일 | 각 3회 | Agent 포함 전체 시간 |
| 동시성 | AWS + AWS | 3회 | 같은 큐 대기 증가량 |
| 동시성 | On-Prem + On-Prem | 3회 | Agent 처리와 리소스 포화 |
| 동시성 | AWS + On-Prem | 3회 | AWS Terraform의 On-Prem 차단 여부 |
| 동시성 | 서로 다른 프로젝트 혼합 5건 | 2회 | queue saturation과 누락 |
| 정확성 | 같은 프로젝트 동시 2건 | 3회 | 잠금, 종료 후 재시도 가능 |
| 전환 | AWS → On-Prem / 역방향 | 각 3회 | 동일 digest, URL 단절시간 |
| 실패 | health 실패 후보 | 3회 | 이전 Origin 유지, 후보 제거 |

Grafana의 반복 실행 권고에 따라 최소 2회를 사용한다. 데모 핵심이면서 비용이 허용되는 시나리오는 3회 수행한다. 전체 배포처럼 표본이 작은 결과는 p95보다 중앙값과 개별 실행값을 우선한다.

## 지표와 판정

### API

- `camellia_deployment_accepted`
- `camellia_deployment_accept_duration`
- `http_req_duration`
- `http_req_failed`

### 큐·단계

- pg-boss `created_on → started_on`: 큐 대기
- pg-boss `started_on → completed_on`: 핸들러 실행
- `deployment_steps.duration_ms`: 실제 단계 실행
- 전체 `deployments.created_at → succeeded_at | failed_at`

### 정확성

- 유효 fixture 성공률 100%
- AWS와 On-Prem 실제 실행 digest 일치 100%
- 실패·취소 후 `env_locks`와 후보 컨테이너가 남지 않음
- 전환 실패 시 기존 Origin health 유지
- 서로 다른 프로젝트의 On-Prem 작업이 장시간 AWS provision 뒤에서 대기하지 않음

절대 성능 SLO는 첫 기준선 결과를 얻은 뒤 확정한다. 초기 회귀 기준은 동일 조건에서 단계 중앙값 10% 초과 악화를 조사 대상으로 삼는다.

## Before / After 비교

```bash
node tests/performance/scripts/compare.mjs \
  tests/performance/results/<before-run> \
  tests/performance/results/<after-run> \
  tests/performance/results/comparison.html
```

다음 조건이 같은 실행끼리만 비교한다.

- fixture SHA-256
- AWS 리전과 Environment
- Project 유형
- Cold/Warm 캐시 상태
- Agent 머신과 Docker 상태
- 동시 요청 수와 도착률
- 테스트 실행기 네트워크 위치

동일 조건을 2회 이상 반복한 기준선은 series 리포트로 묶는다.

```bash
node tests/performance/scripts/series.mjs \
  docs/performance-results/<baseline-name> \
  tests/performance/results/<run-1> \
  tests/performance/results/<run-2> \
  tests/performance/results/<run-3>
```

AWS+On-Prem `burst2` 반복 실행은 target별 provision 대기와 실행을 비교한다.

```bash
node tests/performance/scripts/concurrency-series.mjs \
  docs/performance-results/<concurrency-baseline-name> \
  tests/performance/results/<burst-run-1> \
  tests/performance/results/<burst-run-2>
```

## 결과 공유

```bash
bash tests/performance/archive-run.sh tests/performance/results/<run-id>
```

이 명령은 토큰과 대용량 원시 point를 제외한 재현 조건·요약·시각화 결과를 `docs/performance-results/<run-id>/`에 복사한다. 원시 point와 상세 로그는 로컬 또는 GitHub Actions Artifact로 함께 보존한다.

On-Prem 반복 실행 뒤 active+standby 최대 2개 정책은 로컬 Docker snapshot으로 남긴다.

```bash
EXPECTED_RUNTIME_COUNT=2 node tests/performance/scripts/capture-local-runtime.mjs \
  docs/performance-results/<result-name>/runtime-check.json
```

전체 시나리오 실행이 끝나면 선별 결과를 한 번에 집계한다.

```bash
node tests/performance/scripts/comprehensive-report.mjs
```

집계 결과는 `docs/performance-results/20261002-comprehensive/`의 JSON, CSV, Markdown, HTML로 남는다. 숫자만 요약하지 않고 실행별 원본 폴더를 함께 보존해 실패 원인과 측정 조건을 다시 확인할 수 있게 한다.
