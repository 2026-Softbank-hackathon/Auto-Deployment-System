-- migration 010: audit_logs
-- 감사 로그 테이블 — mutating API 호출을 자동 기록

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_type TEXT NOT NULL,              -- 'session' | 'agent' | 'system'
  actor_id TEXT,                          -- session_id or agent_id (NULL for system)
  action TEXT NOT NULL,                   -- HTTP method + path (e.g., 'POST /deployments')
  resource_type TEXT,                     -- 'deployment' | 'project' | 'environment' | 'secret' | 'agent' | ...
  resource_id TEXT,                       -- 영향 받는 리소스 식별자
  status_code INTEGER NOT NULL,           -- 응답 HTTP status
  request_id TEXT NOT NULL,               -- 요청 UUID (추적용)
  metadata JSONB,                         -- 추가 컨텍스트 (request body 요약, 변경 전/후 diff 등 — 시크릿 X)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_type, actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
