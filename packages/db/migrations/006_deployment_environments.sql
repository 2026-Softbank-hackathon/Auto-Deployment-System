ALTER TABLE environments
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY project_id, type
           ORDER BY created_at ASC, id ASC
         ) AS row_number
  FROM environments
)
UPDATE environments AS environment
SET is_default = TRUE
FROM ranked
WHERE environment.id = ranked.id
  AND ranked.row_number = 1
  AND NOT EXISTS (
    SELECT 1
    FROM environments AS existing_default
    WHERE existing_default.project_id = environment.project_id
      AND existing_default.type = environment.type
      AND existing_default.is_default = TRUE
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_environments_default_per_vendor
  ON environments(project_id, type)
  WHERE is_default = TRUE;

ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS target_environment_id BIGINT
    REFERENCES environments(id) ON DELETE RESTRICT;

ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS registry_environment_id BIGINT
    REFERENCES environments(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_deployments_target_environment
  ON deployments(target_environment_id);

CREATE INDEX IF NOT EXISTS idx_deployments_registry_environment
  ON deployments(registry_environment_id);
