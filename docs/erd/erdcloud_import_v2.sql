-- ERD Cloud 가져오기용 DDL (MySQL 문법)
-- 물리명: 영문 / 논리명: COMMENT의 한글명
-- 실제 DB는 PostgreSQL이며 postgres_schema.sql을 사용

CREATE TABLE `users` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT '사용자 아이디',
  `email` VARCHAR(255) NOT NULL COMMENT '이메일',
  `name` VARCHAR(100) NOT NULL COMMENT '이름',
  `role` VARCHAR(20) NOT NULL DEFAULT 'member' COMMENT '역할',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 일시',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '수정 일시',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_users_email` (`email`)
) COMMENT = '사용자';

CREATE TABLE `api_tokens` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT 'API 토큰 아이디',
  `user_id` BIGINT NOT NULL COMMENT '사용자 아이디',
  `name` VARCHAR(100) NOT NULL COMMENT '토큰명',
  `token_hash` VARCHAR(255) NOT NULL COMMENT '토큰 해시',
  `scope` VARCHAR(50) NOT NULL COMMENT '권한 범위',
  `expires_at` DATETIME NULL COMMENT '만료 일시',
  `last_used_at` DATETIME NULL COMMENT '마지막 사용 일시',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 일시',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_api_tokens_token_hash` (`token_hash`)
) COMMENT = 'API 토큰';

CREATE TABLE `projects` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT '프로젝트 아이디',
  `owner_id` BIGINT NOT NULL COMMENT '소유자 아이디',
  `name` VARCHAR(100) NOT NULL COMMENT '프로젝트명',
  `description` TEXT NULL COMMENT '설명',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 일시',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '수정 일시',
  PRIMARY KEY (`id`)
) COMMENT = '프로젝트';

CREATE TABLE `source_versions` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT '소스 버전 아이디',
  `project_id` BIGINT NOT NULL COMMENT '프로젝트 아이디',
  `version_no` INT NOT NULL COMMENT '버전 번호',
  `source_type` VARCHAR(20) NOT NULL COMMENT '소스 유형',
  `parent_version_id` BIGINT NULL COMMENT '상위 소스 버전 아이디',
  `git_repo_url` VARCHAR(500) NULL COMMENT 'Git 저장소 URL',
  `git_ref` VARCHAR(200) NULL COMMENT 'Git 브랜치·커밋',
  `content_hash` VARCHAR(64) NOT NULL COMMENT '내용 해시',
  `storage_key` VARCHAR(500) NOT NULL COMMENT '저장소 키',
  `uploaded_by` BIGINT NULL COMMENT '업로드 사용자 아이디',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 일시',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_source_versions_project_id_version_no` (`project_id`, `version_no`),
  KEY `ix_source_versions_content_hash` (`content_hash`)
) COMMENT = '소스 버전';

CREATE TABLE `analysis_reports` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT '분석 리포트 아이디',
  `source_version_id` BIGINT NOT NULL COMMENT '소스 버전 아이디',
  `architecture` VARCHAR(20) NOT NULL COMMENT '아키텍처 유형',
  `stack` JSON NULL COMMENT '기술 스택',
  `runtime` JSON NULL COMMENT '런타임 정보',
  `services` JSON NULL COMMENT '서비스 목록·의존 그래프',
  `resources` JSON NULL COMMENT '의존 리소스',
  `env_vars` JSON NULL COMMENT '환경변수 목록',
  `risks` JSON NULL COMMENT '운영 위험 목록',
  `used_llm` BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'LLM 사용 여부',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 일시',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_analysis_reports_source_version_id` (`source_version_id`)
) COMMENT = '분석 리포트';

CREATE TABLE `pipeline_definitions` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT '파이프라인 정의 아이디',
  `project_id` BIGINT NOT NULL COMMENT '프로젝트 아이디',
  `version_no` INT NOT NULL COMMENT '버전 번호',
  `definition` TEXT NOT NULL COMMENT '정의 내용',
  `created_by` BIGINT NULL COMMENT '작성자 아이디',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 일시',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_pipeline_definitions_project_id_version_no` (`project_id`, `version_no`)
) COMMENT = '파이프라인 정의';

CREATE TABLE `ir_versions` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT 'IR 버전 아이디',
  `project_id` BIGINT NOT NULL COMMENT '프로젝트 아이디',
  `source_version_id` BIGINT NULL COMMENT '소스 버전 아이디',
  `version_no` INT NOT NULL COMMENT '버전 번호',
  `schema_version` VARCHAR(20) NOT NULL COMMENT 'IR 스키마 버전',
  `spec` TEXT NOT NULL COMMENT 'IR 명세(YAML)',
  `origin` VARCHAR(20) NOT NULL COMMENT '생성 주체',
  `created_by` BIGINT NULL COMMENT '작성자 아이디',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 일시',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ir_versions_project_id_version_no` (`project_id`, `version_no`)
) COMMENT = 'IR 버전';

