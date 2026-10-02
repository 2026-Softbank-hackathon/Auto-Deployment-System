-- 022_project_subdomain.sql — 사용자 지정 앱 주소 (#300)
-- projects.subdomain: 앱 공개 주소 https://{subdomain}.{플랫폼 도메인} 의 앞부분.
--   이 기능 전에는 주소가 service-{id} 로 정해져 있었다. 기존 앱은 같은 값으로 채워 지금 주소를 그대로 쓴다.
--   주소를 고르지 않고 만든 앱도 service-{id} (트리거). 컬럼은 NULL 을 허용한다 — 코드는 NULL 을 service-{id} 로 본다.
--   대소문자를 무시하고 앱마다 하나 (API 는 소문자로만 저장한다).

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS subdomain TEXT;

UPDATE projects SET subdomain = 'service-' || id WHERE subdomain IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS projects_subdomain_unique
  ON projects (lower(subdomain));

CREATE OR REPLACE FUNCTION projects_default_subdomain() RETURNS trigger AS $$
BEGIN
  IF NEW.subdomain IS NULL THEN
    NEW.subdomain := 'service-' || NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS projects_default_subdomain ON projects;
CREATE TRIGGER projects_default_subdomain
  BEFORE INSERT ON projects
  FOR EACH ROW EXECUTE FUNCTION projects_default_subdomain();
