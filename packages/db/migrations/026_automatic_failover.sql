-- 프로젝트의 실제 서비스 Origin과 On-Prem 장애 시 되돌아갈 AWS 배포를 명시한다.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS active_deployment_id BIGINT
    REFERENCES deployments(id) ON DELETE SET NULL;

ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS failover_target_deployment_id BIGINT
    REFERENCES deployments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_deployments_failover_target
  ON deployments(failover_target_deployment_id)
  WHERE failover_target_deployment_id IS NOT NULL;

-- 이전 버전은 가장 최근 성공 배포가 현재 Origin이라는 계약이었다.
UPDATE projects AS project
SET active_deployment_id = (
  SELECT deployment.id
  FROM deployments AS deployment
  WHERE deployment.project_id = project.id
    AND deployment.status = 'succeeded'
  ORDER BY deployment.succeeded_at DESC NULLS LAST, deployment.id DESC
  LIMIT 1
)
WHERE project.active_deployment_id IS NULL;
