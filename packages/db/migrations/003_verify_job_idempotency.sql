ALTER TABLE deployment_steps
  ADD COLUMN IF NOT EXISTS job_id VARCHAR(200);

CREATE UNIQUE INDEX IF NOT EXISTS uq_deployment_steps_verify_job_id
  ON deployment_steps(job_id)
  WHERE step_name = 'verify' AND job_id IS NOT NULL;
