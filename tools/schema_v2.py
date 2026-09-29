# -*- coding: utf-8 -*-
# 단일 스키마 정의에서 ERD Cloud(MySQL 문법)용과 실제 PostgreSQL용 DDL을 함께 생성

T = []  # (table, kor, owner, cols, pk, uniques, fks, indexes)

def tbl(name, kor, owner, cols, pk=('id',), uniques=(), fks=(), idx=()):
    T.append(dict(name=name, kor=kor, owner=owner, cols=cols, pk=pk, uniques=uniques, fks=fks, idx=idx))

# col: (name, type, null, default, kor, enum_values)
def c(name, typ, kor, null=True, default=None, enum=None):
    return (name, typ, null, default, kor, enum)

ID = c('id', 'id', '식별자', null=False)
CAT = c('created_at', 'ts', '생성 일시', null=False, default='now')
UAT = c('updated_at', 'ts', '수정 일시', null=False, default='now')

# ---------------- 사용자 · 인증 ----------------
tbl('users', '사용자', 'API 서버', [
    ID,
    c('email', 'str255', '이메일', null=False),
    c('name', 'str100', '이름', null=False),
    c('role', 'str20', '역할', null=False, default="'member'", enum=['admin', 'member']),
    CAT, UAT], uniques=[('email',)])

tbl('api_tokens', 'API 토큰', 'API 서버', [
    ID,
    c('user_id', 'fk', '사용자 식별자', null=False),
    c('name', 'str100', '토큰명', null=False),
    c('token_hash', 'str255', '토큰 해시', null=False),
    c('scope', 'str50', '권한 범위', null=False, enum=['ci', 'cli', 'mcp']),
    c('expires_at', 'ts', '만료 일시'),
    c('last_used_at', 'ts', '마지막 사용 일시'),
    CAT], uniques=[('token_hash',)], fks=[('user_id', 'users', 'id')])

# ---------------- 프로젝트 · 소스 ----------------
tbl('projects', '프로젝트', 'API 서버', [
    ID,
    c('owner_id', 'fk', '소유자 식별자', null=False),
    c('name', 'str100', '프로젝트명', null=False),
    c('description', 'text', '설명'),
    CAT, UAT], fks=[('owner_id', 'users', 'id')])

tbl('source_versions', '소스 버전', 'API 서버', [
    ID,
    c('project_id', 'fk', '프로젝트 식별자', null=False),
    c('version_no', 'int', '버전 번호', null=False),
    c('source_type', 'str20', '소스 유형', null=False, enum=['upload', 'git', 'patched']),
    c('parent_version_id', 'fk', '상위 소스 버전 식별자'),
    c('git_repo_url', 'str500', 'Git 저장소 URL'),
    c('git_ref', 'str200', 'Git 브랜치·커밋'),
    c('content_hash', 'str64', '내용 해시', null=False),
    c('storage_key', 'str500', '저장소 키', null=False),
    c('uploaded_by', 'fk', '업로드 사용자 식별자'),
    CAT], uniques=[('project_id', 'version_no')],
    fks=[('project_id', 'projects', 'id'), ('uploaded_by', 'users', 'id'), ('parent_version_id', 'source_versions', 'id')],
    idx=[('content_hash',)])

tbl('analysis_reports', '분석 리포트', '분석 워커', [
    ID,
    c('source_version_id', 'fk', '소스 버전 식별자', null=False),
    c('architecture', 'str20', '아키텍처 유형', null=False, enum=['monolith', 'msa', 'unknown']),
    c('stack', 'json', '기술 스택'),
    c('runtime', 'json', '런타임 정보'),
    c('services', 'json', '서비스 목록·의존 그래프'),
    c('resources', 'json', '의존 리소스'),
    c('env_vars', 'json', '환경변수 목록'),
    c('risks', 'json', '운영 위험 목록'),
    c('used_llm', 'bool', 'LLM 사용 여부', null=False, default='false'),
    CAT], uniques=[('source_version_id',)], fks=[('source_version_id', 'source_versions', 'id')])

tbl('pipeline_definitions', '파이프라인 정의', 'API 서버', [
    ID,
    c('project_id', 'fk', '프로젝트 식별자', null=False),
    c('version_no', 'int', '버전 번호', null=False),
    c('definition', 'text', '정의 내용', null=False),
    c('created_by', 'fk', '작성자 식별자'),
    CAT], uniques=[('project_id', 'version_no')],
    fks=[('project_id', 'projects', 'id'), ('created_by', 'users', 'id')])

