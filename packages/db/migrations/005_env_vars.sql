-- DAT-01 프로젝트 환경변수 (평문 설정값). 민감한 값은 secrets (DAT-02) 에 저장.
-- IR services[].env 에는 이름만 있고, 값은 배포 시점에 이 테이블에서 주입한다 (D-50).
CREATE TABLE IF NOT EXISTS env_vars (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);
