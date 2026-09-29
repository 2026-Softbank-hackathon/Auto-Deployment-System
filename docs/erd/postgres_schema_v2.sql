-- PostgreSQL 실제 스키마 v2
-- 테이블·컬럼 한글명은 COMMENT ON으로 저장

CREATE TABLE users (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(100) NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_users PRIMARY KEY (id),
  CONSTRAINT uq_users_email UNIQUE (email)
);
COMMENT ON TABLE users IS '사용자 (소유: API 서버)';
COMMENT ON COLUMN users.id IS '사용자 아이디';
COMMENT ON COLUMN users.email IS '이메일';
COMMENT ON COLUMN users.name IS '이름';
COMMENT ON COLUMN users.role IS '역할 [admin, member]';
COMMENT ON COLUMN users.created_at IS '생성 일시';
COMMENT ON COLUMN users.updated_at IS '수정 일시';

CREATE TABLE api_tokens (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  user_id BIGINT NOT NULL,
  name VARCHAR(100) NOT NULL,
  token_hash VARCHAR(255) NOT NULL,
  scope VARCHAR(50) NOT NULL CHECK (scope IN ('ci', 'cli', 'mcp')),
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_api_tokens PRIMARY KEY (id),
  CONSTRAINT uq_api_tokens_token_hash UNIQUE (token_hash)
);
COMMENT ON TABLE api_tokens IS 'API 토큰 (소유: API 서버)';
COMMENT ON COLUMN api_tokens.id IS 'API 토큰 아이디';
COMMENT ON COLUMN api_tokens.user_id IS '사용자 아이디';
COMMENT ON COLUMN api_tokens.name IS '토큰명';
COMMENT ON COLUMN api_tokens.token_hash IS '토큰 해시';
COMMENT ON COLUMN api_tokens.scope IS '권한 범위 [ci, cli, mcp]';
COMMENT ON COLUMN api_tokens.expires_at IS '만료 일시';
COMMENT ON COLUMN api_tokens.last_used_at IS '마지막 사용 일시';
COMMENT ON COLUMN api_tokens.created_at IS '생성 일시';

CREATE TABLE projects (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  owner_id BIGINT NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_projects PRIMARY KEY (id)
);
COMMENT ON TABLE projects IS '프로젝트 (소유: API 서버)';
COMMENT ON COLUMN projects.id IS '프로젝트 아이디';
COMMENT ON COLUMN projects.owner_id IS '소유자 아이디';
COMMENT ON COLUMN projects.name IS '프로젝트명';
COMMENT ON COLUMN projects.description IS '설명';
COMMENT ON COLUMN projects.created_at IS '생성 일시';
COMMENT ON COLUMN projects.updated_at IS '수정 일시';

CREATE TABLE source_versions (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  project_id BIGINT NOT NULL,
  version_no INTEGER NOT NULL,
  source_type VARCHAR(20) NOT NULL CHECK (source_type IN ('upload', 'git', 'patched')),
  parent_version_id BIGINT,
  git_repo_url VARCHAR(500),
  git_ref VARCHAR(200),
  content_hash VARCHAR(64) NOT NULL,
  storage_key VARCHAR(500) NOT NULL,
  uploaded_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_source_versions PRIMARY KEY (id),
  CONSTRAINT uq_source_versions_project_id_version_no UNIQUE (project_id, version_no)
);
CREATE INDEX ix_source_versions_content_hash ON source_versions (content_hash);
COMMENT ON TABLE source_versions IS '소스 버전 (소유: API 서버)';
COMMENT ON COLUMN source_versions.id IS '소스 버전 아이디';
COMMENT ON COLUMN source_versions.project_id IS '프로젝트 아이디';
COMMENT ON COLUMN source_versions.version_no IS '버전 번호';
COMMENT ON COLUMN source_versions.source_type IS '소스 유형 [upload, git, patched]';
COMMENT ON COLUMN source_versions.parent_version_id IS '상위 소스 버전 아이디';
COMMENT ON COLUMN source_versions.git_repo_url IS 'Git 저장소 URL';
COMMENT ON COLUMN source_versions.git_ref IS 'Git 브랜치·커밋';
COMMENT ON COLUMN source_versions.content_hash IS '내용 해시';
COMMENT ON COLUMN source_versions.storage_key IS '저장소 키';
COMMENT ON COLUMN source_versions.uploaded_by IS '업로드 사용자 아이디';
COMMENT ON COLUMN source_versions.created_at IS '생성 일시';

CREATE TABLE analysis_reports (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  source_version_id BIGINT NOT NULL,
  architecture VARCHAR(20) NOT NULL CHECK (architecture IN ('monolith', 'msa', 'unknown')),
  stack JSONB,
  runtime JSONB,
  services JSONB,
  resources JSONB,
  env_vars JSONB,
  risks JSONB,
  used_llm BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_analysis_reports PRIMARY KEY (id),
  CONSTRAINT uq_analysis_reports_source_version_id UNIQUE (source_version_id)
);
COMMENT ON TABLE analysis_reports IS '분석 리포트 (소유: 분석 워커)';
COMMENT ON COLUMN analysis_reports.id IS '분석 리포트 아이디';
COMMENT ON COLUMN analysis_reports.source_version_id IS '소스 버전 아이디';
COMMENT ON COLUMN analysis_reports.architecture IS '아키텍처 유형 [monolith, msa, unknown]';
COMMENT ON COLUMN analysis_reports.stack IS '기술 스택';
COMMENT ON COLUMN analysis_reports.runtime IS '런타임 정보';
COMMENT ON COLUMN analysis_reports.services IS '서비스 목록·의존 그래프';
COMMENT ON COLUMN analysis_reports.resources IS '의존 리소스';
COMMENT ON COLUMN analysis_reports.env_vars IS '환경변수 목록';
COMMENT ON COLUMN analysis_reports.risks IS '운영 위험 목록';
COMMENT ON COLUMN analysis_reports.used_llm IS 'LLM 사용 여부';
COMMENT ON COLUMN analysis_reports.created_at IS '생성 일시';

CREATE TABLE pipeline_definitions (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  project_id BIGINT NOT NULL,
  version_no INTEGER NOT NULL,
  definition TEXT NOT NULL,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_pipeline_definitions PRIMARY KEY (id),
  CONSTRAINT uq_pipeline_definitions_project_id_version_no UNIQUE (project_id, version_no)
);
COMMENT ON TABLE pipeline_definitions IS '파이프라인 정의 (소유: API 서버)';
COMMENT ON COLUMN pipeline_definitions.id IS '파이프라인 정의 아이디';
COMMENT ON COLUMN pipeline_definitions.project_id IS '프로젝트 아이디';
COMMENT ON COLUMN pipeline_definitions.version_no IS '버전 번호';
COMMENT ON COLUMN pipeline_definitions.definition IS '정의 내용';
COMMENT ON COLUMN pipeline_definitions.created_by IS '작성자 아이디';
COMMENT ON COLUMN pipeline_definitions.created_at IS '생성 일시';

CREATE TABLE ir_versions (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  project_id BIGINT NOT NULL,
  source_version_id BIGINT,
  version_no INTEGER NOT NULL,
  schema_version VARCHAR(20) NOT NULL,
  spec TEXT NOT NULL,
  origin VARCHAR(20) NOT NULL CHECK (origin IN ('agent', 'user')),
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_ir_versions PRIMARY KEY (id),
  CONSTRAINT uq_ir_versions_project_id_version_no UNIQUE (project_id, version_no)
);
COMMENT ON TABLE ir_versions IS 'IR 버전 (소유: API 서버)';
COMMENT ON COLUMN ir_versions.id IS 'IR 버전 아이디';
COMMENT ON COLUMN ir_versions.project_id IS '프로젝트 아이디';
COMMENT ON COLUMN ir_versions.source_version_id IS '소스 버전 아이디';
COMMENT ON COLUMN ir_versions.version_no IS '버전 번호';
COMMENT ON COLUMN ir_versions.schema_version IS 'IR 스키마 버전';
COMMENT ON COLUMN ir_versions.spec IS 'IR 명세(YAML)';
COMMENT ON COLUMN ir_versions.origin IS '생성 주체 [agent, user]';
COMMENT ON COLUMN ir_versions.created_by IS '작성자 아이디';
COMMENT ON COLUMN ir_versions.created_at IS '생성 일시';