# ---------------- IR ----------------
tbl('ir_versions', 'IR 버전', 'API 서버', [
    ID,
    c('project_id', 'fk', '프로젝트 식별자', null=False),
    c('source_version_id', 'fk', '소스 버전 식별자'),
    c('version_no', 'int', '버전 번호', null=False),
    c('schema_version', 'str20', 'IR 스키마 버전', null=False),
    c('spec', 'text', 'IR 명세(YAML)', null=False),
    c('origin', 'str20', '생성 주체', null=False, enum=['agent', 'user']),
    c('created_by', 'fk', '작성자 식별자'),
    CAT], uniques=[('project_id', 'version_no')],
    fks=[('project_id', 'projects', 'id'), ('source_version_id', 'source_versions', 'id'), ('created_by', 'users', 'id')])

# ---------------- 대상 환경 ----------------
tbl('targets', '대상 환경', 'API 서버', [
    ID,
    c('owner_id', 'fk', '소유자 식별자', null=False),
    c('name', 'str100', '환경명', null=False),
    c('provider', 'str20', '제공자', null=False, enum=['onprem', 'aws', 'gcp', 'azure']),
    c('stage', 'str20', '환경 단계', null=False, default="'dev'", enum=['dev', 'staging', 'prod']),
    c('region', 'str50', '리전'),
    c('config', 'json', '환경 설정'),
    c('role_identifier_ref', 'str500', '역할 식별자 볼트 참조'),
    c('status', 'str20', '상태', null=False, default="'pending'", enum=['pending', 'active', 'error', 'deleted']),
    c('auto_approve_policy', 'str20', '자동 승인 정책', null=False, default="'none'", enum=['none', 'plan_only', 'all']),
    CAT, UAT], uniques=[('owner_id', 'name')], fks=[('owner_id', 'users', 'id')])

tbl('agent_tokens', '에이전트 등록 토큰', 'API 서버', [
    ID,
    c('target_id', 'fk', '대상 환경 식별자', null=False),
    c('token_hash', 'str255', '토큰 해시', null=False),
    c('expires_at', 'ts', '만료 일시', null=False),
    c('used_at', 'ts', '사용 일시'),
    c('created_by', 'fk', '발급자 식별자'),
    CAT], uniques=[('token_hash',)],
    fks=[('target_id', 'targets', 'id'), ('created_by', 'users', 'id')])

tbl('onprem_agents', '온프레미스 에이전트', 'API 서버', [
    ID,
    c('target_id', 'fk', '대상 환경 식별자', null=False),
    c('hostname', 'str200', '호스트명'),
    c('os', 'str20', '운영체제', null=False, enum=['linux', 'macos', 'windows']),
    c('arch', 'str20', 'CPU 아키텍처', null=False, enum=['amd64', 'arm64']),
    c('runtime', 'str20', '실행 런타임', null=False, enum=['compose', 'k3s']),
    c('agent_version', 'str20', '에이전트 버전'),
    c('credential_ref', 'str500', '인증 정보 볼트 참조', null=False),
    c('status', 'str20', '상태', null=False, default="'online'", enum=['online', 'offline', 'revoked']),
    c('last_seen_at', 'ts', '마지막 접속 일시'),
    CAT], fks=[('target_id', 'targets', 'id')])

tbl('secrets', '비밀값 메타데이터', 'API 서버', [
    ID,
    c('project_id', 'fk', '프로젝트 식별자', null=False),
    c('target_id', 'fk', '대상 환경 식별자'),
    c('key_name', 'str200', '변수명', null=False),
    c('is_secret', 'bool', '비밀 여부', null=False, default='true'),
    c('vault_ref', 'str500', '볼트 참조', null=False),
    CAT, UAT], uniques=[('project_id', 'target_id', 'key_name')],
    fks=[('project_id', 'projects', 'id'), ('target_id', 'targets', 'id')])

# ---------------- 추천 · 비용 ----------------
tbl('pricing_catalog', '가격 카탈로그', '추천·비용 엔진', [
    ID,
    c('provider', 'str20', '제공자', null=False, enum=['onprem', 'aws', 'gcp', 'azure']),
    c('service', 'str100', '서비스명', null=False),
    c('sku', 'str200', '상품 코드', null=False),
    c('region', 'str50', '리전', null=False),
    c('unit', 'str50', '과금 단위', null=False),
    c('unit_price', 'dec', '단가', null=False),
    c('currency', 'str3', '통화', null=False, default="'USD'"),
    UAT], uniques=[('provider', 'sku', 'region')])

tbl('recommendations', '배포 추천', '추천·비용 엔진', [
    ID,
    c('project_id', 'fk', '프로젝트 식별자', null=False),
    c('ir_version_id', 'fk', 'IR 버전 식별자', null=False),
    c('conditions', 'json', '사용자 조건'),
    c('explanation', 'text', 'AI 근거 설명'),
    CAT], fks=[('project_id', 'projects', 'id'), ('ir_version_id', 'ir_versions', 'id')])

