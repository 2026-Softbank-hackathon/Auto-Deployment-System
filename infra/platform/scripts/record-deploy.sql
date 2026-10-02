-- 플랫폼 자동 배포(CD) 기록 (#310). deploy.sh 가 postgres 컨테이너 안의 psql 로 실행한다:
--   docker exec -i <postgres> psql -U camellia -d camellia -v deploy_key=… -v status=… … -f - < record-deploy.sql
-- :'이름' 은 psql 이 SQL 문자열로 안전하게 감싼다(따옴표 · 역슬래시 포함). 빈 문자열은 NULL 로 둔다.
-- 같은 deploy_key 로 시작(running)과 끝(success · failed)을 upsert 한다. 끝 기록의 빈 값은 앞서 남긴 값을 지우지 않는다.
INSERT INTO platform_deploys AS d (
  deploy_key, status, ref, commit_sha, commit_subject, commit_url, started_at, finished_at,
  disk_used_before_bytes, disk_used_after_bytes, disk_total_bytes, run_id, run_url
)
VALUES (
  :'deploy_key',
  :'status',
  NULLIF(:'ref', ''),
  NULLIF(:'commit_sha', ''),
  NULLIF(:'commit_subject', ''),
  NULLIF(:'commit_url', ''),
  to_timestamp(:'started_at'::bigint),
  CASE WHEN :'status' = 'running' THEN NULL ELSE now() END,
  NULLIF(:'disk_before', '')::bigint,
  NULLIF(:'disk_after', '')::bigint,
  NULLIF(:'disk_total', '')::bigint,
  NULLIF(:'run_id', ''),
  NULLIF(:'run_url', '')
)
ON CONFLICT (deploy_key) DO UPDATE SET
  status = EXCLUDED.status,
  finished_at = EXCLUDED.finished_at,
  ref = COALESCE(EXCLUDED.ref, d.ref),
  commit_sha = COALESCE(EXCLUDED.commit_sha, d.commit_sha),
  commit_subject = COALESCE(EXCLUDED.commit_subject, d.commit_subject),
  commit_url = COALESCE(EXCLUDED.commit_url, d.commit_url),
  disk_used_before_bytes = COALESCE(EXCLUDED.disk_used_before_bytes, d.disk_used_before_bytes),
  disk_used_after_bytes = COALESCE(EXCLUDED.disk_used_after_bytes, d.disk_used_after_bytes),
  disk_total_bytes = COALESCE(EXCLUDED.disk_total_bytes, d.disk_total_bytes),
  run_id = COALESCE(EXCLUDED.run_id, d.run_id),
  run_url = COALESCE(EXCLUDED.run_url, d.run_url);
