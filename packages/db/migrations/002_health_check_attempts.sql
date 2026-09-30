CREATE TABLE IF NOT EXISTS health_check_attempts (
  id BIGSERIAL PRIMARY KEY,
  deployment_step_id BIGINT NOT NULL
    REFERENCES deployment_steps(id)
    ON DELETE CASCADE,
  environment_id VARCHAR(100) NOT NULL,
  attempt INTEGER NOT NULL
    CHECK (attempt >= 1),
  checked_at TIMESTAMPTZ NOT NULL,
  status_code SMALLINT
    CHECK (status_code IS NULL OR status_code BETWEEN 100 AND 599),
  latency_ms INTEGER
    CHECK (latency_ms IS NULL OR latency_ms >= 0),
  passed BOOLEAN NOT NULL,
  error_code VARCHAR(50),
  error_message TEXT,
  UNIQUE (deployment_step_id, environment_id, attempt)
);

CREATE INDEX IF NOT EXISTS idx_health_check_attempts_step
  ON health_check_attempts(deployment_step_id, checked_at);
