-- 023_project_address_change.sql — 앱 주소 변경 진행 상태 (#301)
-- PATCH /projects/:id/subdomain 이 changing 으로 바꾸고 address-change 워커가 새 주소를 지금 서비스 중인 곳에 연결 →
-- 최종 URL 검증 → 성공하면 projects.subdomain 을 바꾸고 예전 주소를 지운다(succeeded). 실패하면 새 주소를 지우고
-- 예전 주소를 그대로 둔다(failed + 이유). changing 인 동안 배포 · 앱 삭제 · 다른 주소 변경을 막는다.
-- 주소 변경을 한 번도 하지 않은 앱은 모두 NULL.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS address_change_status TEXT
    CHECK (address_change_status IN ('changing', 'succeeded', 'failed')),
  ADD COLUMN IF NOT EXISTS address_change_from TEXT,
  ADD COLUMN IF NOT EXISTS address_change_to TEXT,
  ADD COLUMN IF NOT EXISTS address_change_error TEXT,
  ADD COLUMN IF NOT EXISTS address_change_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS address_change_finished_at TIMESTAMPTZ;
