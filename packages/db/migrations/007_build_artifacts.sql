CREATE TABLE IF NOT EXISTS build_artifacts (
  id BIGSERIAL PRIMARY KEY,
  deployment_id BIGINT NOT NULL UNIQUE
    REFERENCES deployments(id) ON DELETE CASCADE,
  repository_uri TEXT NOT NULL,
  image_tag TEXT NOT NULL,
  image_digest TEXT NOT NULL
    CHECK (image_digest ~ '^sha256:[0-9a-f]{64}$'),
  immutable_ref TEXT NOT NULL,
  platform TEXT NOT NULL,
  strategy TEXT NOT NULL CHECK (strategy IN ('dockerfile', 'railpack')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_build_artifacts_digest
  ON build_artifacts(image_digest);