CREATE TABLE `targets` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT '대상 환경 아이디',
  `owner_id` BIGINT NOT NULL COMMENT '소유자 아이디',
  `name` VARCHAR(100) NOT NULL COMMENT '환경명',
  `provider` VARCHAR(20) NOT NULL COMMENT '제공자',
  `stage` VARCHAR(20) NOT NULL DEFAULT 'dev' COMMENT '환경 단계',
  `region` VARCHAR(50) NULL COMMENT '리전',
  `config` JSON NULL COMMENT '환경 설정',
  `role_identifier_ref` VARCHAR(500) NULL COMMENT '역할 아이디 볼트 참조',
  `status` VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT '상태',
  `auto_approve_policy` VARCHAR(20) NOT NULL DEFAULT 'none' COMMENT '자동 승인 정책',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 일시',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '수정 일시',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_targets_owner_id_name` (`owner_id`, `name`)
) COMMENT = '대상 환경';

CREATE TABLE `agent_tokens` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT '에이전트 등록 토큰 아이디',
  `target_id` BIGINT NOT NULL COMMENT '대상 환경 아이디',
  `token_hash` VARCHAR(255) NOT NULL COMMENT '토큰 해시',
  `expires_at` DATETIME NOT NULL COMMENT '만료 일시',
  `used_at` DATETIME NULL COMMENT '사용 일시',
  `created_by` BIGINT NULL COMMENT '발급자 아이디',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 일시',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_agent_tokens_token_hash` (`token_hash`)
) COMMENT = '에이전트 등록 토큰';

CREATE TABLE `onprem_agents` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT '온프레미스 에이전트 아이디',
  `target_id` BIGINT NOT NULL COMMENT '대상 환경 아이디',
  `hostname` VARCHAR(200) NULL COMMENT '호스트명',
  `os` VARCHAR(20) NOT NULL COMMENT '운영체제',
  `arch` VARCHAR(20) NOT NULL COMMENT 'CPU 아키텍처',
  `runtime` VARCHAR(20) NOT NULL COMMENT '실행 런타임',
  `agent_version` VARCHAR(20) NULL COMMENT '에이전트 버전',
  `credential_ref` VARCHAR(500) NOT NULL COMMENT '인증 정보 볼트 참조',
  `status` VARCHAR(20) NOT NULL DEFAULT 'online' COMMENT '상태',
  `last_seen_at` DATETIME NULL COMMENT '마지막 접속 일시',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 일시',
  PRIMARY KEY (`id`)
) COMMENT = '온프레미스 에이전트';

CREATE TABLE `secrets` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT '비밀값 메타데이터 아이디',
  `project_id` BIGINT NOT NULL COMMENT '프로젝트 아이디',
  `target_id` BIGINT NULL COMMENT '대상 환경 아이디',
  `key_name` VARCHAR(200) NOT NULL COMMENT '변수명',
  `is_secret` BOOLEAN NOT NULL DEFAULT TRUE COMMENT '비밀 여부',
  `vault_ref` VARCHAR(500) NOT NULL COMMENT '볼트 참조',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 일시',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '수정 일시',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_secrets_project_id_target_id_key_name` (`project_id`, `target_id`, `key_name`)
) COMMENT = '비밀값 메타데이터';

CREATE TABLE `pricing_catalog` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT '가격 카탈로그 아이디',
  `provider` VARCHAR(20) NOT NULL COMMENT '제공자',
  `service` VARCHAR(100) NOT NULL COMMENT '서비스명',
  `sku` VARCHAR(200) NOT NULL COMMENT '상품 코드',
  `region` VARCHAR(50) NOT NULL COMMENT '리전',
  `unit` VARCHAR(50) NOT NULL COMMENT '과금 단위',
  `unit_price` DECIMAL(14,6) NOT NULL COMMENT '단가',
  `currency` VARCHAR(3) NOT NULL DEFAULT 'USD' COMMENT '통화',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '수정 일시',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_pricing_catalog_provider_sku_region` (`provider`, `sku`, `region`)
) COMMENT = '가격 카탈로그';

CREATE TABLE `recommendations` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT '배포 추천 아이디',
  `project_id` BIGINT NOT NULL COMMENT '프로젝트 아이디',
  `ir_version_id` BIGINT NOT NULL COMMENT 'IR 버전 아이디',
  `conditions` JSON NULL COMMENT '사용자 조건',
  `explanation` TEXT NULL COMMENT 'AI 근거 설명',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 일시',
  PRIMARY KEY (`id`)
) COMMENT = '배포 추천';

CREATE TABLE `recommendation_candidates` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT '추천 후보 아이디',
  `recommendation_id` BIGINT NOT NULL COMMENT '추천 아이디',
  `target_id` BIGINT NULL COMMENT '대상 환경 아이디',
  `rank_no` INT NOT NULL COMMENT '순위',
  `provider` VARCHAR(20) NOT NULL COMMENT '제공자',
  `compute_type` VARCHAR(20) NOT NULL COMMENT '배포 형태',
  `service` VARCHAR(100) NULL COMMENT '대상 서비스',
  `score_cost` DECIMAL(14,6) NULL COMMENT '비용 점수',
  `score_performance` DECIMAL(14,6) NULL COMMENT '성능 점수',
  `score_scalability` DECIMAL(14,6) NULL COMMENT '확장성 점수',
  `monthly_cost` DECIMAL(14,6) NULL COMMENT '월 예상 비용',
  `currency` VARCHAR(3) NULL DEFAULT 'USD' COMMENT '통화',
  `cost_breakdown` JSON NULL COMMENT '비용 상세',
  `rationale` TEXT NULL COMMENT '추천 근거',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_recommendation_candidates_recommendation_id_rank_no` (`recommendation_id`, `rank_no`)
) COMMENT = '추천 후보';