tbl('recommendation_candidates', '추천 후보', '추천·비용 엔진', [
    ID,
    c('recommendation_id', 'fk', '추천 식별자', null=False),
    c('target_id', 'fk', '대상 환경 식별자'),
    c('rank_no', 'int', '순위', null=False),
    c('provider', 'str20', '제공자', null=False, enum=['onprem', 'aws', 'gcp', 'azure']),
    c('compute_type', 'str20', '배포 형태', null=False, enum=['function', 'container', 'instance']),
    c('service', 'str100', '대상 서비스'),
    c('score_cost', 'dec', '비용 점수'),
    c('score_performance', 'dec', '성능 점수'),
    c('score_scalability', 'dec', '확장성 점수'),
    c('monthly_cost', 'dec', '월 예상 비용'),
    c('currency', 'str3', '통화', default="'USD'"),
    c('cost_breakdown', 'json', '비용 상세'),
    c('rationale', 'text', '추천 근거')],
    uniques=[('recommendation_id', 'rank_no')], fks=[('recommendation_id', 'recommendations', 'id'), ('target_id', 'targets', 'id')])

# ---------------- 배포 ----------------
tbl('deployments', '배포', '오케스트레이터', [
    ID,
    c('project_id', 'fk', '프로젝트 식별자', null=False),
    c('target_id', 'fk', '대상 환경 식별자'),
    c('source_version_id', 'fk', '소스 버전 식별자'),
    c('ir_version_id', 'fk', 'IR 버전 식별자'),
    c('pipeline_definition_id', 'fk', '파이프라인 정의 식별자'),
    c('recommendation_candidate_id', 'fk', '선택 추천 후보 식별자'),
    c('kind', 'str20', '배포 종류', null=False, default="'deploy'", enum=['deploy', 'rollback', 'cleanup']),
    c('rollback_of_id', 'fk', '롤백 대상 배포 식별자'),
    c('compute_type', 'str20', '배포 형태', enum=['function', 'container', 'instance']),
    c('strategy', 'str20', '배포 전략', null=False, default="'rolling'", enum=['recreate', 'rolling', 'bluegreen', 'canary']),
    c('rollout_config', 'json', '롤아웃 설정'),
    c('state', 'str30', '상태', null=False, default="'received'",
      enum=['received', 'queued', 'analyzing', 'awaiting_patch_approval', 'awaiting_target_confirmation', 'building', 'planning',
            'awaiting_plan_approval', 'provisioning', 'deploying', 'verifying', 'diagnosing',
            'rolling_back', 'succeeded', 'failed', 'cancelled']),
    c('trigger_source', 'str20', '요청 경로', null=False, enum=['cli', 'web', 'ci', 'agent', 'mcp']),
    c('public_url', 'str500', '공개 URL'),
    c('retry_count', 'int', '재시도 횟수', null=False, default='0'),
    c('max_retries', 'int', '최대 재시도 횟수', null=False, default='3'),
    c('is_demo_preprovisioned', 'bool', '사전 프로비저닝 여부', null=False, default='false'),
    c('requested_by', 'fk', '요청자 식별자'),
    c('started_at', 'ts', '시작 일시'),
    c('finished_at', 'ts', '종료 일시'),
    CAT, UAT],
    fks=[('project_id', 'projects', 'id'), ('target_id', 'targets', 'id'),
         ('source_version_id', 'source_versions', 'id'), ('ir_version_id', 'ir_versions', 'id'),
         ('pipeline_definition_id', 'pipeline_definitions', 'id'),
         ('recommendation_candidate_id', 'recommendation_candidates', 'id'),
         ('rollback_of_id', 'deployments', 'id'), ('requested_by', 'users', 'id')],
    idx=[('target_id', 'state'), ('project_id', 'created_at')])

tbl('deployment_steps', '배포 단계', '오케스트레이터', [
    ID,
    c('deployment_id', 'fk', '배포 식별자', null=False),
    c('step', 'str30', '단계', null=False,
      enum=['analyze', 'patch', 'recommend', 'build', 'plan', 'provision', 'migrate', 'rollout',
            'verify', 'diagnose', 'rollback', 'cleanup', 'custom']),
    c('custom_name', 'str100', '커스텀 단계명'),
    c('attempt', 'int', '시도 차수', null=False, default='1'),
    c('status', 'str20', '상태', null=False, default="'pending'",
      enum=['pending', 'running', 'succeeded', 'failed', 'skipped']),
    c('log_storage_key', 'str500', '로그 저장소 키'),
    c('error_message', 'text', '오류 메시지'),
    c('started_at', 'ts', '시작 일시'),
    c('ended_at', 'ts', '종료 일시')],
    uniques=[('id', 'deployment_id')],
    fks=[('deployment_id', 'deployments', 'id')], idx=[('deployment_id', 'step')])