CREATE TABLE targets (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  owner_id BIGINT NOT NULL,
  name VARCHAR(100) NOT NULL,
  provider VARCHAR(20) NOT NULL CHECK (provider IN ('onprem', 'aws', 'gcp', 'azure')),
  stage VARCHAR(20) NOT NULL DEFAULT 'dev' CHECK (stage IN ('dev', 'staging', 'prod')),
  region VARCHAR(50),
  config JSONB,
  role_identifier_ref VARCHAR(500),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'error', 'deleted')),
  auto_approve_policy VARCHAR(20) NOT NULL DEFAULT 'none' CHECK (auto_approve_policy IN ('none', 'plan_only', 'all')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_targets PRIMARY KEY (id),
  CONSTRAINT uq_targets_owner_id_name UNIQUE (owner_id, name)
);
COMMENT ON TABLE targets IS '대상 환경 (소유: API 서버)';
COMMENT ON COLUMN targets.id IS '대상 환경 아이디';
COMMENT ON COLUMN targets.owner_id IS '소유자 아이디';
COMMENT ON COLUMN targets.name IS '환경명';
COMMENT ON COLUMN targets.provider IS '제공자 [onprem, aws, gcp, azure]';
COMMENT ON COLUMN targets.stage IS '환경 단계 [dev, staging, prod]';
COMMENT ON COLUMN targets.region IS '리전';
COMMENT ON COLUMN targets.config IS '환경 설정';
COMMENT ON COLUMN targets.role_identifier_ref IS '역할 아이디 볼트 참조';
COMMENT ON COLUMN targets.status IS '상태 [pending, active, error, deleted]';
COMMENT ON COLUMN targets.auto_approve_policy IS '자동 승인 정책 [none, plan_only, all]';
COMMENT ON COLUMN targets.created_at IS '생성 일시';
COMMENT ON COLUMN targets.updated_at IS '수정 일시';

CREATE TABLE agent_tokens (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  target_id BIGINT NOT NULL,
  token_hash VARCHAR(255) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_agent_tokens PRIMARY KEY (id),
  CONSTRAINT uq_agent_tokens_token_hash UNIQUE (token_hash)
);
COMMENT ON TABLE agent_tokens IS '에이전트 등록 토큰 (소유: API 서버)';
COMMENT ON COLUMN agent_tokens.id IS '에이전트 등록 토큰 아이디';
COMMENT ON COLUMN agent_tokens.target_id IS '대상 환경 아이디';
COMMENT ON COLUMN agent_tokens.token_hash IS '토큰 해시';
COMMENT ON COLUMN agent_tokens.expires_at IS '만료 일시';
COMMENT ON COLUMN agent_tokens.used_at IS '사용 일시';
COMMENT ON COLUMN agent_tokens.created_by IS '발급자 아이디';
COMMENT ON COLUMN agent_tokens.created_at IS '생성 일시';

CREATE TABLE onprem_agents (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  target_id BIGINT NOT NULL,
  hostname VARCHAR(200),
  os VARCHAR(20) NOT NULL CHECK (os IN ('linux', 'macos', 'windows')),
  arch VARCHAR(20) NOT NULL CHECK (arch IN ('amd64', 'arm64')),
  runtime VARCHAR(20) NOT NULL CHECK (runtime IN ('compose', 'k3s')),
  agent_version VARCHAR(20),
  credential_ref VARCHAR(500) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'online' CHECK (status IN ('online', 'offline', 'revoked')),
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_onprem_agents PRIMARY KEY (id)
);
COMMENT ON TABLE onprem_agents IS '온프레미스 에이전트 (소유: API 서버)';
COMMENT ON COLUMN onprem_agents.id IS '온프레미스 에이전트 아이디';
COMMENT ON COLUMN onprem_agents.target_id IS '대상 환경 아이디';
COMMENT ON COLUMN onprem_agents.hostname IS '호스트명';
COMMENT ON COLUMN onprem_agents.os IS '운영체제 [linux, macos, windows]';
COMMENT ON COLUMN onprem_agents.arch IS 'CPU 아키텍처 [amd64, arm64]';
COMMENT ON COLUMN onprem_agents.runtime IS '실행 런타임 [compose, k3s]';
COMMENT ON COLUMN onprem_agents.agent_version IS '에이전트 버전';
COMMENT ON COLUMN onprem_agents.credential_ref IS '인증 정보 볼트 참조';
COMMENT ON COLUMN onprem_agents.status IS '상태 [online, offline, revoked]';
COMMENT ON COLUMN onprem_agents.last_seen_at IS '마지막 접속 일시';
COMMENT ON COLUMN onprem_agents.created_at IS '생성 일시';

CREATE TABLE secrets (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  project_id BIGINT NOT NULL,
  target_id BIGINT,
  key_name VARCHAR(200) NOT NULL,
  is_secret BOOLEAN NOT NULL DEFAULT true,
  vault_ref VARCHAR(500) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_secrets PRIMARY KEY (id),
  CONSTRAINT uq_secrets_project_id_target_id_key_name UNIQUE NULLS NOT DISTINCT (project_id, target_id, key_name)
);
COMMENT ON TABLE secrets IS '비밀값 메타데이터 (소유: API 서버)';
COMMENT ON COLUMN secrets.id IS '비밀값 메타데이터 아이디';
COMMENT ON COLUMN secrets.project_id IS '프로젝트 아이디';
COMMENT ON COLUMN secrets.target_id IS '대상 환경 아이디';
COMMENT ON COLUMN secrets.key_name IS '변수명';
COMMENT ON COLUMN secrets.is_secret IS '비밀 여부';
COMMENT ON COLUMN secrets.vault_ref IS '볼트 참조';
COMMENT ON COLUMN secrets.created_at IS '생성 일시';
COMMENT ON COLUMN secrets.updated_at IS '수정 일시';

CREATE TABLE pricing_catalog (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  provider VARCHAR(20) NOT NULL CHECK (provider IN ('onprem', 'aws', 'gcp', 'azure')),
  service VARCHAR(100) NOT NULL,
  sku VARCHAR(200) NOT NULL,
  region VARCHAR(50) NOT NULL,
  unit VARCHAR(50) NOT NULL,
  unit_price NUMERIC(14,6) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_pricing_catalog PRIMARY KEY (id),
  CONSTRAINT uq_pricing_catalog_provider_sku_region UNIQUE (provider, sku, region)
);
COMMENT ON TABLE pricing_catalog IS '가격 카탈로그 (소유: 추천·비용 엔진)';
COMMENT ON COLUMN pricing_catalog.id IS '가격 카탈로그 아이디';
COMMENT ON COLUMN pricing_catalog.provider IS '제공자 [onprem, aws, gcp, azure]';
COMMENT ON COLUMN pricing_catalog.service IS '서비스명';
COMMENT ON COLUMN pricing_catalog.sku IS '상품 코드';
COMMENT ON COLUMN pricing_catalog.region IS '리전';
COMMENT ON COLUMN pricing_catalog.unit IS '과금 단위';
COMMENT ON COLUMN pricing_catalog.unit_price IS '단가';
COMMENT ON COLUMN pricing_catalog.currency IS '통화';
COMMENT ON COLUMN pricing_catalog.updated_at IS '수정 일시';