CREATE TABLE `deployments` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT '배포 아이디',
  `project_id` BIGINT NOT NULL COMMENT '프로젝트 아이디',
  `target_id` BIGINT NULL COMMENT '대상 환경 아이디',
  `source_version_id` BIGINT NULL COMMENT '소스 버전 아이디',
  `ir_version_id` BIGINT NULL COMMENT 'IR 버전 아이디',
  `pipeline_definition_id` BIGINT NULL COMMENT '파이프라인 정의 아이디',
  `recommendation_candidate_id` BIGINT NULL COMMENT '선택 추천 후보 아이디',
  `kind` VARCHAR(20) NOT NULL DEFAULT 'deploy' COMMENT '배포 종류',
  `rollback_of_id` BIGINT NULL COMMENT '롤백 대상 배포 아이디',
  `compute_type` VARCHAR(20) NULL COMMENT '배포 형태',
  `strategy` VARCHAR(20) NOT NULL DEFAULT 'rolling' COMMENT '배포 전략',
  `rollout_config` JSON NULL COMMENT '롤아웃 설정',
  `state` VARCHAR(30) NOT NULL DEFAULT 'received' COMMENT '상태',
  `trigger_source` VARCHAR(20) NOT NULL COMMENT '요청 경로',
  `public_url` VARCHAR(500) NULL COMMENT '공개 URL',
  `retry_count` INT NOT NULL DEFAULT 0 COMMENT '재시도 횟수',
  `max_retries` INT NOT NULL DEFAULT 3 COMMENT '최대 재시도 횟수',
  `is_demo_preprovisioned` BOOLEAN NOT NULL DEFAULT FALSE COMMENT '사전 프로비저닝 여부',
  `requested_by` BIGINT NULL COMMENT '요청자 아이디',
  `started_at` DATETIME NULL COMMENT '시작 일시',
  `finished_at` DATETIME NULL COMMENT '종료 일시',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 일시',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '수정 일시',
  PRIMARY KEY (`id`),
  KEY `ix_deployments_target_id_state` (`target_id`, `state`),
  KEY `ix_deployments_project_id_created_at` (`project_id`, `created_at`)
) COMMENT = '배포';

CREATE TABLE `deployment_steps` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT '배포 단계 아이디',
  `deployment_id` BIGINT NOT NULL COMMENT '배포 아이디',
  `step` VARCHAR(30) NOT NULL COMMENT '단계',
  `custom_name` VARCHAR(100) NULL COMMENT '커스텀 단계명',
  `attempt` INT NOT NULL DEFAULT 1 COMMENT '시도 차수',
  `status` VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT '상태',
  `log_storage_key` VARCHAR(500) NULL COMMENT '로그 저장소 키',
  `error_message` TEXT NULL COMMENT '오류 메시지',
  `started_at` DATETIME NULL COMMENT '시작 일시',
  `ended_at` DATETIME NULL COMMENT '종료 일시',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_deployment_steps_id_deployment_id` (`id`, `deployment_id`),
  KEY `ix_deployment_steps_deployment_id_step` (`deployment_id`, `step`)
) COMMENT = '배포 단계';

CREATE TABLE `approvals` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT '승인 아이디',
  `deployment_id` BIGINT NOT NULL COMMENT '배포 아이디',
  `kind` VARCHAR(20) NOT NULL COMMENT '승인 대상',
  `decision` VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT '결정',
  `comment` TEXT NULL COMMENT '의견',
  `decided_by` BIGINT NULL COMMENT '결정자 아이디',
  `requested_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '요청 일시',
  `expires_at` DATETIME NULL COMMENT '만료 일시',
  `decided_at` DATETIME NULL COMMENT '결정 일시',
  PRIMARY KEY (`id`)
) COMMENT = '승인';