tbl('approvals', '승인', '오케스트레이터', [
    ID,
    c('deployment_id', 'fk', '배포 식별자', null=False),
    c('kind', 'str20', '승인 대상', null=False, enum=['patch', 'target', 'plan', 'rollback', 'cleanup']),
    c('decision', 'str20', '결정', null=False, default="'pending'", enum=['pending', 'approved', 'rejected', 'expired']),
    c('comment', 'text', '의견'),
    c('decided_by', 'fk', '결정자 식별자'),
    c('requested_at', 'ts', '요청 일시', null=False, default='now'),
    c('expires_at', 'ts', '만료 일시'),
    c('decided_at', 'ts', '결정 일시')],
    fks=[('deployment_id', 'deployments', 'id'), ('decided_by', 'users', 'id')])

tbl('env_locks', '환경 락', '오케스트레이터', [
    c('target_id', 'fk', '대상 환경 식별자', null=False),
    c('deployment_id', 'fk', '배포 식별자', null=False),
    c('holder_instance', 'str100', '보유 인스턴스'),
    c('acquired_at', 'ts', '획득 일시', null=False, default='now'),
    c('lease_expires_at', 'ts', '임대 만료 일시', null=False)],
    pk=('target_id',), uniques=[('deployment_id',)],
    fks=[('target_id', 'targets', 'id'), ('deployment_id', 'deployments', 'id')])

tbl('jobs', '작업 큐', '오케스트레이터', [
    ID,
    c('deployment_id', 'fk', '배포 식별자', null=False),
    c('step_id', 'fk', '배포 단계 식별자'),
    c('job_type', 'str30', '작업 유형', null=False,
      enum=['analyze', 'build', 'plan', 'provision', 'verify', 'onprem_apply', 'obs_query', 'cleanup']),
    c('payload', 'json', '작업 입력', null=False),
    c('status', 'str20', '상태', null=False, default="'queued'",
      enum=['queued', 'running', 'succeeded', 'failed', 'dead']),
    c('attempt', 'int', '시도 횟수', null=False, default='0'),
    c('max_attempts', 'int', '최대 시도 횟수', null=False, default='3'),
    c('run_after', 'ts', '실행 가능 일시', null=False, default='now'),
    c('locked_by', 'str100', '처리 워커'),
    c('locked_until', 'ts', '임대 만료 일시'),
    c('result', 'json', '작업 결과'),
    c('last_error', 'text', '마지막 오류'),
    CAT, UAT],
    fks=[('deployment_id', 'deployments', 'id'), ('step_id', 'deployment_steps', 'id')],
    idx=[('status', 'run_after')])

tbl('patches', '코드 패치', 'AI 에이전트', [
    ID,
    c('deployment_id', 'fk', '배포 식별자', null=False),
    c('goal', 'str40', '수정 목적', null=False,
      enum=['sqlite_to_postgres', 'externalize_config', 'add_healthcheck', 'add_otel', 'dockerfile', 'fix', 'other']),
    c('summary', 'text', '변경 요약'),
    c('diff_storage_key', 'str500', 'diff 저장소 키', null=False),
    c('result_source_version_id', 'fk', '적용 결과 소스 버전 식별자'),
    c('status', 'str20', '상태', null=False, default="'proposed'", enum=['proposed', 'approved', 'rejected', 'applied']),
    c('verification_status', 'str20', '검증 상태', null=False, default="'pending'",
      enum=['pending', 'passed', 'failed', 'skipped']),
    CAT], uniques=[('id', 'deployment_id')],
    fks=[('deployment_id', 'deployments', 'id'), ('result_source_version_id', 'source_versions', 'id')])

tbl('build_artifacts', '빌드 산출물', '빌드 워커', [
    ID,
    c('deployment_id', 'fk', '배포 식별자', null=False),
    c('source_version_id', 'fk', '빌드 소스 버전 식별자', null=False),
    c('service_name', 'str100', '서비스명', null=False),
    c('registry', 'str200', '레지스트리', null=False),
    c('image_repo', 'str300', '이미지 저장소', null=False),
    c('image_tag', 'str200', '이미지 태그', null=False),
    c('image_digest', 'str100', '이미지 다이제스트'),
    c('platforms', 'str100', '빌드 플랫폼'),
    c('builder', 'str20', '빌드 방식', null=False, enum=['dockerfile', 'railpack', 'buildpacks']),
    c('cache_hit', 'bool', '캐시 사용 여부', null=False, default='false'),
    CAT], fks=[('deployment_id', 'deployments', 'id'), ('source_version_id', 'source_versions', 'id')])

