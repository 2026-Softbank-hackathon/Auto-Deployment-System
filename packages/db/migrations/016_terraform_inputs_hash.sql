-- 016_terraform_inputs_hash.sql — 이미지만 바뀐 재배포의 상태 재조회 생략 (#252)
-- provision 이 Terraform apply 전에 이미지를 뺀 입력(모듈 파일 · 변수 · region · access key ID)의
-- SHA-256 을 기록한다. 같은 프로젝트 · 환경의 직전 Terraform 배포가 성공했고 값이 같으면
-- plan 을 -refresh=false 로 실행한다. Terraform 을 돌리지 않은 배포(온프레미스 등)는 NULL.

ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS terraform_inputs_hash TEXT;
