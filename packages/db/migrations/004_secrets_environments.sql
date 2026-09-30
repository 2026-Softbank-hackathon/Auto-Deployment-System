-- API-28/29/30 DAT-02 시크릿 저장 (AES-256-GCM 암호화).
-- ciphertext + iv (12 bytes) + auth_tag (16 bytes) 로 분리 저장.
CREATE TABLE IF NOT EXISTS secrets (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  ciphertext BYTEA NOT NULL,
  iv BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_secrets_project ON secrets(project_id);

-- API-23~26 REC-01 배포 환경 등록.
-- aws_config 안의 accessKeyIdSecretName / secretAccessKeySecretName 은 secrets.name 참조 (원시 값 저장 X).
CREATE TABLE IF NOT EXISTS environments (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('aws', 'onprem')),
  aws_config JSONB,
  onprem_config JSONB,
  agent_status TEXT,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_environments_project ON environments(project_id);