CREATE TABLE `env_locks` (
  `target_id` BIGINT NOT NULL COMMENT '대상 환경 아이디',
  `deployment_id` BIGINT NOT NULL COMMENT '배포 아이디',
  `holder_instance` VARCHAR(100) NULL COMMENT '보유 인스턴스',
  `acquired_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '획득 일시',
  `lease_expires_at` DATETIME NOT NULL COMMENT '임대 만료 일시',
  PRIMARY KEY (`target_id`),
  UNIQUE KEY `uq_env_locks_deployment_id` (`deployment_id`)
) COMMENT = '환경 락';

CREATE TABLE `jobs` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT '작업 큐 아이디',
  `deployment_id` BIGINT NOT NULL COMMENT '배포 아이디',
  `step_id` BIGINT NULL COMMENT '배포 단계 아이디',
  `job_type` VARCHAR(30) NOT NULL COMMENT '작업 유형',
  `payload` JSON NOT NULL COMMENT '작업 입력',
  `status` VARCHAR(20) NOT NULL DEFAULT 'queued' COMMENT '상태',
  `attempt` INT NOT NULL DEFAULT 0 COMMENT '시도 횟수',
  `max_attempts` INT NOT NULL DEFAULT 3 COMMENT '최대 시도 횟수',
  `run_after` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '실행 가능 일시',
  `locked_by` VARCHAR(100) NULL COMMENT '처리 워커',
  `locked_until` DATETIME NULL COMMENT '임대 만료 일시',
  `result` JSON NULL COMMENT '작업 결과',
  `last_error` TEXT NULL COMMENT '마지막 오류',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 일시',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '수정 일시',
  PRIMARY KEY (`id`),
  KEY `ix_jobs_status_run_after` (`status`, `run_after`)
) COMMENT = '작업 큐';

CREATE TABLE `patches` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT '코드 패치 아이디',
  `deployment_id` BIGINT NOT NULL COMMENT '배포 아이디',
  `goal` VARCHAR(40) NOT NULL COMMENT '수정 목적',
  `summary` TEXT NULL COMMENT '변경 요약',
  `diff_storage_key` VARCHAR(500) NOT NULL COMMENT 'diff 저장소 키',
  `result_source_version_id` BIGINT NULL COMMENT '적용 결과 소스 버전 아이디',
  `status` VARCHAR(20) NOT NULL DEFAULT 'proposed' COMMENT '상태',
  `verification_status` VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT '검증 상태',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 일시',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_patches_id_deployment_id` (`id`, `deployment_id`)
) COMMENT = '코드 패치';

CREATE TABLE `build_artifacts` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT '빌드 산출물 아이디',
  `deployment_id` BIGINT NOT NULL COMMENT '배포 아이디',
  `source_version_id` BIGINT NOT NULL COMMENT '빌드 소스 버전 아이디',
  `service_name` VARCHAR(100) NOT NULL COMMENT '서비스명',
  `registry` VARCHAR(200) NOT NULL COMMENT '레지스트리',
  `image_repo` VARCHAR(300) NOT NULL COMMENT '이미지 저장소',
  `image_tag` VARCHAR(200) NOT NULL COMMENT '이미지 태그',
  `image_digest` VARCHAR(100) NULL COMMENT '이미지 다이제스트',
  `platforms` VARCHAR(100) NULL COMMENT '빌드 플랫폼',
  `builder` VARCHAR(20) NOT NULL COMMENT '빌드 방식',
  `cache_hit` BOOLEAN NOT NULL DEFAULT FALSE COMMENT '캐시 사용 여부',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 일시',
  PRIMARY KEY (`id`)
) COMMENT = '빌드 산출물';

CREATE TABLE `infra_plans` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT '인프라 플랜 아이디',
  `deployment_id` BIGINT NOT NULL COMMENT '배포 아이디',
  `adapter` VARCHAR(20) NOT NULL COMMENT '어댑터',
  `iac_engine` VARCHAR(20) NOT NULL COMMENT 'IaC 엔진',
  `create_count` INT NOT NULL DEFAULT 0 COMMENT '생성 개수',
  `update_count` INT NOT NULL DEFAULT 0 COMMENT '변경 개수',
  `delete_count` INT NOT NULL DEFAULT 0 COMMENT '삭제 개수',
  `plan_storage_key` VARCHAR(500) NOT NULL COMMENT '플랜 저장소 키',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 일시',
  PRIMARY KEY (`id`)
) COMMENT = '인프라 플랜';

CREATE TABLE `provisioned_resources` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT '생성 리소스 아이디',
  `iac_stack_id` BIGINT NOT NULL COMMENT 'IaC 스택 아이디',
  `target_id` BIGINT NOT NULL COMMENT '대상 환경 아이디',
  `last_deployment_id` BIGINT NULL COMMENT '마지막 변경 배포 아이디',
  `resource_type` VARCHAR(100) NOT NULL COMMENT '리소스 유형',
  `resource_name` VARCHAR(200) NOT NULL COMMENT '리소스명',
  `provider_resource_id` VARCHAR(500) NULL COMMENT '제공자 리소스 ID',
  `status` VARCHAR(20) NOT NULL DEFAULT 'active' COMMENT '상태',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 일시',
  `deleted_at` DATETIME NULL COMMENT '삭제 일시',
  PRIMARY KEY (`id`),
  KEY `ix_provisioned_resources_target_id_status` (`target_id`, `status`)
) COMMENT = '생성 리소스';