CREATE TABLE recommendations (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  project_id BIGINT NOT NULL,
  ir_version_id BIGINT NOT NULL,
  conditions JSONB,
  explanation TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_recommendations PRIMARY KEY (id)
);
COMMENT ON TABLE recommendations IS '배포 추천 (소유: 추천·비용 엔진)';
COMMENT ON COLUMN recommendations.id IS '배포 추천 아이디';
COMMENT ON COLUMN recommendations.project_id IS '프로젝트 아이디';
COMMENT ON COLUMN recommendations.ir_version_id IS 'IR 버전 아이디';
COMMENT ON COLUMN recommendations.conditions IS '사용자 조건';
COMMENT ON COLUMN recommendations.explanation IS 'AI 근거 설명';
COMMENT ON COLUMN recommendations.created_at IS '생성 일시';

CREATE TABLE recommendation_candidates (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  recommendation_id BIGINT NOT NULL,
  target_id BIGINT,
  rank_no INTEGER NOT NULL,
  provider VARCHAR(20) NOT NULL CHECK (provider IN ('onprem', 'aws', 'gcp', 'azure')),
  compute_type VARCHAR(20) NOT NULL CHECK (compute_type IN ('function', 'container', 'instance')),
  service VARCHAR(100),
  score_cost NUMERIC(14,6),
  score_performance NUMERIC(14,6),
  score_scalability NUMERIC(14,6),
  monthly_cost NUMERIC(14,6),
  currency CHAR(3) DEFAULT 'USD',
  cost_breakdown JSONB,
  rationale TEXT,
  CONSTRAINT pk_recommendation_candidates PRIMARY KEY (id),
  CONSTRAINT uq_recommendation_candidates_recommendation_id_rank_no UNIQUE (recommendation_id, rank_no)
);
COMMENT ON TABLE recommendation_candidates IS '추천 후보 (소유: 추천·비용 엔진)';
COMMENT ON COLUMN recommendation_candidates.id IS '추천 후보 아이디';
COMMENT ON COLUMN recommendation_candidates.recommendation_id IS '추천 아이디';
COMMENT ON COLUMN recommendation_candidates.target_id IS '대상 환경 아이디';
COMMENT ON COLUMN recommendation_candidates.rank_no IS '순위';
COMMENT ON COLUMN recommendation_candidates.provider IS '제공자 [onprem, aws, gcp, azure]';
COMMENT ON COLUMN recommendation_candidates.compute_type IS '배포 형태 [function, container, instance]';
COMMENT ON COLUMN recommendation_candidates.service IS '대상 서비스';
COMMENT ON COLUMN recommendation_candidates.score_cost IS '비용 점수';
COMMENT ON COLUMN recommendation_candidates.score_performance IS '성능 점수';
COMMENT ON COLUMN recommendation_candidates.score_scalability IS '확장성 점수';
COMMENT ON COLUMN recommendation_candidates.monthly_cost IS '월 예상 비용';
COMMENT ON COLUMN recommendation_candidates.currency IS '통화';
COMMENT ON COLUMN recommendation_candidates.cost_breakdown IS '비용 상세';
COMMENT ON COLUMN recommendation_candidates.rationale IS '추천 근거';

CREATE TABLE deployments (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  project_id BIGINT NOT NULL,
  target_id BIGINT,
  source_version_id BIGINT,
  ir_version_id BIGINT,
  pipeline_definition_id BIGINT,
  recommendation_candidate_id BIGINT,
  kind VARCHAR(20) NOT NULL DEFAULT 'deploy' CHECK (kind IN ('deploy', 'rollback', 'cleanup')),
  rollback_of_id BIGINT,
  compute_type VARCHAR(20) CHECK (compute_type IN ('function', 'container', 'instance')),
  strategy VARCHAR(20) NOT NULL DEFAULT 'rolling' CHECK (strategy IN ('recreate', 'rolling', 'bluegreen', 'canary')),
  rollout_config JSONB,
  state VARCHAR(30) NOT NULL DEFAULT 'received' CHECK (state IN ('received', 'queued', 'analyzing', 'awaiting_patch_approval', 'awaiting_target_confirmation', 'building', 'planning', 'awaiting_plan_approval', 'provisioning', 'deploying', 'verifying', 'diagnosing', 'rolling_back', 'succeeded', 'failed', 'cancelled')),
  trigger_source VARCHAR(20) NOT NULL CHECK (trigger_source IN ('cli', 'web', 'ci', 'agent', 'mcp')),
  public_url VARCHAR(500),
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  is_demo_preprovisioned BOOLEAN NOT NULL DEFAULT false,
  requested_by BIGINT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_deployments PRIMARY KEY (id)
);
CREATE INDEX ix_deployments_target_id_state ON deployments (target_id, state);
CREATE INDEX ix_deployments_project_id_created_at ON deployments (project_id, created_at);
COMMENT ON TABLE deployments IS '배포 (소유: 오케스트레이터)';
COMMENT ON COLUMN deployments.id IS '배포 아이디';
COMMENT ON COLUMN deployments.project_id IS '프로젝트 아이디';
COMMENT ON COLUMN deployments.target_id IS '대상 환경 아이디';
COMMENT ON COLUMN deployments.source_version_id IS '소스 버전 아이디';
COMMENT ON COLUMN deployments.ir_version_id IS 'IR 버전 아이디';
COMMENT ON COLUMN deployments.pipeline_definition_id IS '파이프라인 정의 아이디';
COMMENT ON COLUMN deployments.recommendation_candidate_id IS '선택 추천 후보 아이디';
COMMENT ON COLUMN deployments.kind IS '배포 종류 [deploy, rollback, cleanup]';
COMMENT ON COLUMN deployments.rollback_of_id IS '롤백 대상 배포 아이디';
COMMENT ON COLUMN deployments.compute_type IS '배포 형태 [function, container, instance]';
COMMENT ON COLUMN deployments.strategy IS '배포 전략 [recreate, rolling, bluegreen, canary]';
COMMENT ON COLUMN deployments.rollout_config IS '롤아웃 설정';
COMMENT ON COLUMN deployments.state IS '상태 [received, queued, analyzing, awaiting_patch_approval, awaiting_target_confirmation, building, planning, awaiting_plan_approval, provisioning, deploying, verifying, diagnosing, rolling_back, succeeded, failed, cancelled]';
COMMENT ON COLUMN deployments.trigger_source IS '요청 경로 [cli, web, ci, agent, mcp]';
COMMENT ON COLUMN deployments.public_url IS '공개 URL';
COMMENT ON COLUMN deployments.retry_count IS '재시도 횟수';
COMMENT ON COLUMN deployments.max_retries IS '최대 재시도 횟수';
COMMENT ON COLUMN deployments.is_demo_preprovisioned IS '사전 프로비저닝 여부';
COMMENT ON COLUMN deployments.requested_by IS '요청자 아이디';
COMMENT ON COLUMN deployments.started_at IS '시작 일시';
COMMENT ON COLUMN deployments.finished_at IS '종료 일시';
COMMENT ON COLUMN deployments.created_at IS '생성 일시';
COMMENT ON COLUMN deployments.updated_at IS '수정 일시';

