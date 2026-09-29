# ERD 변경 목록 (v1 → v2)

지금 ERD Cloud에 입력된 28개 테이블 기준으로, **바꿀 것만** 정리했어요. 타입은 지금 ERD와 같은 MySQL 타입이에요.

- A. 새 테이블 5개
- B. 기존 테이블 수정 11곳
- C. 관계선 추가 · 변경
- D. ERD에는 안 보이지만 바뀌는 것

---

## A. 새 테이블 5개

### 배포 서비스 (deployment_services)
쓰기 소유: 오케스트레이터

| 논리명(한글) | 물리명(영문) | 타입 | NULL | 기본값 | 키 | 허용 값 |
|---|---|---|---|---|---|---|
| 배포 서비스 아이디 | id | BIGINT | N |  | PK |  |
| 배포 아이디 | deployment_id | BIGINT | N |  | FK → deployments |  |
| 서비스명 | service_name | VARCHAR(100) | N |  |  |  |
| 배포 순서 | deploy_order | INT | N | 1 |  |  |
| 빌드 산출물 아이디 | build_artifact_id | BIGINT | Y |  | FK → build_artifacts |  |
| 상태 | status | VARCHAR(20) | N | pending |  | pending, deploying, healthy, failed, rolled_back |
| 새 버전 트래픽 비율 | traffic_percent | INT | N | 0 |  |  |
| 공개 URL | public_url | VARCHAR(500) | Y |  |  |  |
| 내부 접속 주소 | internal_endpoint | VARCHAR(500) | Y |  |  |  |
| 생성 일시 | created_at | DATETIME | N | CURRENT_TIMESTAMP |  |  |
| 수정 일시 | updated_at | DATETIME | N | CURRENT_TIMESTAMP |  |  |

고유 제약: (deployment_id, service_name)

### IaC 스택 (iac_stacks)
쓰기 소유: 프로비저닝 워커

| 논리명(한글) | 물리명(영문) | 타입 | NULL | 기본값 | 키 | 허용 값 |
|---|---|---|---|---|---|---|
| IaC 스택 아이디 | id | BIGINT | N |  | PK |  |
| 프로젝트 아이디 | project_id | BIGINT | N |  | FK → projects |  |
| 대상 환경 아이디 | target_id | BIGINT | N |  | FK → targets |  |
| IaC 엔진 | engine | VARCHAR(20) | N |  |  | pulumi, terraform, compose, k3s |
| 스택명 | stack_name | VARCHAR(200) | N |  |  |  |
| state 저장 위치 | state_ref | VARCHAR(500) | N |  |  |  |
| 마지막 적용 배포 아이디 | last_applied_deployment_id | BIGINT | Y |  | FK → deployments |  |
| 상태 | status | VARCHAR(20) | N | active |  | active, destroying, destroyed |
| 생성 일시 | created_at | DATETIME | N | CURRENT_TIMESTAMP |  |  |
| 수정 일시 | updated_at | DATETIME | N | CURRENT_TIMESTAMP |  |  |

고유 제약: (project_id, target_id)

### CI 트리거 (ci_triggers)
쓰기 소유: API 서버

| 논리명(한글) | 물리명(영문) | 타입 | NULL | 기본값 | 키 | 허용 값 |
|---|---|---|---|---|---|---|
| CI 트리거 아이디 | id | BIGINT | N |  | PK |  |
| 프로젝트 아이디 | project_id | BIGINT | N |  | FK → projects |  |
| 대상 환경 아이디 | target_id | BIGINT | N |  | FK → targets |  |
| 파이프라인 정의 아이디 | pipeline_definition_id | BIGINT | Y |  | FK → pipeline_definitions |  |
| 저장소 URL | repo_url | VARCHAR(500) | N |  |  |  |
| 브랜치 | branch | VARCHAR(200) | N |  |  |  |
| 웹훅 비밀값 볼트 참조 | webhook_secret_ref | VARCHAR(500) | N |  |  |  |
| 자동 배포 여부 | auto_deploy | BOOLEAN | N | TRUE |  |  |
| 작성자 아이디 | created_by | BIGINT | Y |  | FK → users |  |
| 생성 일시 | created_at | DATETIME | N | CURRENT_TIMESTAMP |  |  |
| 수정 일시 | updated_at | DATETIME | N | CURRENT_TIMESTAMP |  |  |

