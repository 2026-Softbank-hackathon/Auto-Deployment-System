-- 019_deploy_mode.sql — 배포 형태(컨테이너 · 서버리스) (#282)
-- projects.deploy_mode: 앱의 배포 형태. 간단 배포 · 재배포에서 고르면 바뀌고, 고르지 않은 배포 · 재배포 · 롤백 ·
--   환경 전환은 이 값을 따른다. AWS + serverless 면 aws-lambda-basic, 그 밖은 지금과 같다 (온프레미스는 항상 컨테이너).
-- build_artifacts.lambda_web_adapter: 이미지에 넣은 Lambda Web Adapter 버전 (#280). 이 기능 전에 만든 이미지는 NULL
--   → 서버리스 배포에서는 재사용하지 않고 소스로 다시 빌드한다.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS deploy_mode TEXT NOT NULL DEFAULT 'container'
    CHECK (deploy_mode IN ('container', 'serverless'));

ALTER TABLE build_artifacts
  ADD COLUMN IF NOT EXISTS lambda_web_adapter TEXT;