CREATE TABLE `db_migrations` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT 'DB 마이그레이션 아이디',
  `deployment_id` BIGINT NOT NULL COMMENT '배포 아이디',
  `tool` VARCHAR(30) NULL COMMENT '마이그레이션 도구',
  `source_engine` VARCHAR(20) NULL COMMENT '원본 DB 엔진',
  `target_engine` VARCHAR(20) NOT NULL COMMENT '대상 DB 엔진',
  `schema_status` VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT '스키마 적용 상태',
  `data_transfer` BOOLEAN NOT NULL DEFAULT FALSE COMMENT '데이터 이전 여부',
  `source_row_count` BIGINT NULL COMMENT '원본 행 수',
  `target_row_count` BIGINT NULL COMMENT '대상 행 수',
  `verified` BOOLEAN NULL COMMENT '검증 통과 여부',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 일시',
  PRIMARY KEY (`id`)
) COMMENT = 'DB 마이그레이션';

CREATE TABLE `verifications` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT '검증 결과 아이디',
  `deployment_id` BIGINT NOT NULL COMMENT '배포 아이디',
  `patch_id` BIGINT NULL COMMENT '코드 패치 아이디',
  `kind` VARCHAR(20) NOT NULL COMMENT '검증 종류',
  `status` VARCHAR(20) NOT NULL COMMENT '결과',
  `metrics` JSON NULL COMMENT '측정 지표',
  `report_storage_key` VARCHAR(500) NULL COMMENT '리포트 저장소 키',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 일시',
  PRIMARY KEY (`id`)
) COMMENT = '검증 결과';

CREATE TABLE `diagnoses` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT '실패 진단 아이디',
  `deployment_id` BIGINT NOT NULL COMMENT '배포 아이디',
  `failed_step_id` BIGINT NULL COMMENT '실패 단계 아이디',
  `root_cause` TEXT NOT NULL COMMENT '추정 원인',
  `evidence` JSON NULL COMMENT '근거 로그·지표',
  `suggested_patch_id` BIGINT NULL COMMENT '제안 패치 아이디',
  `outcome` VARCHAR(20) NULL COMMENT '조치 결과',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 일시',
  PRIMARY KEY (`id`)
) COMMENT = '실패 진단';

CREATE TABLE `ai_usage` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT 'AI 사용량 아이디',
  `deployment_id` BIGINT NULL COMMENT '배포 아이디',
  `agent_run_id` BIGINT NULL COMMENT '에이전트 실행 아이디',
  `purpose` VARCHAR(20) NOT NULL COMMENT '사용 목적',
  `model` VARCHAR(100) NOT NULL COMMENT '모델명',
  `tokens_in` INT NOT NULL DEFAULT 0 COMMENT '입력 토큰 수',
  `tokens_out` INT NOT NULL DEFAULT 0 COMMENT '출력 토큰 수',
  `cost_usd` DECIMAL(14,6) NOT NULL DEFAULT 0 COMMENT '비용(USD)',
  `latency_ms` INT NULL COMMENT '응답 시간(ms)',
  `cache_hit` BOOLEAN NOT NULL DEFAULT FALSE COMMENT '캐시 사용 여부',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 일시',
  PRIMARY KEY (`id`),
  KEY `ix_ai_usage_created_at` (`created_at`)
) COMMENT = 'AI 사용량';

CREATE TABLE `audit_logs` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT '감사 로그 아이디',
  `actor_type` VARCHAR(20) NOT NULL COMMENT '행위자 유형',
  `actor_id` VARCHAR(100) NULL COMMENT '행위자 아이디',
  `action` VARCHAR(100) NOT NULL COMMENT '행위',
  `resource_type` VARCHAR(50) NOT NULL COMMENT '대상 리소스 유형',
  `resource_id` VARCHAR(100) NULL COMMENT '대상 리소스 아이디',
  `detail` JSON NULL COMMENT '상세',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 일시',
  PRIMARY KEY (`id`),
  KEY `ix_audit_logs_resource_type_resource_id` (`resource_type`, `resource_id`),
  KEY `ix_audit_logs_created_at` (`created_at`)
) COMMENT = '감사 로그';

CREATE TABLE `deployment_services` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT '배포 서비스 아이디',
  `deployment_id` BIGINT NOT NULL COMMENT '배포 아이디',
  `service_name` VARCHAR(100) NOT NULL COMMENT '서비스명',
  `deploy_order` INT NOT NULL DEFAULT 1 COMMENT '배포 순서',
  `build_artifact_id` BIGINT NULL COMMENT '빌드 산출물 아이디',
  `status` VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT '상태',
  `traffic_percent` INT NOT NULL DEFAULT 0 COMMENT '새 버전 트래픽 비율',
  `public_url` VARCHAR(500) NULL COMMENT '공개 URL',
  `internal_endpoint` VARCHAR(500) NULL COMMENT '내부 접속 주소',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 일시',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '수정 일시',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_deployment_services_deployment_id_service_name` (`deployment_id`, `service_name`)
) COMMENT = '배포 서비스';