고유 제약: (project_id, repo_url, branch, target_id)

### 에이전트 실행 (agent_runs)
쓰기 소유: AI 에이전트

| 논리명(한글) | 물리명(영문) | 타입 | NULL | 기본값 | 키 | 허용 값 |
|---|---|---|---|---|---|---|
| 에이전트 실행 아이디 | id | BIGINT | N |  | PK |  |
| 배포 아이디 | deployment_id | BIGINT | Y |  | FK → deployments |  |
| 실행 주체 | trigger_source | VARCHAR(20) | N |  |  | orchestrator, user, mcp |
| 목표 | goal | TEXT | N |  |  |  |
| 상태 | status | VARCHAR(20) | N | running |  | running, waiting_approval, succeeded, failed, cancelled |
| 결과 요약 | summary | TEXT | Y |  |  |  |
| 시작 일시 | started_at | DATETIME | N | CURRENT_TIMESTAMP |  |  |
| 종료 일시 | ended_at | DATETIME | Y |  |  |  |

### 에이전트 도구 호출 (agent_tool_calls)
쓰기 소유: AI 에이전트

| 논리명(한글) | 물리명(영문) | 타입 | NULL | 기본값 | 키 | 허용 값 |
|---|---|---|---|---|---|---|
| 에이전트 도구 호출 아이디 | id | BIGINT | N |  | PK |  |
| 에이전트 실행 아이디 | agent_run_id | BIGINT | N |  | FK → agent_runs |  |
| 호출 순번 | seq | INT | N |  |  |  |
| 도구명 | tool_name | VARCHAR(50) | N |  |  |  |
| 입력 | input | JSON | Y |  |  |  |
| 결과 요약 | output_summary | TEXT | Y |  |  |  |
| 승인 필요 여부 | requires_approval | BOOLEAN | N | FALSE |  |  |
| 승인 아이디 | approval_id | BIGINT | Y |  | FK → approvals |  |
| 상태 | status | VARCHAR(20) | N |  |  | succeeded, failed, blocked, pending_approval |
| 생성 일시 | created_at | DATETIME | N | CURRENT_TIMESTAMP |  |  |

고유 제약: (agent_run_id, seq)

---

## B. 기존 테이블 수정

| # | 테이블 | 작업 | 논리명(한글) | 물리명(영문) | 타입 | NULL | 비고 |
|---|---|---|---|---|---|---|---|
| 1 | 배포 (deployments) | **NULL 허용으로 변경** | 대상 환경 아이디 | target_id | BIGINT | Y | 추천 후 환경 확정 전에는 비어 있음 |
| 2 | 배포 (deployments) | 컬럼 추가 (strategy 아래) | 롤아웃 설정 | rollout_config | JSON | Y | 예: 카나리 단계 [10, 50, 100], 관찰 시간 |
| 3 | 배포 (deployments) | 허용 값 추가 | 상태 | state | VARCHAR(30) | N | `awaiting_target_confirmation` (환경 확정 대기) 추가 |
| 4 | 추천 후보 (recommendation_candidates) | 컬럼 추가 (추천 아이디 아래) | 대상 환경 아이디 | target_id | BIGINT | Y | 등록된 대상 환경과 연결 |
| 5 | 소스 버전 (source_versions) | 컬럼 추가 | 상위 소스 버전 아이디 | parent_version_id | BIGINT | Y | 패치 적용 전 원본 버전 |
| 6 | 소스 버전 (source_versions) | 허용 값 추가 | 소스 유형 | source_type | VARCHAR(20) | N | `patched` 추가 |
| 7 | 코드 패치 (patches) | 컬럼 추가 | 적용 결과 소스 버전 아이디 | result_source_version_id | BIGINT | Y | 승인·적용 후 생긴 새 소스 버전 |
| 8 | 빌드 산출물 (build_artifacts) | 컬럼 추가 2개 | 빌드 소스 버전 아이디 / 서비스명 | source_version_id / service_name | BIGINT / VARCHAR(100) | N / N | 어떤 코드로, 어떤 서비스를 빌드했는지 |
| 9 | 생성 리소스 (provisioned_resources) | 컬럼 추가 + 변경 | IaC 스택 아이디 | iac_stack_id | BIGINT | N | 리소스를 배포가 아니라 스택에 연결 |
| 9 | 생성 리소스 (provisioned_resources) | **이름·NULL 변경** | 생성 배포 아이디 → 마지막 변경 배포 아이디 | deployment_id → last_deployment_id | BIGINT | Y | |
| 10 | 대상 환경 (targets) | 컬럼 추가 (상태 아래) | 자동 승인 정책 | auto_approve_policy | VARCHAR(20) | N | 기본값 none. 허용 값: none, plan_only, all |
| 11 | AI 사용량 (ai_usage) | 컬럼 추가 | 에이전트 실행 아이디 | agent_run_id | BIGINT | Y | 어떤 에이전트 실행에서 쓴 토큰인지 |

