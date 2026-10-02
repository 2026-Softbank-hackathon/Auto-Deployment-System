-- 012_shared_connections.sql (#215)
-- 연결 정보(environments)와 AWS 키(secrets)를 프로젝트 없이 등록해 모든 앱이 같이 쓴다.
-- project_id IS NULL = 공용 연결. 기존 프로젝트 전용 row 는 그대로 둔다.
-- 인프라 리소스(Terraform state · ECR repo · Tunnel)는 여전히 앱(프로젝트)마다 만든다.

ALTER TABLE environments ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE secrets ALTER COLUMN project_id DROP NOT NULL;

-- 기존 UNIQUE (project_id, name) 은 NULL 끼리 겹침을 막지 못하므로 공용 전용 부분 인덱스를 둔다.
CREATE UNIQUE INDEX IF NOT EXISTS uq_environments_shared_name
  ON environments(name)
  WHERE project_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_environments_shared_default_per_vendor
  ON environments(type)
  WHERE project_id IS NULL AND is_default = TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_secrets_shared_name
  ON secrets(name)
  WHERE project_id IS NULL;