CREATE TABLE deployment_steps (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  deployment_id BIGINT NOT NULL,
  step VARCHAR(30) NOT NULL CHECK (step IN ('analyze', 'patch', 'recommend', 'build', 'plan', 'provision', 'migrate', 'rollout', 'verify', 'diagnose', 'rollback', 'cleanup', 'custom')),
  custom_name VARCHAR(100),
  attempt INTEGER NOT NULL DEFAULT 1,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  log_storage_key VARCHAR(500),
  error_message TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  CONSTRAINT pk_deployment_steps PRIMARY KEY (id),
  CONSTRAINT uq_deployment_steps_id_deployment_id UNIQUE (id, deployment_id)
);
CREATE INDEX ix_deployment_steps_deployment_id_step ON deployment_steps (deployment_id, step);
COMMENT ON TABLE deployment_steps IS '배포 단계 (소유: 오케스트레이터)';
COMMENT ON COLUMN deployment_steps.id IS '배포 단계 아이디';
COMMENT ON COLUMN deployment_steps.deployment_id IS '배포 아이디';
COMMENT ON COLUMN deployment_steps.step IS '단계 [analyze, patch, recommend, build, plan, provision, migrate, rollout, verify, diagnose, rollback, cleanup, custom]';
COMMENT ON COLUMN deployment_steps.custom_name IS '커스텀 단계명';
COMMENT ON COLUMN deployment_steps.attempt IS '시도 차수';
COMMENT ON COLUMN deployment_steps.status IS '상태 [pending, running, succeeded, failed, skipped]';
COMMENT ON COLUMN deployment_steps.log_storage_key IS '로그 저장소 키';
COMMENT ON COLUMN deployment_steps.error_message IS '오류 메시지';
COMMENT ON COLUMN deployment_steps.started_at IS '시작 일시';
COMMENT ON COLUMN deployment_steps.ended_at IS '종료 일시';

CREATE TABLE approvals (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  deployment_id BIGINT NOT NULL,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('patch', 'target', 'plan', 'rollback', 'cleanup')),
  decision VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'approved', 'rejected', 'expired')),
  comment TEXT,
  decided_by BIGINT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  decided_at TIMESTAMPTZ,
  CONSTRAINT pk_approvals PRIMARY KEY (id)
);
COMMENT ON TABLE approvals IS '승인 (소유: 오케스트레이터)';
COMMENT ON COLUMN approvals.id IS '승인 아이디';
COMMENT ON COLUMN approvals.deployment_id IS '배포 아이디';
COMMENT ON COLUMN approvals.kind IS '승인 대상 [patch, target, plan, rollback, cleanup]';
COMMENT ON COLUMN approvals.decision IS '결정 [pending, approved, rejected, expired]';
COMMENT ON COLUMN approvals.comment IS '의견';
COMMENT ON COLUMN approvals.decided_by IS '결정자 아이디';
COMMENT ON COLUMN approvals.requested_at IS '요청 일시';
COMMENT ON COLUMN approvals.expires_at IS '만료 일시';
COMMENT ON COLUMN approvals.decided_at IS '결정 일시';

CREATE TABLE env_locks (
  target_id BIGINT NOT NULL,
  deployment_id BIGINT NOT NULL,
  holder_instance VARCHAR(100),
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT pk_env_locks PRIMARY KEY (target_id),
  CONSTRAINT uq_env_locks_deployment_id UNIQUE (deployment_id)
);
COMMENT ON TABLE env_locks IS '환경 락 (소유: 오케스트레이터)';
COMMENT ON COLUMN env_locks.target_id IS '대상 환경 아이디';
COMMENT ON COLUMN env_locks.deployment_id IS '배포 아이디';
COMMENT ON COLUMN env_locks.holder_instance IS '보유 인스턴스';
COMMENT ON COLUMN env_locks.acquired_at IS '획득 일시';
COMMENT ON COLUMN env_locks.lease_expires_at IS '임대 만료 일시';

CREATE TABLE jobs (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  deployment_id BIGINT NOT NULL,
  step_id BIGINT,
  job_type VARCHAR(30) NOT NULL CHECK (job_type IN ('analyze', 'build', 'plan', 'provision', 'verify', 'onprem_apply', 'obs_query', 'cleanup')),
  payload JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead')),
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by VARCHAR(100),
  locked_until TIMESTAMPTZ,
  result JSONB,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_jobs PRIMARY KEY (id)
);
CREATE INDEX ix_jobs_status_run_after ON jobs (status, run_after);
COMMENT ON TABLE jobs IS '작업 큐 (소유: 오케스트레이터)';
COMMENT ON COLUMN jobs.id IS '작업 큐 아이디';
COMMENT ON COLUMN jobs.deployment_id IS '배포 아이디';
COMMENT ON COLUMN jobs.step_id IS '배포 단계 아이디';
COMMENT ON COLUMN jobs.job_type IS '작업 유형 [analyze, build, plan, provision, verify, onprem_apply, obs_query, cleanup]';
COMMENT ON COLUMN jobs.payload IS '작업 입력';
COMMENT ON COLUMN jobs.status IS '상태 [queued, running, succeeded, failed, dead]';
COMMENT ON COLUMN jobs.attempt IS '시도 횟수';
COMMENT ON COLUMN jobs.max_attempts IS '최대 시도 횟수';
COMMENT ON COLUMN jobs.run_after IS '실행 가능 일시';
COMMENT ON COLUMN jobs.locked_by IS '처리 워커';
COMMENT ON COLUMN jobs.locked_until IS '임대 만료 일시';
COMMENT ON COLUMN jobs.result IS '작업 결과';
COMMENT ON COLUMN jobs.last_error IS '마지막 오류';
COMMENT ON COLUMN jobs.created_at IS '생성 일시';
COMMENT ON COLUMN jobs.updated_at IS '수정 일시';

CREATE TABLE patches (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  deployment_id BIGINT NOT NULL,
  goal VARCHAR(40) NOT NULL CHECK (goal IN ('sqlite_to_postgres', 'externalize_config', 'add_healthcheck', 'add_otel', 'dockerfile', 'fix', 'other')),
  summary TEXT,
  diff_storage_key VARCHAR(500) NOT NULL,
  result_source_version_id BIGINT,
  status VARCHAR(20) NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected', 'applied')),
  verification_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'passed', 'failed', 'skipped')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_patches PRIMARY KEY (id),
  CONSTRAINT uq_patches_id_deployment_id UNIQUE (id, deployment_id)
);
COMMENT ON TABLE patches IS '코드 패치 (소유: AI 에이전트)';
COMMENT ON COLUMN patches.id IS '코드 패치 아이디';
COMMENT ON COLUMN patches.deployment_id IS '배포 아이디';
COMMENT ON COLUMN patches.goal IS '수정 목적 [sqlite_to_postgres, externalize_config, add_healthcheck, add_otel, dockerfile, fix, other]';
COMMENT ON COLUMN patches.summary IS '변경 요약';
COMMENT ON COLUMN patches.diff_storage_key IS 'diff 저장소 키';
COMMENT ON COLUMN patches.result_source_version_id IS '적용 결과 소스 버전 아이디';
COMMENT ON COLUMN patches.status IS '상태 [proposed, approved, rejected, applied]';
COMMENT ON COLUMN patches.verification_status IS '검증 상태 [pending, passed, failed, skipped]';
COMMENT ON COLUMN patches.created_at IS '생성 일시';

