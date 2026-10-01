CREATE TABLE IF NOT EXISTS onprem_agent_jobs (
  id BIGSERIAL PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE,
  deployment_id BIGINT NOT NULL UNIQUE
    REFERENCES deployments(id) ON DELETE CASCADE,
  environment_id BIGINT NOT NULL
    REFERENCES environments(id) ON DELETE RESTRICT,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'running', 'ready_for_verify', 'failed', 'cancelled')),
  payload JSONB NOT NULL,
  result JSONB,
  lease_owner_id BIGINT,
  lease_expires_at TIMESTAMPTZ,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (status IN ('claimed', 'running') AND lease_owner_id IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR status NOT IN ('claimed', 'running')
  )
);

CREATE INDEX IF NOT EXISTS idx_onprem_agent_jobs_pending
  ON onprem_agent_jobs (created_at, id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_onprem_agent_jobs_expired_lease
  ON onprem_agent_jobs (lease_expires_at)
  WHERE status IN ('claimed', 'running');