CREATE TABLE `iac_stacks` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT 'IaC 스택 아이디',
  `project_id` BIGINT NOT NULL COMMENT '프로젝트 아이디',
  `target_id` BIGINT NOT NULL COMMENT '대상 환경 아이디',
  `engine` VARCHAR(20) NOT NULL COMMENT 'IaC 엔진',
  `stack_name` VARCHAR(200) NOT NULL COMMENT '스택명',
  `state_ref` VARCHAR(500) NOT NULL COMMENT 'state 저장 위치',
  `last_applied_deployment_id` BIGINT NULL COMMENT '마지막 적용 배포 아이디',
  `status` VARCHAR(20) NOT NULL DEFAULT 'active' COMMENT '상태',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 일시',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '수정 일시',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_iac_stacks_project_id_target_id` (`project_id`, `target_id`)
) COMMENT = 'IaC 스택';

CREATE TABLE `ci_triggers` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT 'CI 트리거 아이디',
  `project_id` BIGINT NOT NULL COMMENT '프로젝트 아이디',
  `target_id` BIGINT NOT NULL COMMENT '대상 환경 아이디',
  `pipeline_definition_id` BIGINT NULL COMMENT '파이프라인 정의 아이디',
  `repo_url` VARCHAR(500) NOT NULL COMMENT '저장소 URL',
  `branch` VARCHAR(200) NOT NULL COMMENT '브랜치',
  `webhook_secret_ref` VARCHAR(500) NOT NULL COMMENT '웹훅 비밀값 볼트 참조',
  `auto_deploy` BOOLEAN NOT NULL DEFAULT TRUE COMMENT '자동 배포 여부',
  `created_by` BIGINT NULL COMMENT '작성자 아이디',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 일시',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '수정 일시',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ci_triggers_project_id_repo_url_branch_target_id` (`project_id`, `repo_url`, `branch`, `target_id`)
) COMMENT = 'CI 트리거';

CREATE TABLE `agent_runs` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT '에이전트 실행 아이디',
  `deployment_id` BIGINT NULL COMMENT '배포 아이디',
  `trigger_source` VARCHAR(20) NOT NULL COMMENT '실행 주체',
  `goal` TEXT NOT NULL COMMENT '목표',
  `status` VARCHAR(20) NOT NULL DEFAULT 'running' COMMENT '상태',
  `summary` TEXT NULL COMMENT '결과 요약',
  `started_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '시작 일시',
  `ended_at` DATETIME NULL COMMENT '종료 일시',
  PRIMARY KEY (`id`)
) COMMENT = '에이전트 실행';

CREATE TABLE `agent_tool_calls` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT '에이전트 도구 호출 아이디',
  `agent_run_id` BIGINT NOT NULL COMMENT '에이전트 실행 아이디',
  `seq` INT NOT NULL COMMENT '호출 순번',
  `tool_name` VARCHAR(50) NOT NULL COMMENT '도구명',
  `input` JSON NULL COMMENT '입력',
  `output_summary` TEXT NULL COMMENT '결과 요약',
  `requires_approval` BOOLEAN NOT NULL DEFAULT FALSE COMMENT '승인 필요 여부',
  `approval_id` BIGINT NULL COMMENT '승인 아이디',
  `status` VARCHAR(20) NOT NULL COMMENT '상태',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 일시',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_agent_tool_calls_agent_run_id_seq` (`agent_run_id`, `seq`)
) COMMENT = '에이전트 도구 호출';