CREATE TABLE build_artifacts (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  deployment_id BIGINT NOT NULL,
  source_version_id BIGINT NOT NULL,
  service_name VARCHAR(100) NOT NULL,
  registry VARCHAR(200) NOT NULL,
  image_repo VARCHAR(300) NOT NULL,
  image_tag VARCHAR(200) NOT NULL,
  image_digest VARCHAR(100),
  platforms VARCHAR(100),
  builder VARCHAR(20) NOT NULL CHECK (builder IN ('dockerfile', 'railpack', 'buildpacks')),
  cache_hit BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_build_artifacts PRIMARY KEY (id)
);
COMMENT ON TABLE build_artifacts IS '빌드 산출물 (소유: 빌드 워커)';
COMMENT ON COLUMN build_artifacts.id IS '빌드 산출물 아이디';
COMMENT ON COLUMN build_artifacts.deployment_id IS '배포 아이디';
COMMENT ON COLUMN build_artifacts.source_version_id IS '빌드 소스 버전 아이디';
COMMENT ON COLUMN build_artifacts.service_name IS '서비스명';
COMMENT ON COLUMN build_artifacts.registry IS '레지스트리';
COMMENT ON COLUMN build_artifacts.image_repo IS '이미지 저장소';
COMMENT ON COLUMN build_artifacts.image_tag IS '이미지 태그';
COMMENT ON COLUMN build_artifacts.image_digest IS '이미지 다이제스트';
COMMENT ON COLUMN build_artifacts.platforms IS '빌드 플랫폼';
COMMENT ON COLUMN build_artifacts.builder IS '빌드 방식 [dockerfile, railpack, buildpacks]';
COMMENT ON COLUMN build_artifacts.cache_hit IS '캐시 사용 여부';
COMMENT ON COLUMN build_artifacts.created_at IS '생성 일시';

CREATE TABLE infra_plans (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  deployment_id BIGINT NOT NULL,
  adapter VARCHAR(20) NOT NULL CHECK (adapter IN ('onprem', 'aws', 'gcp', 'azure')),
  iac_engine VARCHAR(20) NOT NULL CHECK (iac_engine IN ('pulumi', 'terraform', 'compose', 'k3s')),
  create_count INTEGER NOT NULL DEFAULT 0,
  update_count INTEGER NOT NULL DEFAULT 0,
  delete_count INTEGER NOT NULL DEFAULT 0,
  plan_storage_key VARCHAR(500) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_infra_plans PRIMARY KEY (id)
);
COMMENT ON TABLE infra_plans IS '인프라 플랜 (소유: 프로비저닝 워커)';
COMMENT ON COLUMN infra_plans.id IS '인프라 플랜 아이디';
COMMENT ON COLUMN infra_plans.deployment_id IS '배포 아이디';
COMMENT ON COLUMN infra_plans.adapter IS '어댑터 [onprem, aws, gcp, azure]';
COMMENT ON COLUMN infra_plans.iac_engine IS 'IaC 엔진 [pulumi, terraform, compose, k3s]';
COMMENT ON COLUMN infra_plans.create_count IS '생성 개수';
COMMENT ON COLUMN infra_plans.update_count IS '변경 개수';
COMMENT ON COLUMN infra_plans.delete_count IS '삭제 개수';
COMMENT ON COLUMN infra_plans.plan_storage_key IS '플랜 저장소 키';
COMMENT ON COLUMN infra_plans.created_at IS '생성 일시';

CREATE TABLE provisioned_resources (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  iac_stack_id BIGINT NOT NULL,
  target_id BIGINT NOT NULL,
  last_deployment_id BIGINT,
  resource_type VARCHAR(100) NOT NULL,
  resource_name VARCHAR(200) NOT NULL,
  provider_resource_id VARCHAR(500),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleting', 'deleted', 'error')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT pk_provisioned_resources PRIMARY KEY (id)
);
CREATE INDEX ix_provisioned_resources_target_id_status ON provisioned_resources (target_id, status);
COMMENT ON TABLE provisioned_resources IS '생성 리소스 (소유: 프로비저닝 워커)';
COMMENT ON COLUMN provisioned_resources.id IS '생성 리소스 아이디';
COMMENT ON COLUMN provisioned_resources.iac_stack_id IS 'IaC 스택 아이디';
COMMENT ON COLUMN provisioned_resources.target_id IS '대상 환경 아이디';
COMMENT ON COLUMN provisioned_resources.last_deployment_id IS '마지막 변경 배포 아이디';
COMMENT ON COLUMN provisioned_resources.resource_type IS '리소스 유형';
COMMENT ON COLUMN provisioned_resources.resource_name IS '리소스명';
COMMENT ON COLUMN provisioned_resources.provider_resource_id IS '제공자 리소스 ID';
COMMENT ON COLUMN provisioned_resources.status IS '상태 [active, deleting, deleted, error]';
COMMENT ON COLUMN provisioned_resources.created_at IS '생성 일시';
COMMENT ON COLUMN provisioned_resources.deleted_at IS '삭제 일시';

CREATE TABLE db_migrations (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  deployment_id BIGINT NOT NULL,
  tool VARCHAR(30) CHECK (tool IN ('prisma', 'rails', 'flyway', 'liquibase', 'alembic', 'other')),
  source_engine VARCHAR(20) CHECK (source_engine IN ('sqlite', 'postgres', 'mysql', 'none')),
  target_engine VARCHAR(20) NOT NULL CHECK (target_engine IN ('postgres', 'mysql')),
  schema_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (schema_status IN ('pending', 'succeeded', 'failed')),
  data_transfer BOOLEAN NOT NULL DEFAULT false,
  source_row_count BIGINT,
  target_row_count BIGINT,
  verified BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_db_migrations PRIMARY KEY (id)
);
COMMENT ON TABLE db_migrations IS 'DB 마이그레이션 (소유: 프로비저닝 워커)';
COMMENT ON COLUMN db_migrations.id IS 'DB 마이그레이션 아이디';
COMMENT ON COLUMN db_migrations.deployment_id IS '배포 아이디';
COMMENT ON COLUMN db_migrations.tool IS '마이그레이션 도구 [prisma, rails, flyway, liquibase, alembic, other]';
COMMENT ON COLUMN db_migrations.source_engine IS '원본 DB 엔진 [sqlite, postgres, mysql, none]';
COMMENT ON COLUMN db_migrations.target_engine IS '대상 DB 엔진 [postgres, mysql]';
COMMENT ON COLUMN db_migrations.schema_status IS '스키마 적용 상태 [pending, succeeded, failed]';
COMMENT ON COLUMN db_migrations.data_transfer IS '데이터 이전 여부';
COMMENT ON COLUMN db_migrations.source_row_count IS '원본 행 수';
COMMENT ON COLUMN db_migrations.target_row_count IS '대상 행 수';
COMMENT ON COLUMN db_migrations.verified IS '검증 통과 여부';
COMMENT ON COLUMN db_migrations.created_at IS '생성 일시';

CREATE TABLE verifications (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  deployment_id BIGINT NOT NULL,
  patch_id BIGINT,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('patch_test', 'healthcheck', 'smoke', 'canary_analysis', 'load_test')),
  status VARCHAR(20) NOT NULL CHECK (status IN ('passed', 'failed')),
  metrics JSONB,
  report_storage_key VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_verifications PRIMARY KEY (id)
);
COMMENT ON TABLE verifications IS '검증 결과 (소유: 검증 워커)';
COMMENT ON COLUMN verifications.id IS '검증 결과 아이디';
COMMENT ON COLUMN verifications.deployment_id IS '배포 아이디';
COMMENT ON COLUMN verifications.patch_id IS '코드 패치 아이디';
COMMENT ON COLUMN verifications.kind IS '검증 종류 [patch_test, healthcheck, smoke, canary_analysis, load_test]';
COMMENT ON COLUMN verifications.status IS '결과 [passed, failed]';
COMMENT ON COLUMN verifications.metrics IS '측정 지표';
COMMENT ON COLUMN verifications.report_storage_key IS '리포트 저장소 키';
COMMENT ON COLUMN verifications.created_at IS '생성 일시';

