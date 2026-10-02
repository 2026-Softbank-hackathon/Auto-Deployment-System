-- 020_source_patches.sql — 코드 수정안과 승인 (PAT-02, #277)
-- 분석이 SQLite 앱을 PostgreSQL 겸용(dual-mode)으로 고친 수정안을 만들면 배포마다 한 줄 남긴다.
-- 수정안을 적용한 소스는 미리 zip 으로 저장해 두고(patched_*), 승인하면 그 zip 을 이 배포의 새 source_versions 로 넣는다
-- → 빌드 · 재배포는 지금처럼 "가장 최근 source_version" 을 쓴다.

CREATE TABLE IF NOT EXISTS source_patches (
  id BIGSERIAL PRIMARY KEY,
  deployment_id BIGINT NOT NULL UNIQUE REFERENCES deployments(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                                   -- 'sqlite_to_postgres'
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  summary TEXT NOT NULL,
  notes JSONB NOT NULL DEFAULT '[]',
  diff TEXT NOT NULL,                                   -- unified diff (lock 파일 제외)
  files JSONB NOT NULL,                                 -- [{ path, change, additions, deletions, generated }]
  generator TEXT NOT NULL,                              -- 'ai'
  model TEXT,
  patched_storage_key TEXT NOT NULL,
  patched_sha256 TEXT NOT NULL,
  patched_size_bytes BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);
