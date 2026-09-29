-- projects
CREATE TABLE IF NOT EXISTS projects (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- deployments (P0)
CREATE TABLE IF NOT EXISTS deployments (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL,  -- received/analyzing/awaiting_target_confirmation/... (v5.4.1 16 states)
  target_profile TEXT,   -- filled after target confirmation
  public_url TEXT,       -- filled on succeeded
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  succeeded_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_deployments_project ON deployments(project_id);
CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);

-- source_versions (SRC-04, sha256 cache)
CREATE TABLE IF NOT EXISTS source_versions (
  id BIGSERIAL PRIMARY KEY,
  deployment_id BIGINT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL,  -- object storage key
  size_bytes BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_source_versions_sha ON source_versions(sha256);

-- analysis_reports (ANL result)
CREATE TABLE IF NOT EXISTS analysis_reports (
  id BIGSERIAL PRIMARY KEY,
  deployment_id BIGINT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  source_version_id BIGINT REFERENCES source_versions(id) ON DELETE SET NULL,
  services_json JSONB NOT NULL,   -- ServiceCandidate[]
  resources_json JSONB NOT NULL,  -- ResourceCandidate[]
  warnings_json JSONB NOT NULL,
  unresolved_json JSONB NOT NULL,
  ir_valid BOOLEAN NOT NULL,
  ir_errors_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ir_versions
CREATE TABLE IF NOT EXISTS ir_versions (
  id BIGSERIAL PRIMARY KEY,
  deployment_id BIGINT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  ir_json JSONB NOT NULL,
  source TEXT NOT NULL,  -- 'analyzer' | 'ai_filled' | 'user_edited'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- env_locks (D-15, D-30 acquired immediately after target approval)
CREATE TABLE IF NOT EXISTS env_locks (
  id BIGSERIAL PRIMARY KEY,
  env_key TEXT NOT NULL UNIQUE,  -- e.g., "aws-ecs-basic:project-name"
  deployment_id BIGINT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- approvals (D-26 orchestrator owns writes)
CREATE TABLE IF NOT EXISTS approvals (
  id BIGSERIAL PRIMARY KEY,
  deployment_id BIGINT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  gate TEXT NOT NULL,  -- 'patch' (P1) | 'target' (P0) | 'plan' (P0)
  decision TEXT,       -- null=pending, 'approve' | 'reject'
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  UNIQUE (deployment_id, gate)
);

-- deployment_steps (per-step logs)
CREATE TABLE IF NOT EXISTS deployment_steps (
  id BIGSERIAL PRIMARY KEY,
  deployment_id BIGINT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  step_name TEXT NOT NULL,  -- 'analyze', 'build', 'provision', 'verify', etc.
  status TEXT NOT NULL,     -- 'running' | 'succeeded' | 'failed'
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  message TEXT
);

-- ai_usage (CST-01)
CREATE TABLE IF NOT EXISTS ai_usage (
  id BIGSERIAL PRIMARY KEY,
  deployment_id BIGINT REFERENCES deployments(id) ON DELETE SET NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC(12,6) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
