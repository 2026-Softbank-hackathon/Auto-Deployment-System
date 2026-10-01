-- 008_agents.sql
-- 등록된 Agent 레코드. environment 하나에 Agent 1대 전제 (CLAUDE.md 결정).
CREATE TABLE IF NOT EXISTS agents (
  id BIGSERIAL PRIMARY KEY,
  environment_id BIGINT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  long_lived_key_hash TEXT NOT NULL,  -- sha256 hash
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  UNIQUE (environment_id)  -- environment 당 Agent 1대
);
CREATE INDEX IF NOT EXISTS idx_agents_env ON agents(environment_id);

-- 1회용 등록 토큰 (consume 후 invalidate).
CREATE TABLE IF NOT EXISTS agent_registration_tokens (
  id BIGSERIAL PRIMARY KEY,
  environment_id BIGINT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,     -- sha256 hash of plain token
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,     -- 발급 시점 + 10분
  consumed_at TIMESTAMPTZ,              -- 사용 시점 (NULL 이면 미사용)
  consumed_by_agent_id BIGINT REFERENCES agents(id)
);
CREATE INDEX IF NOT EXISTS idx_agent_reg_tokens_env ON agent_registration_tokens(environment_id);
CREATE INDEX IF NOT EXISTS idx_agent_reg_tokens_consumed ON agent_registration_tokens(consumed_at) WHERE consumed_at IS NULL;