tbl('infra_plans', '인프라 플랜', '프로비저닝 워커', [
    ID,
    c('deployment_id', 'fk', '배포 식별자', null=False),
    c('adapter', 'str20', '어댑터', null=False, enum=['onprem', 'aws', 'gcp', 'azure']),
    c('iac_engine', 'str20', 'IaC 엔진', null=False, enum=['pulumi', 'terraform', 'compose', 'k3s']),
    c('create_count', 'int', '생성 개수', null=False, default='0'),
    c('update_count', 'int', '변경 개수', null=False, default='0'),
    c('delete_count', 'int', '삭제 개수', null=False, default='0'),
    c('plan_storage_key', 'str500', '플랜 저장소 키', null=False),
    CAT], fks=[('deployment_id', 'deployments', 'id')])

tbl('provisioned_resources', '생성 리소스', '프로비저닝 워커', [
    ID,
    c('iac_stack_id', 'fk', 'IaC 스택 식별자', null=False),
    c('target_id', 'fk', '대상 환경 식별자', null=False),
    c('last_deployment_id', 'fk', '마지막 변경 배포 식별자'),
    c('resource_type', 'str100', '리소스 유형', null=False),
    c('resource_name', 'str200', '리소스명', null=False),
    c('provider_resource_id', 'str500', '제공자 리소스 ID'),
    c('status', 'str20', '상태', null=False, default="'active'", enum=['active', 'deleting', 'deleted', 'error']),
    CAT,
    c('deleted_at', 'ts', '삭제 일시')],
    fks=[('iac_stack_id', 'iac_stacks', 'id'), ('target_id', 'targets', 'id'), ('last_deployment_id', 'deployments', 'id')],
    idx=[('target_id', 'status')])

tbl('db_migrations', 'DB 마이그레이션', '프로비저닝 워커', [
    ID,
    c('deployment_id', 'fk', '배포 식별자', null=False),
    c('tool', 'str30', '마이그레이션 도구', enum=['prisma', 'rails', 'flyway', 'liquibase', 'alembic', 'other']),
    c('source_engine', 'str20', '원본 DB 엔진', enum=['sqlite', 'postgres', 'mysql', 'none']),
    c('target_engine', 'str20', '대상 DB 엔진', null=False, enum=['postgres', 'mysql']),
    c('schema_status', 'str20', '스키마 적용 상태', null=False, default="'pending'",
      enum=['pending', 'succeeded', 'failed']),
    c('data_transfer', 'bool', '데이터 이전 여부', null=False, default='false'),
    c('source_row_count', 'bigint', '원본 행 수'),
    c('target_row_count', 'bigint', '대상 행 수'),
    c('verified', 'bool', '검증 통과 여부'),
    CAT], fks=[('deployment_id', 'deployments', 'id')])

tbl('verifications', '검증 결과', '검증 워커', [
    ID,
    c('deployment_id', 'fk', '배포 식별자', null=False),
    c('patch_id', 'fk', '코드 패치 식별자'),
    c('kind', 'str20', '검증 종류', null=False,
      enum=['patch_test', 'healthcheck', 'smoke', 'canary_analysis', 'load_test']),
    c('status', 'str20', '결과', null=False, enum=['passed', 'failed']),
    c('metrics', 'json', '측정 지표'),
    c('report_storage_key', 'str500', '리포트 저장소 키'),
    CAT], fks=[('deployment_id', 'deployments', 'id'), ('patch_id', 'patches', 'id')])

tbl('diagnoses', '실패 진단', 'AI 에이전트', [
    ID,
    c('deployment_id', 'fk', '배포 식별자', null=False),
    c('failed_step_id', 'fk', '실패 단계 식별자'),
    c('root_cause', 'text', '추정 원인', null=False),
    c('evidence', 'json', '근거 로그·지표'),
    c('suggested_patch_id', 'fk', '제안 패치 식별자'),
    c('outcome', 'str20', '조치 결과', enum=['retried', 'rolled_back', 'dismissed']),
    CAT], fks=[('deployment_id', 'deployments', 'id'), ('failed_step_id', 'deployment_steps', 'id'),
               ('suggested_patch_id', 'patches', 'id')])

