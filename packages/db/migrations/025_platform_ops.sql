-- 025_platform_ops.sql — 플랫폼 운영 대시보드 (#308)
-- 사용자 앱이 아니라 플랫폼 자체(워커 · EC2 호스트 · AI 비용 · 플랫폼 CD)의 상태를 남긴다.

-- 워커 하트비트: 워커 프로세스마다 한 행, 10초마다 upsert. 종료 신호로 드레인을 시작하면 draining = true
CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  commit_sha TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  draining BOOLEAN NOT NULL DEFAULT false,
  active_jobs INTEGER NOT NULL DEFAULT 0
);

-- 플랫폼 호스트 지표: 워커가 30초마다 남기고 24시간 지난 행은 워커가 지운다.
-- cpu_percent 는 직전 샘플과의 차이라 첫 샘플은 NULL, build_cache_bytes 는 5분마다만 채운다
CREATE TABLE IF NOT EXISTS platform_metrics (
  id BIGSERIAL PRIMARY KEY,
  sampled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cpu_percent REAL,
  mem_used_bytes BIGINT NOT NULL,
  mem_total_bytes BIGINT NOT NULL,
  load1 REAL NOT NULL,
  load5 REAL NOT NULL,
  load15 REAL NOT NULL,
  disk_used_bytes BIGINT NOT NULL,
  disk_total_bytes BIGINT NOT NULL,
  build_cache_bytes BIGINT
);
CREATE INDEX IF NOT EXISTS platform_metrics_sampled_at_idx ON platform_metrics (sampled_at);

-- 플랫폼 자동 배포(CD) 기록: infra/platform/scripts/deploy.sh 가 시작 · 끝에 deploy_key 로 upsert 한다
CREATE TABLE IF NOT EXISTS platform_deploys (
  id BIGSERIAL PRIMARY KEY,
  deploy_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
  ref TEXT,
  commit_sha TEXT,
  commit_subject TEXT,
  commit_url TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  disk_used_before_bytes BIGINT,
  disk_used_after_bytes BIGINT,
  disk_total_bytes BIGINT,
  run_id TEXT,
  run_url TEXT
);
CREATE INDEX IF NOT EXISTS platform_deploys_started_at_idx ON platform_deploys (started_at);

-- AI 호출 목적. 이 컬럼이 생기기 전 행은 NULL(화면에는 "구분 없음")
ALTER TABLE ai_usage
  ADD COLUMN IF NOT EXISTS purpose TEXT
    CHECK (purpose IN ('analysis_fill', 'sqlite_patch', 'diagnosis'));
CREATE INDEX IF NOT EXISTS ai_usage_created_at_idx ON ai_usage (created_at);
