ALTER TABLE onprem_agent_jobs
  ADD COLUMN IF NOT EXISTS ecr_credential_issued_attempt INTEGER;
