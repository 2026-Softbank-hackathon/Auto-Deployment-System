-- API-36 AI 실패 진단 (FIX-01 · FIX-02)
-- deployments 테이블에 diagnosis_json 컬럼 추가.
-- 워커의 diagnose handler 가 Claude 호출 결과 { failedStep, summary, patchCandidates, generatedAt } 를 저장.

ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS diagnosis_json JSONB;
