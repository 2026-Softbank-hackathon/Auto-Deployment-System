-- Agent 재시작 복구와 실제 실행 상태 확인을 위한 마지막 heartbeat inventory.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS runtime_inventory JSONB NOT NULL DEFAULT '[]'::jsonb;