CREATE TABLE diagnoses (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  deployment_id BIGINT NOT NULL,
  failed_step_id BIGINT,
  root_cause TEXT NOT NULL,
  evidence JSONB,
  suggested_patch_id BIGINT,
  outcome VARCHAR(20) CHECK (outcome IN ('retried', 'rolled_back', 'dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_diagnoses PRIMARY KEY (id)
);
COMMENT ON TABLE diagnoses IS '실패 진단 (소유: AI 에이전트)';
COMMENT ON COLUMN diagnoses.id IS '실패 진단 아이디';
COMMENT ON COLUMN diagnoses.deployment_id IS '배포 아이디';
COMMENT ON COLUMN diagnoses.failed_step_id IS '실패 단계 아이디';
COMMENT ON COLUMN diagnoses.root_cause IS '추정 원인';
COMMENT ON COLUMN diagnoses.evidence IS '근거 로그·지표';
COMMENT ON COLUMN diagnoses.suggested_patch_id IS '제안 패치 아이디';
COMMENT ON COLUMN diagnoses.outcome IS '조치 결과 [retried, rolled_back, dismissed]';
COMMENT ON COLUMN diagnoses.created_at IS '생성 일시';

CREATE TABLE ai_usage (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  deployment_id BIGINT,
  agent_run_id BIGINT,
  purpose VARCHAR(20) NOT NULL CHECK (purpose IN ('analyze', 'patch', 'ir', 'explain', 'diagnose', 'ci_workflow', 'chat')),
  model VARCHAR(100) NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(14,6) NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  cache_hit BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_ai_usage PRIMARY KEY (id)
);
CREATE INDEX ix_ai_usage_created_at ON ai_usage (created_at);
COMMENT ON TABLE ai_usage IS 'AI 사용량 (소유: AI 에이전트)';
COMMENT ON COLUMN ai_usage.id IS 'AI 사용량 아이디';
COMMENT ON COLUMN ai_usage.deployment_id IS '배포 아이디';
COMMENT ON COLUMN ai_usage.agent_run_id IS '에이전트 실행 아이디';
COMMENT ON COLUMN ai_usage.purpose IS '사용 목적 [analyze, patch, ir, explain, diagnose, ci_workflow, chat]';
COMMENT ON COLUMN ai_usage.model IS '모델명';
COMMENT ON COLUMN ai_usage.tokens_in IS '입력 토큰 수';
COMMENT ON COLUMN ai_usage.tokens_out IS '출력 토큰 수';
COMMENT ON COLUMN ai_usage.cost_usd IS '비용(USD)';
COMMENT ON COLUMN ai_usage.latency_ms IS '응답 시간(ms)';
COMMENT ON COLUMN ai_usage.cache_hit IS '캐시 사용 여부';
COMMENT ON COLUMN ai_usage.created_at IS '생성 일시';

CREATE TABLE audit_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  actor_type VARCHAR(20) NOT NULL CHECK (actor_type IN ('user', 'agent', 'system', 'ci')),
  actor_id VARCHAR(100),
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(50) NOT NULL,
  resource_id VARCHAR(100),
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_audit_logs PRIMARY KEY (id)
);
CREATE INDEX ix_audit_logs_resource_type_resource_id ON audit_logs (resource_type, resource_id);
CREATE INDEX ix_audit_logs_created_at ON audit_logs (created_at);
COMMENT ON TABLE audit_logs IS '감사 로그 (소유: API 서버)';
COMMENT ON COLUMN audit_logs.id IS '감사 로그 아이디';
COMMENT ON COLUMN audit_logs.actor_type IS '행위자 유형 [user, agent, system, ci]';
COMMENT ON COLUMN audit_logs.actor_id IS '행위자 아이디';
COMMENT ON COLUMN audit_logs.action IS '행위';
COMMENT ON COLUMN audit_logs.resource_type IS '대상 리소스 유형';
COMMENT ON COLUMN audit_logs.resource_id IS '대상 리소스 아이디';
COMMENT ON COLUMN audit_logs.detail IS '상세';
COMMENT ON COLUMN audit_logs.created_at IS '생성 일시';

CREATE TABLE deployment_services (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  deployment_id BIGINT NOT NULL,
  service_name VARCHAR(100) NOT NULL,
  deploy_order INTEGER NOT NULL DEFAULT 1,
  build_artifact_id BIGINT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'deploying', 'healthy', 'failed', 'rolled_back')),
  traffic_percent INTEGER NOT NULL DEFAULT 0,
  public_url VARCHAR(500),
  internal_endpoint VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_deployment_services PRIMARY KEY (id),
  CONSTRAINT uq_deployment_services_deployment_id_service_name UNIQUE (deployment_id, service_name)
);
COMMENT ON TABLE deployment_services IS '배포 서비스 (소유: 오케스트레이터)';
COMMENT ON COLUMN deployment_services.id IS '배포 서비스 아이디';
COMMENT ON COLUMN deployment_services.deployment_id IS '배포 아이디';
COMMENT ON COLUMN deployment_services.service_name IS '서비스명';
COMMENT ON COLUMN deployment_services.deploy_order IS '배포 순서';
COMMENT ON COLUMN deployment_services.build_artifact_id IS '빌드 산출물 아이디';
COMMENT ON COLUMN deployment_services.status IS '상태 [pending, deploying, healthy, failed, rolled_back]';
COMMENT ON COLUMN deployment_services.traffic_percent IS '새 버전 트래픽 비율';
COMMENT ON COLUMN deployment_services.public_url IS '공개 URL';
COMMENT ON COLUMN deployment_services.internal_endpoint IS '내부 접속 주소';
COMMENT ON COLUMN deployment_services.created_at IS '생성 일시';
COMMENT ON COLUMN deployment_services.updated_at IS '수정 일시';

CREATE TABLE iac_stacks (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  project_id BIGINT NOT NULL,
  target_id BIGINT NOT NULL,
  engine VARCHAR(20) NOT NULL CHECK (engine IN ('pulumi', 'terraform', 'compose', 'k3s')),
  stack_name VARCHAR(200) NOT NULL,
  state_ref VARCHAR(500) NOT NULL,
  last_applied_deployment_id BIGINT,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'destroying', 'destroyed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_iac_stacks PRIMARY KEY (id),
  CONSTRAINT uq_iac_stacks_project_id_target_id UNIQUE (project_id, target_id)
);
COMMENT ON TABLE iac_stacks IS 'IaC 스택 (소유: 프로비저닝 워커)';
COMMENT ON COLUMN iac_stacks.id IS 'IaC 스택 아이디';
COMMENT ON COLUMN iac_stacks.project_id IS '프로젝트 아이디';
COMMENT ON COLUMN iac_stacks.target_id IS '대상 환경 아이디';
COMMENT ON COLUMN iac_stacks.engine IS 'IaC 엔진 [pulumi, terraform, compose, k3s]';
COMMENT ON COLUMN iac_stacks.stack_name IS '스택명';
COMMENT ON COLUMN iac_stacks.state_ref IS 'state 저장 위치';
COMMENT ON COLUMN iac_stacks.last_applied_deployment_id IS '마지막 적용 배포 아이디';
COMMENT ON COLUMN iac_stacks.status IS '상태 [active, destroying, destroyed]';
COMMENT ON COLUMN iac_stacks.created_at IS '생성 일시';
COMMENT ON COLUMN iac_stacks.updated_at IS '수정 일시';

