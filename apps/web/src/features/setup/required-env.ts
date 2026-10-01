import { getDeploymentIr, listProjectDeployments } from '../../api/deployment-api';

/** 앱이 읽는 환경변수 한 개. suggestedValue는 분석이 값을 알아낸 경우(PORT)에만 있다. */
export interface RequiredEnvVar { name: string; suggestedValue: string | null }

/**
 * 배포의 IR에서 앱이 읽는 환경변수 이름을 모은다 (services.<name>.env).
 * 서버 프로비저닝은 이 이름이 프로젝트 환경변수에 전부 등록돼 있어야 진행한다 (없으면 PROJECT_ENV_VAR_NOT_FOUND).
 */
export async function requiredEnvOfDeployment(deploymentId: string): Promise<RequiredEnvVar[]> {
  const { ir } = await getDeploymentIr(deploymentId);
  const services = ir && typeof ir === 'object' ? (ir as { services?: unknown }).services : null;
  if (!services || typeof services !== 'object') return [];
  const found = new Map<string, string | null>();
  for (const service of Object.values(services as Record<string, unknown>)) {
    if (!service || typeof service !== 'object') continue;
    const { env, port } = service as { env?: unknown; port?: unknown };
    for (const name of Array.isArray(env) ? env : []) {
      if (typeof name === 'string' && !found.has(name)) found.set(name, name === 'PORT' && typeof port === 'number' ? String(port) : null);
    }
  }
  return [...found].map(([name, suggestedValue]) => ({ name, suggestedValue }));
}

/** 프로젝트의 가장 최근 배포 기준. 아직 배포(분석)한 적이 없으면 빈 목록. */
export async function requiredEnvOfProject(projectId: string): Promise<RequiredEnvVar[]> {
  const latest = (await listProjectDeployments(projectId, { limit: 1 })).items[0];
  return latest ? requiredEnvOfDeployment(latest.id) : [];
}
