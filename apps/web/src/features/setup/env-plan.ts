import { getDeploymentIr, listProjectDeployments } from '../../api/deployment-api';

/**
 * 플랫폼이 자동으로 넣어 주는 환경변수 (apps/worker handlers/provision.ts PLATFORM_INJECTED_ENV_VARS).
 * 서버가 목록을 API로 주지 않아 같은 이름을 여기에 둔다.
 */
export const PLATFORM_ENV_NAMES = ['PORT', 'DEPLOY_TARGET', 'NODE_ENV', 'AWS_REGION'] as const;

/** 최근 배포의 분석 결과(IR)가 말해 주는 "앱이 읽는 환경변수". */
export interface EnvPlan {
  /** 앱이 읽는 이름 전체 (services.*.env). 배포 때 앱에 전달되는 것은 이 이름들뿐이다. */
  names: string[];
  /** 분석기가 .env.example에서 찾은 기본값 (services.*.env_defaults) */
  defaults: Record<string, string>;
  /** 분석이 찾은 서비스 포트 (PORT 자동 값) */
  port: number | null;
}

export type EnvSource = 'required' | 'default' | 'auto';

/**
 * 등록하지 않았을 때 서버가 그 변수를 무엇으로 채우는지. 서버와 같은 순서다: 기본값 → 플랫폼 자동 → 없음(입력 필요).
 * 프로젝트에 등록한 값이 있으면 그 값이 항상 먼저 쓰인다.
 */
export function envSource(name: string, plan: EnvPlan): EnvSource {
  if (name in plan.defaults) return 'default';
  if ((PLATFORM_ENV_NAMES as readonly string[]).includes(name)) return 'auto';
  return 'required';
}

/** 등록하지 않으면 배포가 실패하는 이름 (기본값도 자동 값도 없고 등록도 안 된 것). */
export function missingEnvNames(plan: EnvPlan, registered: ReadonlyArray<{ name: string }>): string[] {
  return plan.names.filter((name) => envSource(name, plan) === 'required' && !registered.some((item) => item.name === name));
}

function planOfIr(ir: unknown): EnvPlan {
  const services = ir && typeof ir === 'object' ? (ir as { services?: unknown }).services : null;
  const names: string[] = [];
  const defaults: Record<string, string> = {};
  let port: number | null = null;
  for (const service of services && typeof services === 'object' ? Object.values(services as Record<string, unknown>) : []) {
    if (!service || typeof service !== 'object') continue;
    const record = service as { env?: unknown; env_defaults?: unknown; port?: unknown };
    for (const name of Array.isArray(record.env) ? record.env : []) if (typeof name === 'string' && !names.includes(name)) names.push(name);
    if (record.env_defaults && typeof record.env_defaults === 'object') {
      for (const [name, value] of Object.entries(record.env_defaults as Record<string, unknown>)) if (typeof value === 'string' && !(name in defaults)) defaults[name] = value;
    }
    if (port === null && typeof record.port === 'number') port = record.port;
  }
  return { names: names.sort(), defaults, port };
}

/** 프로젝트의 가장 최근 배포 기준. 아직 배포(분석)한 적이 없으면 null. */
export async function loadEnvPlan(projectId: string): Promise<EnvPlan | null> {
  const latest = (await listProjectDeployments(projectId, { limit: 1 })).items[0];
  if (!latest) return null;
  return planOfIr((await getDeploymentIr(latest.id)).ir);
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VALUE_MAX = 4096;

/** .env 파일 내용 → KEY=value 목록. 주석 · 빈 줄 · export 접두어 · 감싼 따옴표를 처리한다. 형식에 맞지 않는 줄은 skipped로 센다. */
export function parseDotEnv(text: string): { vars: Record<string, string>; skipped: number } {
  const vars: Record<string, string> = {};
  let skipped = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    const name = eq > 0 ? line.slice(0, eq).trim() : '';
    if (!ENV_NAME.test(name) || name.length > 128) { skipped += 1; continue; }
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    if (value.length > VALUE_MAX) { skipped += 1; continue; }
    vars[name] = value;
  }
  return { vars, skipped };
}

/** 이름만 보고 비밀 값으로 보이는지. 이 화면의 값은 평문으로 저장되므로 경고에만 쓴다. */
export function looksSecret(name: string): boolean {
  return /(PASSWORD|PASSWD|SECRET|TOKEN|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY)/i.test(name);
}
