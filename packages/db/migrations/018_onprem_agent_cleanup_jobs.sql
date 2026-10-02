CREATE TABLE IF NOT EXISTS onprem_agent_cleanup_jobs (
  id BIGSERIAL PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE,
  deployment_id BIGINT NOT NULL UNIQUE
    REFERENCES deployments(id) ON DELETE CASCADE,
  environment_id BIGINT NOT NULL
    REFERENCES environments(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL
    CHECK (reason IN ('superseded', 'deployment_failed', 'deployment_cancelled', 'project_deleted')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'succeeded', 'failed')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner_id BIGINT,
  lease_expires_at TIMESTAMPTZ,
  result JSONB,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (status = 'claimed' AND lease_owner_id IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR status <> 'claimed'
  )
);

CREATE INDEX IF NOT EXISTS idx_onprem_agent_cleanup_jobs_pending
  ON onprem_agent_cleanup_jobs (available_at, id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_onprem_agent_cleanup_jobs_expired_lease
  ON onprem_agent_cleanup_jobs (lease_expires_at)
  WHERE status = 'claimed';