CREATE TABLE ci_triggers (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  project_id BIGINT NOT NULL,
  target_id BIGINT NOT NULL,
  pipeline_definition_id BIGINT,
  repo_url VARCHAR(500) NOT NULL,
  branch VARCHAR(200) NOT NULL,
  webhook_secret_ref VARCHAR(500) NOT NULL,
  auto_deploy BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_ci_triggers PRIMARY KEY (id),
  CONSTRAINT uq_ci_triggers_project_id_repo_url_branch_target_id UNIQUE (project_id, repo_url, branch, target_id)
);
COMMENT ON TABLE ci_triggers IS 'CI 트리거 (소유: API 서버)';
COMMENT ON COLUMN ci_triggers.id IS 'CI 트리거 아이디';
COMMENT ON COLUMN ci_triggers.project_id IS '프로젝트 아이디';
COMMENT ON COLUMN ci_triggers.target_id IS '대상 환경 아이디';
COMMENT ON COLUMN ci_triggers.pipeline_definition_id IS '파이프라인 정의 아이디';
COMMENT ON COLUMN ci_triggers.repo_url IS '저장소 URL';
COMMENT ON COLUMN ci_triggers.branch IS '브랜치';
COMMENT ON COLUMN ci_triggers.webhook_secret_ref IS '웹훅 비밀값 볼트 참조';
COMMENT ON COLUMN ci_triggers.auto_deploy IS '자동 배포 여부';
COMMENT ON COLUMN ci_triggers.created_by IS '작성자 아이디';
COMMENT ON COLUMN ci_triggers.created_at IS '생성 일시';
COMMENT ON COLUMN ci_triggers.updated_at IS '수정 일시';

CREATE TABLE agent_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  deployment_id BIGINT,
  trigger_source VARCHAR(20) NOT NULL CHECK (trigger_source IN ('orchestrator', 'user', 'mcp')),
  goal TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'waiting_approval', 'succeeded', 'failed', 'cancelled')),
  summary TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  CONSTRAINT pk_agent_runs PRIMARY KEY (id)
);
COMMENT ON TABLE agent_runs IS '에이전트 실행 (소유: AI 에이전트)';
COMMENT ON COLUMN agent_runs.id IS '에이전트 실행 아이디';
COMMENT ON COLUMN agent_runs.deployment_id IS '배포 아이디';
COMMENT ON COLUMN agent_runs.trigger_source IS '실행 주체 [orchestrator, user, mcp]';
COMMENT ON COLUMN agent_runs.goal IS '목표';
COMMENT ON COLUMN agent_runs.status IS '상태 [running, waiting_approval, succeeded, failed, cancelled]';
COMMENT ON COLUMN agent_runs.summary IS '결과 요약';
COMMENT ON COLUMN agent_runs.started_at IS '시작 일시';
COMMENT ON COLUMN agent_runs.ended_at IS '종료 일시';