-- 관계 (외래 키)
ALTER TABLE `api_tokens` ADD CONSTRAINT `fk_api_tokens_user_id` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`);
ALTER TABLE `projects` ADD CONSTRAINT `fk_projects_owner_id` FOREIGN KEY (`owner_id`) REFERENCES `users` (`id`);
ALTER TABLE `source_versions` ADD CONSTRAINT `fk_source_versions_project_id` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`);
ALTER TABLE `source_versions` ADD CONSTRAINT `fk_source_versions_uploaded_by` FOREIGN KEY (`uploaded_by`) REFERENCES `users` (`id`);
ALTER TABLE `source_versions` ADD CONSTRAINT `fk_source_versions_parent_version_id` FOREIGN KEY (`parent_version_id`) REFERENCES `source_versions` (`id`);
ALTER TABLE `analysis_reports` ADD CONSTRAINT `fk_analysis_reports_source_version_id` FOREIGN KEY (`source_version_id`) REFERENCES `source_versions` (`id`);
ALTER TABLE `pipeline_definitions` ADD CONSTRAINT `fk_pipeline_definitions_project_id` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`);
ALTER TABLE `pipeline_definitions` ADD CONSTRAINT `fk_pipeline_definitions_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`);
ALTER TABLE `ir_versions` ADD CONSTRAINT `fk_ir_versions_project_id` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`);
ALTER TABLE `ir_versions` ADD CONSTRAINT `fk_ir_versions_source_version_id` FOREIGN KEY (`source_version_id`) REFERENCES `source_versions` (`id`);
ALTER TABLE `ir_versions` ADD CONSTRAINT `fk_ir_versions_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`);
ALTER TABLE `targets` ADD CONSTRAINT `fk_targets_owner_id` FOREIGN KEY (`owner_id`) REFERENCES `users` (`id`);
ALTER TABLE `agent_tokens` ADD CONSTRAINT `fk_agent_tokens_target_id` FOREIGN KEY (`target_id`) REFERENCES `targets` (`id`);
ALTER TABLE `agent_tokens` ADD CONSTRAINT `fk_agent_tokens_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`);
ALTER TABLE `onprem_agents` ADD CONSTRAINT `fk_onprem_agents_target_id` FOREIGN KEY (`target_id`) REFERENCES `targets` (`id`);
ALTER TABLE `secrets` ADD CONSTRAINT `fk_secrets_project_id` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`);
ALTER TABLE `secrets` ADD CONSTRAINT `fk_secrets_target_id` FOREIGN KEY (`target_id`) REFERENCES `targets` (`id`);
ALTER TABLE `recommendations` ADD CONSTRAINT `fk_recommendations_project_id` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`);
ALTER TABLE `recommendations` ADD CONSTRAINT `fk_recommendations_ir_version_id` FOREIGN KEY (`ir_version_id`) REFERENCES `ir_versions` (`id`);
ALTER TABLE `recommendation_candidates` ADD CONSTRAINT `fk_recommendation_candidates_recommendation_id` FOREIGN KEY (`recommendation_id`) REFERENCES `recommendations` (`id`);
ALTER TABLE `recommendation_candidates` ADD CONSTRAINT `fk_recommendation_candidates_target_id` FOREIGN KEY (`target_id`) REFERENCES `targets` (`id`);
ALTER TABLE `deployments` ADD CONSTRAINT `fk_deployments_project_id` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`);
ALTER TABLE `deployments` ADD CONSTRAINT `fk_deployments_target_id` FOREIGN KEY (`target_id`) REFERENCES `targets` (`id`);
ALTER TABLE `deployments` ADD CONSTRAINT `fk_deployments_source_version_id` FOREIGN KEY (`source_version_id`) REFERENCES `source_versions` (`id`);
ALTER TABLE `deployments` ADD CONSTRAINT `fk_deployments_ir_version_id` FOREIGN KEY (`ir_version_id`) REFERENCES `ir_versions` (`id`);
ALTER TABLE `deployments` ADD CONSTRAINT `fk_deployments_pipeline_definition_id` FOREIGN KEY (`pipeline_definition_id`) REFERENCES `pipeline_definitions` (`id`);
ALTER TABLE `deployments` ADD CONSTRAINT `fk_deployments_recommendation_candidate_id` FOREIGN KEY (`recommendation_candidate_id`) REFERENCES `recommendation_candidates` (`id`);
ALTER TABLE `deployments` ADD CONSTRAINT `fk_deployments_rollback_of_id` FOREIGN KEY (`rollback_of_id`) REFERENCES `deployments` (`id`);
ALTER TABLE `deployments` ADD CONSTRAINT `fk_deployments_requested_by` FOREIGN KEY (`requested_by`) REFERENCES `users` (`id`);
ALTER TABLE `deployment_steps` ADD CONSTRAINT `fk_deployment_steps_deployment_id` FOREIGN KEY (`deployment_id`) REFERENCES `deployments` (`id`);
ALTER TABLE `approvals` ADD CONSTRAINT `fk_approvals_deployment_id` FOREIGN KEY (`deployment_id`) REFERENCES `deployments` (`id`);
ALTER TABLE `approvals` ADD CONSTRAINT `fk_approvals_decided_by` FOREIGN KEY (`decided_by`) REFERENCES `users` (`id`);
ALTER TABLE `env_locks` ADD CONSTRAINT `fk_env_locks_target_id` FOREIGN KEY (`target_id`) REFERENCES `targets` (`id`);
ALTER TABLE `env_locks` ADD CONSTRAINT `fk_env_locks_deployment_id` FOREIGN KEY (`deployment_id`) REFERENCES `deployments` (`id`);
ALTER TABLE `jobs` ADD CONSTRAINT `fk_jobs_deployment_id` FOREIGN KEY (`deployment_id`) REFERENCES `deployments` (`id`);
ALTER TABLE `jobs` ADD CONSTRAINT `fk_jobs_step_id` FOREIGN KEY (`step_id`) REFERENCES `deployment_steps` (`id`);
ALTER TABLE `patches` ADD CONSTRAINT `fk_patches_deployment_id` FOREIGN KEY (`deployment_id`) REFERENCES `deployments` (`id`);
ALTER TABLE `patches` ADD CONSTRAINT `fk_patches_result_source_version_id` FOREIGN KEY (`result_source_version_id`) REFERENCES `source_versions` (`id`);
ALTER TABLE `build_artifacts` ADD CONSTRAINT `fk_build_artifacts_deployment_id` FOREIGN KEY (`deployment_id`) REFERENCES `deployments` (`id`);
ALTER TABLE `build_artifacts` ADD CONSTRAINT `fk_build_artifacts_source_version_id` FOREIGN KEY (`source_version_id`) REFERENCES `source_versions` (`id`);
ALTER TABLE `infra_plans` ADD CONSTRAINT `fk_infra_plans_deployment_id` FOREIGN KEY (`deployment_id`) REFERENCES `deployments` (`id`);
ALTER TABLE `provisioned_resources` ADD CONSTRAINT `fk_provisioned_resources_iac_stack_id` FOREIGN KEY (`iac_stack_id`) REFERENCES `iac_stacks` (`id`);
ALTER TABLE `provisioned_resources` ADD CONSTRAINT `fk_provisioned_resources_target_id` FOREIGN KEY (`target_id`) REFERENCES `targets` (`id`);
ALTER TABLE `provisioned_resources` ADD CONSTRAINT `fk_provisioned_resources_last_deployment_id` FOREIGN KEY (`last_deployment_id`) REFERENCES `deployments` (`id`);
ALTER TABLE `db_migrations` ADD CONSTRAINT `fk_db_migrations_deployment_id` FOREIGN KEY (`deployment_id`) REFERENCES `deployments` (`id`);
ALTER TABLE `verifications` ADD CONSTRAINT `fk_verifications_deployment_id` FOREIGN KEY (`deployment_id`) REFERENCES `deployments` (`id`);
ALTER TABLE `verifications` ADD CONSTRAINT `fk_verifications_patch_id` FOREIGN KEY (`patch_id`) REFERENCES `patches` (`id`);
ALTER TABLE `diagnoses` ADD CONSTRAINT `fk_diagnoses_deployment_id` FOREIGN KEY (`deployment_id`) REFERENCES `deployments` (`id`);
ALTER TABLE `diagnoses` ADD CONSTRAINT `fk_diagnoses_failed_step_id` FOREIGN KEY (`failed_step_id`) REFERENCES `deployment_steps` (`id`);
ALTER TABLE `diagnoses` ADD CONSTRAINT `fk_diagnoses_suggested_patch_id` FOREIGN KEY (`suggested_patch_id`) REFERENCES `patches` (`id`);
ALTER TABLE `ai_usage` ADD CONSTRAINT `fk_ai_usage_deployment_id` FOREIGN KEY (`deployment_id`) REFERENCES `deployments` (`id`);
ALTER TABLE `ai_usage` ADD CONSTRAINT `fk_ai_usage_agent_run_id` FOREIGN KEY (`agent_run_id`) REFERENCES `agent_runs` (`id`);
ALTER TABLE `deployment_services` ADD CONSTRAINT `fk_deployment_services_deployment_id` FOREIGN KEY (`deployment_id`) REFERENCES `deployments` (`id`);
ALTER TABLE `deployment_services` ADD CONSTRAINT `fk_deployment_services_build_artifact_id` FOREIGN KEY (`build_artifact_id`) REFERENCES `build_artifacts` (`id`);
ALTER TABLE `iac_stacks` ADD CONSTRAINT `fk_iac_stacks_project_id` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`);
ALTER TABLE `iac_stacks` ADD CONSTRAINT `fk_iac_stacks_target_id` FOREIGN KEY (`target_id`) REFERENCES `targets` (`id`);
ALTER TABLE `iac_stacks` ADD CONSTRAINT `fk_iac_stacks_last_applied_deployment_id` FOREIGN KEY (`last_applied_deployment_id`) REFERENCES `deployments` (`id`);
ALTER TABLE `ci_triggers` ADD CONSTRAINT `fk_ci_triggers_project_id` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`);
ALTER TABLE `ci_triggers` ADD CONSTRAINT `fk_ci_triggers_target_id` FOREIGN KEY (`target_id`) REFERENCES `targets` (`id`);
ALTER TABLE `ci_triggers` ADD CONSTRAINT `fk_ci_triggers_pipeline_definition_id` FOREIGN KEY (`pipeline_definition_id`) REFERENCES `pipeline_definitions` (`id`);
ALTER TABLE `ci_triggers` ADD CONSTRAINT `fk_ci_triggers_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`);
ALTER TABLE `agent_runs` ADD CONSTRAINT `fk_agent_runs_deployment_id` FOREIGN KEY (`deployment_id`) REFERENCES `deployments` (`id`);
ALTER TABLE `agent_tool_calls` ADD CONSTRAINT `fk_agent_tool_calls_agent_run_id` FOREIGN KEY (`agent_run_id`) REFERENCES `agent_runs` (`id`);
ALTER TABLE `agent_tool_calls` ADD CONSTRAINT `fk_agent_tool_calls_approval_id` FOREIGN KEY (`approval_id`) REFERENCES `approvals` (`id`);
