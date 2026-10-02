-- 024_source_patch_i18n.sql — 코드 수정안 설명의 한국어 · 일본어 (#147)
-- AI 가 수정안 요약 · 알아 둘 점을 한 번에 두 언어로 쓴다({ko, ja}). summary · notes 는 지금처럼 한국어를 두고
-- (예전 화면 · 예전 행과 호환), 두 언어 값은 새 컬럼에 둔다. 이 컬럼이 생기기 전에 만든 수정안은 NULL.

ALTER TABLE source_patches
  ADD COLUMN IF NOT EXISTS summary_i18n JSONB,
  ADD COLUMN IF NOT EXISTS notes_i18n JSONB;