CREATE TABLE agent_tool_calls (
  id BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  agent_run_id BIGINT NOT NULL,
  seq INTEGER NOT NULL,
  tool_name VARCHAR(50) NOT NULL,
  input JSONB,
  output_summary TEXT,
  requires_approval BOOLEAN NOT NULL DEFAULT false,
  approval_id BIGINT,
  status VARCHAR(20) NOT NULL CHECK (status IN ('succeeded', 'failed', 'blocked', 'pending_approval')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_agent_tool_calls PRIMARY KEY (id),
  CONSTRAINT uq_agent_tool_calls_agent_run_id_seq UNIQUE (agent_run_id, seq)
);
COMMENT ON TABLE agent_tool_calls IS '에이전트 도구 호출 (소유: AI 에이전트)';
COMMENT ON COLUMN agent_tool_calls.id IS '에이전트 도구 호출 아이디';
COMMENT ON COLUMN agent_tool_calls.agent_run_id IS '에이전트 실행 아이디';
COMMENT ON COLUMN agent_tool_calls.seq IS '호출 순번';
COMMENT ON COLUMN agent_tool_calls.tool_name IS '도구명';
COMMENT ON COLUMN agent_tool_calls.input IS '입력';
COMMENT ON COLUMN agent_tool_calls.output_summary IS '결과 요약';
COMMENT ON COLUMN agent_tool_calls.requires_approval IS '승인 필요 여부';
COMMENT ON COLUMN agent_tool_calls.approval_id IS '승인 아이디';
COMMENT ON COLUMN agent_tool_calls.status IS '상태 [succeeded, failed, blocked, pending_approval]';
COMMENT ON COLUMN agent_tool_calls.created_at IS '생성 일시';

-- 관계 (외래 키)
ALTER TABLE api_tokens ADD CONSTRAINT fk_api_tokens_user_id FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE projects ADD CONSTRAINT fk_projects_owner_id FOREIGN KEY (owner_id) REFERENCES users (id);
ALTER TABLE source_versions ADD CONSTRAINT fk_source_versions_project_id FOREIGN KEY (project_id) REFERENCES projects (id);
ALTER TABLE source_versions ADD CONSTRAINT fk_source_versions_uploaded_by FOREIGN KEY (uploaded_by) REFERENCES users (id);
ALTER TABLE source_versions ADD CONSTRAINT fk_source_versions_parent_version_id FOREIGN KEY (parent_version_id) REFERENCES source_versions (id);
ALTER TABLE analysis_reports ADD CONSTRAINT fk_analysis_reports_source_version_id FOREIGN KEY (source_version_id) REFERENCES source_versions (id);
ALTER TABLE pipeline_definitions ADD CONSTRAINT fk_pipeline_definitions_project_id FOREIGN KEY (project_id) REFERENCES projects (id);
ALTER TABLE pipeline_definitions ADD CONSTRAINT fk_pipeline_definitions_created_by FOREIGN KEY (created_by) REFERENCES users (id);
ALTER TABLE ir_versions ADD CONSTRAINT fk_ir_versions_project_id FOREIGN KEY (project_id) REFERENCES projects (id);
ALTER TABLE ir_versions ADD CONSTRAINT fk_ir_versions_source_version_id FOREIGN KEY (source_version_id) REFERENCES source_versions (id);
ALTER TABLE ir_versions ADD CONSTRAINT fk_ir_versions_created_by FOREIGN KEY (created_by) REFERENCES users (id);
ALTER TABLE targets ADD CONSTRAINT fk_targets_owner_id FOREIGN KEY (owner_id) REFERENCES users (id);
ALTER TABLE agent_tokens ADD CONSTRAINT fk_agent_tokens_target_id FOREIGN KEY (target_id) REFERENCES targets (id);
ALTER TABLE agent_tokens ADD CONSTRAINT fk_agent_tokens_created_by FOREIGN KEY (created_by) REFERENCES users (id);
ALTER TABLE onprem_agents ADD CONSTRAINT fk_onprem_agents_target_id FOREIGN KEY (target_id) REFERENCES targets (id);
ALTER TABLE secrets ADD CONSTRAINT fk_secrets_project_id FOREIGN KEY (project_id) REFERENCES projects (id);
ALTER TABLE secrets ADD CONSTRAINT fk_secrets_target_id FOREIGN KEY (target_id) REFERENCES targets (id);
ALTER TABLE recommendations ADD CONSTRAINT fk_recommendations_project_id FOREIGN KEY (project_id) REFERENCES projects (id);
ALTER TABLE recommendations ADD CONSTRAINT fk_recommendations_ir_version_id FOREIGN KEY (ir_version_id) REFERENCES ir_versions (id);
ALTER TABLE recommendation_candidates ADD CONSTRAINT fk_recommendation_candidates_recommendation_id FOREIGN KEY (recommendation_id) REFERENCES recommendations (id);
ALTER TABLE recommendation_candidates ADD CONSTRAINT fk_recommendation_candidates_target_id FOREIGN KEY (target_id) REFERENCES targets (id);
ALTER TABLE deployments ADD CONSTRAINT fk_deployments_project_id FOREIGN KEY (project_id) REFERENCES projects (id);
ALTER TABLE deployments ADD CONSTRAINT fk_deployments_target_id FOREIGN KEY (target_id) REFERENCES targets (id);
ALTER TABLE deployments ADD CONSTRAINT fk_deployments_source_version_id FOREIGN KEY (source_version_id) REFERENCES source_versions (id);
ALTER TABLE deployments ADD CONSTRAINT fk_deployments_ir_version_id FOREIGN KEY (ir_version_id) REFERENCES ir_versions (id);
ALTER TABLE deployments ADD CONSTRAINT fk_deployments_pipeline_definition_id FOREIGN KEY (pipeline_definition_id) REFERENCES pipeline_definitions (id);
ALTER TABLE deployments ADD CONSTRAINT fk_deployments_recommendation_candidate_id FOREIGN KEY (recommendation_candidate_id) REFERENCES recommendation_candidates (id);
ALTER TABLE deployments ADD CONSTRAINT fk_deployments_rollback_of_id FOREIGN KEY (rollback_of_id) REFERENCES deployments (id);
ALTER TABLE deployments ADD CONSTRAINT fk_deployments_requested_by FOREIGN KEY (requested_by) REFERENCES users (id);
ALTER TABLE deployment_steps ADD CONSTRAINT fk_deployment_steps_deployment_id FOREIGN KEY (deployment_id) REFERENCES deployments (id);
ALTER TABLE approvals ADD CONSTRAINT fk_approvals_deployment_id FOREIGN KEY (deployment_id) REFERENCES deployments (id);
ALTER TABLE approvals ADD CONSTRAINT fk_approvals_decided_by FOREIGN KEY (decided_by) REFERENCES users (id);
ALTER TABLE env_locks ADD CONSTRAINT fk_env_locks_target_id FOREIGN KEY (target_id) REFERENCES targets (id);
ALTER TABLE env_locks ADD CONSTRAINT fk_env_locks_deployment_id FOREIGN KEY (deployment_id) REFERENCES deployments (id);
ALTER TABLE jobs ADD CONSTRAINT fk_jobs_deployment_id FOREIGN KEY (deployment_id) REFERENCES deployments (id);
ALTER TABLE jobs ADD CONSTRAINT fk_jobs_step_id FOREIGN KEY (step_id) REFERENCES deployment_steps (id);
ALTER TABLE patches ADD CONSTRAINT fk_patches_deployment_id FOREIGN KEY (deployment_id) REFERENCES deployments (id);
ALTER TABLE patches ADD CONSTRAINT fk_patches_result_source_version_id FOREIGN KEY (result_source_version_id) REFERENCES source_versions (id);
ALTER TABLE build_artifacts ADD CONSTRAINT fk_build_artifacts_deployment_id FOREIGN KEY (deployment_id) REFERENCES deployments (id);
ALTER TABLE build_artifacts ADD CONSTRAINT fk_build_artifacts_source_version_id FOREIGN KEY (source_version_id) REFERENCES source_versions (id);
ALTER TABLE infra_plans ADD CONSTRAINT fk_infra_plans_deployment_id FOREIGN KEY (deployment_id) REFERENCES deployments (id);
ALTER TABLE provisioned_resources ADD CONSTRAINT fk_provisioned_resources_iac_stack_id FOREIGN KEY (iac_stack_id) REFERENCES iac_stacks (id);
ALTER TABLE provisioned_resources ADD CONSTRAINT fk_provisioned_resources_target_id FOREIGN KEY (target_id) REFERENCES targets (id);
ALTER TABLE provisioned_resources ADD CONSTRAINT fk_provisioned_resources_last_deployment_id FOREIGN KEY (last_deployment_id) REFERENCES deployments (id);
ALTER TABLE db_migrations ADD CONSTRAINT fk_db_migrations_deployment_id FOREIGN KEY (deployment_id) REFERENCES deployments (id);
ALTER TABLE verifications ADD CONSTRAINT fk_verifications_deployment_id FOREIGN KEY (deployment_id) REFERENCES deployments (id);
ALTER TABLE verifications ADD CONSTRAINT fk_verifications_patch_id FOREIGN KEY (patch_id) REFERENCES patches (id);
ALTER TABLE diagnoses ADD CONSTRAINT fk_diagnoses_deployment_id FOREIGN KEY (deployment_id) REFERENCES deployments (id);
ALTER TABLE diagnoses ADD CONSTRAINT fk_diagnoses_failed_step_id FOREIGN KEY (failed_step_id) REFERENCES deployment_steps (id);
ALTER TABLE diagnoses ADD CONSTRAINT fk_diagnoses_suggested_patch_id FOREIGN KEY (suggested_patch_id) REFERENCES patches (id);
ALTER TABLE ai_usage ADD CONSTRAINT fk_ai_usage_deployment_id FOREIGN KEY (deployment_id) REFERENCES deployments (id);
ALTER TABLE ai_usage ADD CONSTRAINT fk_ai_usage_agent_run_id FOREIGN KEY (agent_run_id) REFERENCES agent_runs (id);
ALTER TABLE deployment_services ADD CONSTRAINT fk_deployment_services_deployment_id FOREIGN KEY (deployment_id) REFERENCES deployments (id);
ALTER TABLE deployment_services ADD CONSTRAINT fk_deployment_services_build_artifact_id FOREIGN KEY (build_artifact_id) REFERENCES build_artifacts (id);
ALTER TABLE iac_stacks ADD CONSTRAINT fk_iac_stacks_project_id FOREIGN KEY (project_id) REFERENCES projects (id);
ALTER TABLE iac_stacks ADD CONSTRAINT fk_iac_stacks_target_id FOREIGN KEY (target_id) REFERENCES targets (id);
ALTER TABLE iac_stacks ADD CONSTRAINT fk_iac_stacks_last_applied_deployment_id FOREIGN KEY (last_applied_deployment_id) REFERENCES deployments (id);
ALTER TABLE ci_triggers ADD CONSTRAINT fk_ci_triggers_project_id FOREIGN KEY (project_id) REFERENCES projects (id);
ALTER TABLE ci_triggers ADD CONSTRAINT fk_ci_triggers_target_id FOREIGN KEY (target_id) REFERENCES targets (id);
ALTER TABLE ci_triggers ADD CONSTRAINT fk_ci_triggers_pipeline_definition_id FOREIGN KEY (pipeline_definition_id) REFERENCES pipeline_definitions (id);
ALTER TABLE ci_triggers ADD CONSTRAINT fk_ci_triggers_created_by FOREIGN KEY (created_by) REFERENCES users (id);
ALTER TABLE agent_runs ADD CONSTRAINT fk_agent_runs_deployment_id FOREIGN KEY (deployment_id) REFERENCES deployments (id);
ALTER TABLE agent_tool_calls ADD CONSTRAINT fk_agent_tool_calls_agent_run_id FOREIGN KEY (agent_run_id) REFERENCES agent_runs (id);
ALTER TABLE agent_tool_calls ADD CONSTRAINT fk_agent_tool_calls_approval_id FOREIGN KEY (approval_id) REFERENCES approvals (id);

-- 우회 경로 정합성: 하위 행의 배포 아이디가 상위 행과 같도록 강제
ALTER TABLE jobs ADD CONSTRAINT fk_jobs_step_id_dep FOREIGN KEY (step_id, deployment_id) REFERENCES deployment_steps (id, deployment_id);
ALTER TABLE diagnoses ADD CONSTRAINT fk_diagnoses_failed_step_id_dep FOREIGN KEY (failed_step_id, deployment_id) REFERENCES deployment_steps (id, deployment_id);
ALTER TABLE diagnoses ADD CONSTRAINT fk_diagnoses_suggested_patch_id_dep FOREIGN KEY (suggested_patch_id, deployment_id) REFERENCES patches (id, deployment_id);
ALTER TABLE verifications ADD CONSTRAINT fk_verifications_patch_id_dep FOREIGN KEY (patch_id, deployment_id) REFERENCES patches (id, deployment_id);

-- 작업 큐 조회용 부분 인덱스 (대기 중인 작업만)
CREATE INDEX ix_jobs_queued ON jobs (run_after) WHERE status = 'queued';
