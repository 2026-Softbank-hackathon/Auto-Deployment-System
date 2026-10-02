-- 021_terraform_outputs.sql — 인프라 변경 없는 정적 사이트 갱신의 Terraform 생략 (#299)
-- provision 이 정적 사이트(aws-static-basic) Terraform 출력값(버킷 · S3 웹사이트 endpoint, sensitive 제외)을
-- 배포에 남긴다. 같은 프로젝트 · 환경의 직전 Terraform 배포가 성공했고 입력 지문이 같으면
-- Terraform 을 돌리지 않고 그 배포의 출력값으로 파일만 동기화한다. 값이 없으면 지금처럼 Terraform 을 실행한다.

ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS terraform_outputs JSONB;
