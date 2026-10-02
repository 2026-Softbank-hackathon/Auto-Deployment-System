-- 015_project_deletion.sql — 앱(프로젝트) 삭제 진행 상태 (#247)
-- DELETE /projects/:id 가 deleting 으로 바꾸고 teardown 워커가 리소스를 정리한 뒤 row 를 지운다.
-- 정리에 실패하면 failed + 이유를 남겨 다시 시도할 수 있게 한다. 삭제 요청이 없으면 NULL.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS deletion_status TEXT
    CHECK (deletion_status IN ('deleting', 'failed')),
  ADD COLUMN IF NOT EXISTS deletion_error TEXT,
  ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ,
  -- 자동으로 정리하지 못해 사용자가 직접 해야 하는 일 (예: ONPREM_MANUAL_CLEANUP)
  ADD COLUMN IF NOT EXISTS deletion_warnings TEXT[] NOT NULL DEFAULT '{}';