tbl('ai_usage', 'AI 사용량', 'AI 에이전트', [
    ID,
    c('deployment_id', 'fk', '배포 식별자'),
    c('agent_run_id', 'fk', '에이전트 실행 식별자'),
    c('purpose', 'str20', '사용 목적', null=False,
      enum=['analyze', 'patch', 'ir', 'explain', 'diagnose', 'ci_workflow', 'chat']),
    c('model', 'str100', '모델명', null=False),
    c('tokens_in', 'int', '입력 토큰 수', null=False, default='0'),
    c('tokens_out', 'int', '출력 토큰 수', null=False, default='0'),
    c('cost_usd', 'dec', '비용(USD)', null=False, default='0'),
    c('latency_ms', 'int', '응답 시간(ms)'),
    c('cache_hit', 'bool', '캐시 사용 여부', null=False, default='false'),
    CAT], fks=[('deployment_id', 'deployments', 'id'), ('agent_run_id', 'agent_runs', 'id')], idx=[('created_at',)])

tbl('audit_logs', '감사 로그', 'API 서버', [
    ID,
    c('actor_type', 'str20', '행위자 유형', null=False, enum=['user', 'agent', 'system', 'ci']),
    c('actor_id', 'str100', '행위자 식별자'),
    c('action', 'str100', '행위', null=False),
    c('resource_type', 'str50', '대상 리소스 유형', null=False),
    c('resource_id', 'str100', '대상 리소스 식별자'),
    c('detail', 'json', '상세'),
    CAT], idx=[('resource_type', 'resource_id'), ('created_at',)])


# ---------------- v2 신규 테이블 ----------------
tbl('deployment_services', '배포 서비스', '오케스트레이터', [
    ID,
    c('deployment_id', 'fk', '배포 식별자', null=False),
    c('service_name', 'str100', '서비스명', null=False),
    c('deploy_order', 'int', '배포 순서', null=False, default='1'),
    c('build_artifact_id', 'fk', '빌드 산출물 식별자'),
    c('status', 'str20', '상태', null=False, default="'pending'",
      enum=['pending', 'deploying', 'healthy', 'failed', 'rolled_back']),
    c('traffic_percent', 'int', '새 버전 트래픽 비율', null=False, default='0'),
    c('public_url', 'str500', '공개 URL'),
    c('internal_endpoint', 'str500', '내부 접속 주소'),
    CAT, UAT], uniques=[('deployment_id', 'service_name')],
    fks=[('deployment_id', 'deployments', 'id'), ('build_artifact_id', 'build_artifacts', 'id')])

tbl('iac_stacks', 'IaC 스택', '프로비저닝 워커', [
    ID,
    c('project_id', 'fk', '프로젝트 식별자', null=False),
    c('target_id', 'fk', '대상 환경 식별자', null=False),
    c('engine', 'str20', 'IaC 엔진', null=False, enum=['pulumi', 'terraform', 'compose', 'k3s']),
    c('stack_name', 'str200', '스택명', null=False),
    c('state_ref', 'str500', 'state 저장 위치', null=False),
    c('last_applied_deployment_id', 'fk', '마지막 적용 배포 식별자'),
    c('status', 'str20', '상태', null=False, default="'active'", enum=['active', 'destroying', 'destroyed']),
    CAT, UAT], uniques=[('project_id', 'target_id')],
    fks=[('project_id', 'projects', 'id'), ('target_id', 'targets', 'id'),
         ('last_applied_deployment_id', 'deployments', 'id')])

tbl('ci_triggers', 'CI 트리거', 'API 서버', [
    ID,
    c('project_id', 'fk', '프로젝트 식별자', null=False),
    c('target_id', 'fk', '대상 환경 식별자', null=False),
    c('pipeline_definition_id', 'fk', '파이프라인 정의 식별자'),
    c('repo_url', 'str500', '저장소 URL', null=False),
    c('branch', 'str200', '브랜치', null=False),
    c('webhook_secret_ref', 'str500', '웹훅 비밀값 볼트 참조', null=False),
    c('auto_deploy', 'bool', '자동 배포 여부', null=False, default='true'),
    c('created_by', 'fk', '작성자 식별자'),
    CAT, UAT], uniques=[('project_id', 'repo_url', 'branch', 'target_id')],
    fks=[('project_id', 'projects', 'id'), ('target_id', 'targets', 'id'),
         ('pipeline_definition_id', 'pipeline_definitions', 'id'), ('created_by', 'users', 'id')])

tbl('agent_runs', '에이전트 실행', 'AI 에이전트', [
    ID,
    c('deployment_id', 'fk', '배포 식별자'),
    c('trigger_source', 'str20', '실행 주체', null=False, enum=['orchestrator', 'user', 'mcp']),
    c('goal', 'text', '목표', null=False),
    c('status', 'str20', '상태', null=False, default="'running'",
      enum=['running', 'waiting_approval', 'succeeded', 'failed', 'cancelled']),
    c('summary', 'text', '결과 요약'),
    c('started_at', 'ts', '시작 일시', null=False, default='now'),
    c('ended_at', 'ts', '종료 일시')],
    fks=[('deployment_id', 'deployments', 'id')])