이미 반영하신 것: 배포 추천(recommendations)의 `selected_candidate_id` 삭제 ✅

**선택 (통일)**: 대상 환경(targets)의 `config` 타입이 `JSONB`예요. 다른 JSON 컬럼과 맞춰 `JSON`으로 바꾸는 걸 추천해요.

---

## C. 관계선

### 추가 (모두 비식별 관계, 점선)

| 자식 테이블 . 컬럼 | → 부모 테이블 | 비고 |
|---|---|---|
| deployment_services.deployment_id | deployments | 새 테이블 |
| deployment_services.build_artifact_id | build_artifacts | 새 테이블 |
| iac_stacks.project_id | projects | 새 테이블 |
| iac_stacks.target_id | targets | 새 테이블 |
| iac_stacks.last_applied_deployment_id | deployments | 새 테이블 |
| ci_triggers.project_id | projects | 새 테이블 |
| ci_triggers.target_id | targets | 새 테이블 |
| ci_triggers.pipeline_definition_id | pipeline_definitions | 새 테이블 |
| ci_triggers.created_by | users | 새 테이블 |
| agent_runs.deployment_id | deployments | 새 테이블 |
| agent_tool_calls.agent_run_id | agent_runs | 새 테이블 |
| agent_tool_calls.approval_id | approvals | 새 테이블 |
| recommendation_candidates.target_id | targets | 수정 #4 |
| source_versions.parent_version_id | source_versions | 자기 참조 (수정 #5) |
| patches.result_source_version_id | source_versions | 수정 #7 |
| build_artifacts.source_version_id | source_versions | 수정 #8 |
| provisioned_resources.iac_stack_id | iac_stacks | 수정 #9 |
| ai_usage.agent_run_id | agent_runs | 수정 #11 |

### 변경

- **provisioned_resources → deployments**: 컬럼이 `last_deployment_id`로 바뀌고 NULL 허용이 돼요. 선 모양이 "필수"에서 "선택"(0 또는 1)으로 바뀌어요.
- **deployments → targets**: `target_id`가 NULL 허용이 되면서 선이 "선택"으로 바뀌어요.

관계선 합계: v1 47개 → v2 64개 (추천 ↔ 후보 순환 1개 제거 포함). 테이블 간 순환 참조는 없어요 (배포의 롤백, 소스 버전의 상위 버전 자기 참조 2개만 있음).

---

## D. ERD에는 안 보이지만 바뀌는 것

| 항목 | 내용 | 반영 위치 |
|---|---|---|
| 비밀값 중복 방지 | 프로젝트 공통 변수(대상 환경 없음)도 중복되지 않게 `UNIQUE NULLS NOT DISTINCT` (PostgreSQL 15 이상) | postgres_schema_v2.sql |
| 우회 경로 정합성 | 작업 큐·실패 진단·검증 결과의 배포 아이디가 참조하는 단계·패치의 배포 아이디와 항상 같도록 복합 외래 키 4개 | postgres_schema_v2.sql |
| 승인 소유권 | 승인(approvals) 쓰기 소유를 API 서버 → **오케스트레이터**로 변경. API 서버는 사용자의 승인·거부를 오케스트레이터에 전달만 함 (만료 처리도 오케스트레이터) | 데이터사전_v2.md, 아키텍처 문서 |
| 상태 머신 | "환경 확정 대기" 상태 추가. **환경 락은 접수가 아니라 환경 확정 직후에 획득** | 아키텍처 문서 5.3절 (갱신 필요) |
| 논리명 규칙 | 기본 키는 "<테이블명> 아이디", 외래 키는 "... 아이디"로 통일 (지금 ERD에 입력하신 방식) | 데이터사전_v2.md |
