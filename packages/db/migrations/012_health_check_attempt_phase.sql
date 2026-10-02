ALTER TABLE health_check_attempts
  ADD COLUMN phase VARCHAR(32) NOT NULL DEFAULT 'target'
    CHECK (phase IN ('target', 'public_url'));

ALTER TABLE health_check_attempts
  DROP CONSTRAINT IF EXISTS health_check_attempts_deployment_step_id_environment_id_attempt_key;

ALTER TABLE health_check_attempts
  ADD CONSTRAINT uq_health_check_attempts_phase_attempt
  UNIQUE (deployment_step_id, environment_id, phase, attempt);

DROP INDEX IF EXISTS idx_health_check_attempts_step;

CREATE INDEX idx_health_check_attempts_step
  ON health_check_attempts(deployment_step_id, phase, checked_at);