tbl('agent_tool_calls', '에이전트 도구 호출', 'AI 에이전트', [
    ID,
    c('agent_run_id', 'fk', '에이전트 실행 식별자', null=False),
    c('seq', 'int', '호출 순번', null=False),
    c('tool_name', 'str50', '도구명', null=False),
    c('input', 'json', '입력'),
    c('output_summary', 'text', '결과 요약'),
    c('requires_approval', 'bool', '승인 필요 여부', null=False, default='false'),
    c('approval_id', 'fk', '승인 식별자'),
    c('status', 'str20', '상태', null=False, enum=['succeeded', 'failed', 'blocked', 'pending_approval']),
    CAT], uniques=[('agent_run_id', 'seq')],
    fks=[('agent_run_id', 'agent_runs', 'id'), ('approval_id', 'approvals', 'id')])

# 논리명 규칙: 기본 키 = "<테이블 한글명> 아이디", 외래 키 = "... 아이디"
for _t in T:
    _cols = []
    for (n, ty, nul, d, kor, enum) in _t['cols']:
        if n == 'id': kor = _t['kor'] + ' 아이디'
        else: kor = kor.replace('식별자', '아이디')
        _cols.append((n, ty, nul, d, kor, enum))
    _t['cols'] = _cols

NEW_TABLES = ['deployment_services', 'iac_stacks', 'ci_triggers', 'agent_runs', 'agent_tool_calls']
COMPOSITE_FKS = [
    ('jobs', ('step_id', 'deployment_id'), 'deployment_steps', ('id', 'deployment_id')),
    ('diagnoses', ('failed_step_id', 'deployment_id'), 'deployment_steps', ('id', 'deployment_id')),
    ('diagnoses', ('suggested_patch_id', 'deployment_id'), 'patches', ('id', 'deployment_id')),
    ('verifications', ('patch_id', 'deployment_id'), 'patches', ('id', 'deployment_id')),
]

# ---------------- generators ----------------
PG = {'id': 'BIGINT GENERATED ALWAYS AS IDENTITY', 'fk': 'BIGINT', 'int': 'INTEGER', 'bigint': 'BIGINT',
      'text': 'TEXT', 'json': 'JSONB', 'ts': 'TIMESTAMPTZ', 'bool': 'BOOLEAN', 'dec': 'NUMERIC(14,6)'}
MY = {'id': 'BIGINT', 'fk': 'BIGINT', 'int': 'INT', 'bigint': 'BIGINT', 'text': 'TEXT', 'json': 'JSON',
      'ts': 'DATETIME', 'bool': 'BOOLEAN', 'dec': 'DECIMAL(14,6)'}

def typ(t, m):
    if t.startswith('str'):
        n = t[3:]
        return f'VARCHAR({n})' if not (m is PG and n in ('3',)) else f'CHAR({n})'
    return m[t]

def dflt(d, dialect):
    if d is None: return ''
    if d == 'now': return ' DEFAULT CURRENT_TIMESTAMP' if dialect == 'my' else ' DEFAULT now()'
    if d in ('true', 'false') and dialect == 'my': return f' DEFAULT {d.upper()}'
    return f' DEFAULT {d}'

def esc(s): return s.replace("'", "''")

def mysql():
    out = ['-- ERD Cloud 가져오기용 DDL (MySQL 문법)',
           '-- 물리명: 영문 / 논리명: COMMENT의 한글명',
           '-- 실제 DB는 PostgreSQL이며 postgres_schema.sql을 사용', '']
    for t in T:
        lines = []
        for (n, ty, nul, d, kor, enum) in t['cols']:
            s = f'  `{n}` {typ(ty, MY)}' + (' NOT NULL' if not nul else ' NULL')
            if ty == 'id': s += ' AUTO_INCREMENT'
            s += dflt(d, 'my') + f" COMMENT '{esc(kor)}'"
            lines.append(s)
        lines.append('  PRIMARY KEY (' + ', '.join(f'`{k}`' for k in t['pk']) + ')')
        for u in t['uniques']:
            lines.append(f"  UNIQUE KEY `uq_{t['name']}_{'_'.join(u)}` (" + ', '.join(f'`{k}`' for k in u) + ')')
        for i in t['idx']:
            lines.append(f"  KEY `ix_{t['name']}_{'_'.join(i)}` (" + ', '.join(f'`{k}`' for k in i) + ')')
        out.append(f"CREATE TABLE `{t['name']}` (\n" + ',\n'.join(lines) + f"\n) COMMENT = '{esc(t['kor'])}';\n")
    out.append('-- 관계 (외래 키)')
    for t in T:
        for (col, rt, rc) in t['fks']:
            out.append(f"ALTER TABLE `{t['name']}` ADD CONSTRAINT `fk_{t['name']}_{col}` FOREIGN KEY (`{col}`) REFERENCES `{rt}` (`{rc}`);")
    return '\n'.join(out) + '\n'

def postgres():
    out = ['-- PostgreSQL 실제 스키마 v2', '-- 테이블·컬럼 한글명은 COMMENT ON으로 저장', '']
    for t in T:
        lines = []
        for (n, ty, nul, d, kor, enum) in t['cols']:
            s = f'  {n} {typ(ty, PG)}' + (' NOT NULL' if not nul else '') + dflt(d, 'pg')
            if enum: s += ' CHECK (' + n + ' IN (' + ', '.join(f"'{v}'" for v in enum) + '))'
            lines.append(s)
        lines.append(f"  CONSTRAINT pk_{t['name']} PRIMARY KEY (" + ', '.join(t['pk']) + ')')
        for u in t['uniques']:
            nd = ' NULLS NOT DISTINCT' if t['name'] == 'secrets' else ''
            lines.append(f"  CONSTRAINT uq_{t['name']}_{'_'.join(u)} UNIQUE{nd} (" + ', '.join(u) + ')')
        out.append(f"CREATE TABLE {t['name']} (\n" + ',\n'.join(lines) + '\n);')
        for i in t['idx']:
            out.append(f"CREATE INDEX ix_{t['name']}_{'_'.join(i)} ON {t['name']} (" + ', '.join(i) + ');')
        out.append(f"COMMENT ON TABLE {t['name']} IS '{esc(t['kor'])} (소유: {esc(t['owner'])})';")
        for (n, ty, nul, d, kor, enum) in t['cols']:
            k = kor + (' [' + ', '.join(enum) + ']' if enum else '')
            out.append(f"COMMENT ON COLUMN {t['name']}.{n} IS '{esc(k)}';")
        out.append('')
    out.append('-- 관계 (외래 키)')
    for t in T:
        for (col, rt, rc) in t['fks']:
            out.append(f"ALTER TABLE {t['name']} ADD CONSTRAINT fk_{t['name']}_{col} FOREIGN KEY ({col}) REFERENCES {rt} ({rc});")
    out.append('')
    out.append('-- 우회 경로 정합성: 하위 행의 배포 아이디가 상위 행과 같도록 강제')
    for (tb, cols, rt, rcols) in COMPOSITE_FKS:
        out.append(f"ALTER TABLE {tb} ADD CONSTRAINT fk_{tb}_{cols[0]}_dep FOREIGN KEY ({', '.join(cols)}) REFERENCES {rt} ({', '.join(rcols)});")
    out.append('')
    out.append('-- 작업 큐 조회용 부분 인덱스 (대기 중인 작업만)')
    out.append("CREATE INDEX ix_jobs_queued ON jobs (run_after) WHERE status = 'queued';")
    return '\n'.join(out) + '\n'

def dictionary():
    o = ['# 데이터 사전', '', '| 테이블(영문) | 테이블(한글) | 쓰기 소유 컴포넌트 | 컬럼 수 |', '|---|---|---|---|']
    for t in T: o.append(f"| {t['name']} | {t['kor']} | {t['owner']} | {len(t['cols'])} |")
    for t in T:
        o += ['', f"## {t['name']} ({t['kor']})", f"쓰기 소유: {t['owner']}", '',
              '| 컬럼(영문) | 컬럼(한글) | 타입(PostgreSQL) | NULL | 기본값 | 허용 값 | 키 |', '|---|---|---|---|---|---|---|']
        fkmap = {col: f'FK → {rt}.{rc}' for col, rt, rc in t['fks']}
        for (n, ty, nul, d, kor, enum) in t['cols']:
            key = 'PK' if n in t['pk'] else fkmap.get(n, '')
            if n in t['pk'] and n in fkmap: key = 'PK, ' + fkmap[n]
            dd = '' if d is None else ('now()' if d == 'now' else d.strip("'"))
            o.append(f"| {n} | {kor} | {typ(ty, PG).replace(' GENERATED ALWAYS AS IDENTITY','')} | {'Y' if nul else 'N'} | {dd} | {', '.join(enum) if enum else ''} | {key} |")
    return '\n'.join(o) + '\n'


if __name__ == '__main__':
    open('docs/erd/postgres_schema_v2.sql', 'w').write(postgres())
    open('docs/erd/erdcloud_import_v2.sql', 'w').write(mysql())
    open('docs/erd/데이터사전_v2.md', 'w').write(dictionary())
    print(len(T), 'tables,', sum(len(t['fks']) for t in T), 'fks')
