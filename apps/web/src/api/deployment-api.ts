const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');

export class DeploymentApiError extends Error {
  /**
   * code — 서버 오류 본문의 error.code (예: DEPLOYMENT_LOCKED). 본문을 읽은 경우에만 있다.
   * serverMessage — 서버가 준 설명(error.message, 한국어). 한국어 화면은 본문에, 일본어 화면은 "자세한 오류 보기" 안에만 보여 준다 (I18nProvider serverReason).
   */
  constructor(public readonly status: number, message: string, public readonly code?: string, public readonly serverMessage?: string) {
    super(message);
    this.name = 'DeploymentApiError';
  }
}

/** 서버 응답이 기대한 모양이 아닐 때. 화면은 현재 언어의 일반 문구로 보여 준다 (message 는 개발용 한국어) */
export class ResponseFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResponseFormatError';
  }
}

export interface DeploymentStatusResponse {
  currentStep: unknown;
  approvalPending: unknown;
  publicUrl: unknown;
  [field: string]: unknown;
}

export interface CreateDeploymentResponse {
  deploymentId: string;
  status: 'received';
  eventsUrl: string;
}

export interface CreateProjectResponse {
  id: string;
  name: string;
}

export interface DeploymentAnalysisReportResponse {
  deploymentId: number;
  detectedStack: unknown;
  services: unknown;
  resources: unknown;
  warnings: unknown;
  unresolved: unknown;
  irValid: unknown;
  irErrors: unknown;
  migrationTool: unknown;
  /** 등록해야 배포되는 환경변수 이름 (기본값도 자동 값도 없고 미등록). 분석이 끝나지 않았으면 null */
  missingEnvNames: string[] | null;
  createdAt: unknown;
}

export interface DeploymentIrResponse {
  deploymentId: unknown;
  ir: unknown;
  version: unknown;
  generatedAt: unknown;
  /** "analyzer" | "ai_filled" | "analyzer_cache" | "user_edited" */
  source: unknown;
}

export interface DeploymentHealthCheck { attempt: number; passed: boolean; statusCode?: number; latencyMs?: number }
export interface DeploymentHealthResponse {
  status: 'checking' | 'passed' | 'failed';
  phase?: 'target' | 'origin_switching' | 'public_url';
  checks: DeploymentHealthCheck[];
  consecutivePassed: number;
  requiredPasses: number;
}

export function endpoint(path: string): string {
  const suffix = path.replace(/^\/api\/v1(?=\/|$)/, '');
  return `${apiBaseUrl}${suffix}`;
}

/** 실패 응답이면 서버 오류 코드(error.code)를 담아 던진다. */
async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  const body = await response.json().catch(() => null) as { error?: { code?: unknown; message?: unknown } } | null;
  const code = typeof body?.error?.code === 'string' ? body.error.code : undefined;
  const serverMessage = typeof body?.error?.message === 'string' && body.error.message.trim() ? body.error.message : undefined;
  throw new DeploymentApiError(response.status, `요청을 완료하지 못했습니다. (${response.status})`, code, serverMessage);
}

export async function readJson(response: Response): Promise<unknown> {
  await assertOk(response);
  return response.json();
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ResponseFormatError(`${label} 응답 형식이 올바르지 않습니다.`);
  return value as Record<string, unknown>;
}

/**
 * 배포 생성. environment_id는 고른 연결(공용 연결 또는 이 프로젝트의 연결)이고, 연결의 종류가 배포할 곳(aws | onprem)을 정한다 (#215).
 * 온프레미스면 서버가 이미지 저장소로 쓸 AWS 연결(프로젝트 기본 → 공용 기본)을 따로 고른다.
 */
/** 배포 형태 (#282). 컨테이너가 기본이고 서버리스(AWS Lambda)는 고급 설정에서 고를 때만. 앱에 저장된다 */
export type DeployMode = 'container' | 'serverless';

/** 서버리스로 배포한 프로필 — 배포 내역 · 앱 상세의 "서버리스" 표시 */
export const SERVERLESS_PROFILE = 'aws-lambda-basic';

/** AWS 에 서버 없이 S3 웹사이트로 배포한 정적 사이트 프로필 — "정적 사이트" 표시 (#275) */
export const STATIC_SITE_PROFILE = 'aws-static-basic';

/** mode 를 주면 앱의 배포 형태도 바뀐다. 없으면 앱에 저장된 형태(새 앱은 컨테이너)로 배포한다 */
export async function createDeployment(source: File, projectId: string, environmentId: string, mode?: DeployMode): Promise<CreateDeploymentResponse> {
  const form = new FormData();
  form.append('source', source);
  form.append('project_id', projectId);
  form.append('environment_id', environmentId);
  if (mode) form.append('mode', mode);

  const response = await fetch(endpoint('/api/v1/deployments'), {
    method: 'POST',
    body: form,
    credentials: 'include',
  });
  const body = asRecord(await readJson(response), '배포 생성');
  const deploymentId = typeof body.deploymentId === 'string' ? body.deploymentId : null;
  const status = body.status === 'received' ? body.status : null;
  const eventsUrl = typeof body.eventsUrl === 'string' ? body.eventsUrl : null;
  if (!deploymentId || !status || !eventsUrl) throw new ResponseFormatError('배포 생성 응답 형식이 올바르지 않습니다.');
  return { deploymentId, status, eventsUrl };
}

/**
 * API-02 — 프로젝트 생성. 프로젝트는 한 애플리케이션의 배포 이력을 묶는 단위라 처음 한 번만 만든다.
 * subdomain 을 주면 앱 주소가 {subdomain}.{플랫폼 도메인} (#302), 없으면 서버가 service-{id} 로 정한다.
 * 다른 앱이 쓰는 주소면 409 SUBDOMAIN_TAKEN.
 */
export async function createProject(name: string, subdomain?: string): Promise<CreateProjectResponse> {
  const response = await fetch(endpoint('/api/v1/projects'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(subdomain ? { name, subdomain } : { name }),
    credentials: 'include',
  });
  const body = asRecord(await readJson(response), '프로젝트 생성');
  const id = typeof body.id === 'string' ? body.id : null;
  const projectName = typeof body.name === 'string' ? body.name : null;
  if (!id || !projectName) throw new ResponseFormatError('프로젝트 생성 응답 형식이 올바르지 않습니다.');
  return { id, name: projectName };
}

/** API-06 — deployment state, current step, and approval state. */
export async function getDeploymentStatus(deploymentId: string): Promise<DeploymentStatusResponse> {
  const response = await fetch(endpoint(`/api/v1/deployments/${encodeURIComponent(deploymentId)}`), { credentials: 'include' });
  const body = asRecord(await readJson(response), '배포 상태');
  return { ...body, currentStep: body.currentStep, approvalPending: body.approvalPending, publicUrl: body.publicUrl };
}

/** API-19 — analysis summary becomes available once analysis completes. */
export async function getDeploymentAnalysisReport(deploymentId: string): Promise<DeploymentAnalysisReportResponse> {
  const response = await fetch(endpoint(`/api/v1/deployments/${encodeURIComponent(deploymentId)}/analysis-report`), { credentials: 'include' });
  const body = asRecord(await readJson(response), '분석 리포트');
  return {
    deploymentId: typeof body.deploymentId === 'number' ? body.deploymentId : Number(deploymentId),
    detectedStack: body.detectedStack,
    services: body.services,
    resources: body.resources,
    warnings: body.warnings,
    unresolved: body.unresolved,
    irValid: body.irValid,
    irErrors: body.irErrors,
    migrationTool: body.migrationTool,
    missingEnvNames: Array.isArray(body.missingEnvNames) ? body.missingEnvNames.filter((name): name is string => typeof name === 'string') : null,
    createdAt: body.createdAt,
  };
}

/** API-08 — the generated IR is exposed as an opaque payload until a display schema is finalized. */
export async function getDeploymentIr(deploymentId: string): Promise<DeploymentIrResponse> {
  const response = await fetch(endpoint(`/api/v1/deployments/${encodeURIComponent(deploymentId)}/ir`), { credentials: 'include' });
  const body = asRecord(await readJson(response), 'IR');
  return { deploymentId: body.deploymentId, ir: body.ir, version: body.version, generatedAt: body.generatedAt, source: body.source };
}

/**
 * IR 일부 수정 (#144). 서버는 awaiting_target_confirmation 상태에서만 받아 준다(그 밖은 409 IR_NOT_EDITABLE).
 * version은 GET /ir로 받은 값이어야 한다(다르면 409 IR_VERSION_CONFLICT).
 */
export async function patchDeploymentIr(deploymentId: string, ir: Record<string, unknown>, version: number): Promise<void> {
  const response = await fetch(endpoint(`/api/v1/deployments/${encodeURIComponent(deploymentId)}/ir`), {
    method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ir, version }),
  });
  await assertOk(response);
}

/** 한국어 · 일본어 설명 (#147). 두 언어 값이 없는 예전 데이터는 두 언어 모두 서버가 준 원문 */
export interface LocalizedText { ko: string; ja: string }

function readLocalized(value: unknown, fallback: string): LocalizedText {
  if (value && typeof value === 'object') {
    const { ko, ja } = value as { ko?: unknown; ja?: unknown };
    if (typeof ko === 'string' && typeof ja === 'string') return { ko, ja };
  }
  return { ko: fallback, ja: fallback };
}

export interface DeploymentPatchCandidate { description: LocalizedText; diff: string }
export interface DeploymentDiagnosisResponse { failedStep: string | null; summary: LocalizedText; patchCandidates: DeploymentPatchCandidate[] }

/** API-36 — 실패한 배포의 AI 진단. 진단이 아직 없으면(404) null. */
export async function getDeploymentDiagnosis(deploymentId: string): Promise<DeploymentDiagnosisResponse | null> {
  const response = await fetch(endpoint(`/api/v1/deployments/${encodeURIComponent(deploymentId)}/diagnosis`), { credentials: 'include' });
  if (response.status === 404) return null;
  const body = asRecord(await readJson(response), 'AI 진단');
  if (typeof body.summary !== 'string') throw new ResponseFormatError('AI 진단 응답 형식이 올바르지 않습니다.');
  const patchCandidates = (Array.isArray(body.patchCandidates) ? body.patchCandidates : []).flatMap((item): DeploymentPatchCandidate[] => {
    if (!item || typeof item !== 'object') return [];
    const { description, descriptionI18n, diff } = item as { description?: unknown; descriptionI18n?: unknown; diff?: unknown };
    return typeof description === 'string' && typeof diff === 'string' ? [{ description: readLocalized(descriptionI18n, description), diff }] : [];
  });
  return { failedStep: typeof body.failedStep === 'string' ? body.failedStep : null, summary: readLocalized(body.summaryI18n, body.summary), patchCandidates };
}

/**
 * 재배포 (#138) — 끝난 배포의 소스 · IR · 대상 환경을 그대로 써서 새 배포를 만든다. 분석과 대상 승인을 건너뛰고 빌드부터 시작한다.
 * targetEnvironmentId를 주면 그 환경으로 배포한다(다른 환경으로 배포, #220). 이전 배포를 그대로 재배포하면 롤백이 된다.
 * 소스 배포가 진행 중이거나 환경이 사용 중이면 409, 분석 결과가 없거나 다른 프로젝트의 환경이면 400.
 */
export async function redeployDeployment(deploymentId: string, targetEnvironmentId?: string, mode?: DeployMode): Promise<{ deploymentId: string }> {
  const response = await fetch(endpoint(`/api/v1/deployments/${encodeURIComponent(deploymentId)}/redeploy`), {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    // 서버 계약은 숫자 문자열 ID (RedeployBodySchema). mode 를 주면 앱의 배포 형태도 바뀐다 (#282)
    body: JSON.stringify({ ...(targetEnvironmentId ? { targetEnvironmentId } : {}), ...(mode ? { mode } : {}) }),
  });
  const body = asRecord(await readJson(response), '재배포');
  const id = typeof body.deploymentId === 'string' || typeof body.deploymentId === 'number' ? String(body.deploymentId) : '';
  if (!id) throw new ResponseFormatError('재배포 응답 형식이 올바르지 않습니다.');
  return { deploymentId: id };
}

/**
 * 진행 중인 배포 취소. 서버가 상태를 cancelled로 바꾸고 환경 락을 풀어 준다(같은 환경에 다시 배포할 수 있게 된다).
 * 이미 끝난 배포면 409.
 */
export async function cancelDeployment(deploymentId: string): Promise<void> {
  const response = await fetch(endpoint(`/api/v1/deployments/${encodeURIComponent(deploymentId)}/cancel`), {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'cancelled by user (web)' }),
  });
  await assertOk(response);
}

/** patch = 코드 수정안(SQLite → PostgreSQL, #277) — 원클릭에서 사용자가 직접 결정하는 유일한 게이트 */
export type ApprovalGate = 'patch' | 'target' | 'plan';

/**
 * API-11 — 승인 게이트 통과. 원클릭 흐름에서 프론트가 사용자 입력 없이 호출한다 (2026-10-01 팀 결정:
 * 사용자는 벤더만 고르고 대상 확인은 승인으로 받지 않는다). 프론트는 target만 호출하고, plan 승인은 서버가 자동으로 처리한다.
 */
export async function approveDeploymentGate(deploymentId: string, gate: ApprovalGate, note: string): Promise<void> {
  await decideDeploymentGate(deploymentId, gate, 'approve', note);
}

/** 승인 · 거절. 코드 수정안(patch)은 거절해도 실패가 아니라 원래 소스(SQLite 그대로)로 배포를 이어 간다. */
export async function decideDeploymentGate(deploymentId: string, gate: ApprovalGate, decision: 'approve' | 'reject', note: string): Promise<void> {
  const response = await fetch(endpoint(`/api/v1/deployments/${encodeURIComponent(deploymentId)}/approvals`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gate, decision, note }),
    credentials: 'include',
  });
  await assertOk(response);
}

export interface SourcePatchFile { path: string; change: 'added' | 'modified'; additions: number; deletions: number; /** 규칙으로 다시 만든 파일(package-lock.json) — diff 에 없음 */ generated: boolean }
export interface DeploymentSourcePatch {
  status: 'pending' | 'approved' | 'rejected';
  summary: LocalizedText;
  notes: LocalizedText[];
  /** unified diff (generated 파일 제외) */
  diff: string;
  files: SourcePatchFile[];
  model: string | null;
}

/** 코드 수정안 (#277). 수정안이 없는 배포(404)는 null. */
export async function getDeploymentPatch(deploymentId: string): Promise<DeploymentSourcePatch | null> {
  const response = await fetch(endpoint(`/api/v1/deployments/${encodeURIComponent(deploymentId)}/patch`), { credentials: 'include' });
  if (response.status === 404) return null;
  const body = asRecord(await readJson(response), '코드 수정안');
  if (typeof body.summary !== 'string' || typeof body.diff !== 'string') throw new ResponseFormatError('코드 수정안 응답 형식이 올바르지 않습니다.');
  const status = body.status === 'approved' || body.status === 'rejected' ? body.status : 'pending';
  const files = (Array.isArray(body.files) ? body.files : []).flatMap((item): SourcePatchFile[] => {
    if (!item || typeof item !== 'object') return [];
    const file = item as Record<string, unknown>;
    if (typeof file.path !== 'string') return [];
    return [{
      path: file.path,
      change: file.change === 'added' ? 'added' : 'modified',
      additions: typeof file.additions === 'number' ? file.additions : 0,
      deletions: typeof file.deletions === 'number' ? file.deletions : 0,
      generated: file.generated === true,
    }];
  });
  const notes = Array.isArray(body.notes) ? body.notes.filter((note): note is string => typeof note === 'string') : [];
  const notesI18n = Array.isArray(body.notesI18n) ? body.notesI18n.map((note) => readLocalized(note, '')) : null;
  return {
    status, summary: readLocalized(body.summaryI18n, body.summary), diff: body.diff, files,
    notes: notesI18n ?? notes.map((note) => readLocalized(null, note)),
    model: typeof body.model === 'string' ? body.model : null,
  };
}

/** 배포 연결(환경, API-24). 화면에는 종류 · 기본 여부 · 표시용 값(리전 / 호스트 이름) · Agent 상태만 쓴다. */
export interface EnvironmentSummary {
  id: string; name: string; type: 'aws' | 'onprem'; isDefault: boolean; region: string | null; hostname: string | null;
  /** 프로젝트 없이 등록한 공용 연결인지 (#215). false면 한 프로젝트에만 묶인 예전 방식의 연결 */
  shared: boolean;
  /** 이 환경이 참조하는 시크릿 이름 (AWS access_key 방식). 값은 응답에 없다. */
  secretNames: string[];
  /** 온프레미스 Agent가 최근 90초 안에 연락했는지 (서버 판정). AWS면 false */
  agentOnline: boolean;
  /** 등록된 Agent의 마지막 연락 시각. Agent를 아직 등록하지 않았으면 null */
  agentLastSeenAt: string | null;
}

function environmentsOf(body: unknown): EnvironmentSummary[] {
  return (Array.isArray(body) ? body : []).flatMap((item): EnvironmentSummary[] => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    if (record.type !== 'aws' && record.type !== 'onprem') return [];
    const aws = record.awsConfig && typeof record.awsConfig === 'object' ? record.awsConfig as Record<string, unknown> : {};
    const onprem = record.onpremConfig && typeof record.onpremConfig === 'object' ? record.onpremConfig as Record<string, unknown> : {};
    return [{
      id: String(record.id), name: typeof record.name === 'string' ? record.name : '', type: record.type, isDefault: record.isDefault === true,
      region: typeof aws.region === 'string' ? aws.region : null, hostname: typeof onprem.hostname === 'string' ? onprem.hostname : null,
      shared: record.shared === true,
      secretNames: [aws.accessKeyIdSecretName, aws.secretAccessKeySecretName].filter((name): name is string => typeof name === 'string'),
      agentOnline: record.agentOnline === true,
      agentLastSeenAt: typeof record.agentLastSeenAt === 'string' ? record.agentLastSeenAt : null,
    }];
  });
}

/** API-24 — 한 프로젝트에만 묶인 (예전 방식의) 배포 연결 목록. 공용 연결은 들어 있지 않다. */
export async function listEnvironments(projectId: string): Promise<EnvironmentSummary[]> {
  const response = await fetch(endpoint(`/api/v1/environments?projectId=${encodeURIComponent(projectId)}`), { credentials: 'include' });
  return environmentsOf(await readJson(response));
}

/** 공용 연결 목록 (#215). 한 번 등록하면 모든 앱이 배포할 때 고를 수 있다. */
export async function listSharedEnvironments(): Promise<EnvironmentSummary[]> {
  const response = await fetch(endpoint('/api/v1/environments'), { credentials: 'include' });
  return environmentsOf(await readJson(response));
}

/** 배포 연결 삭제. 진행 중인 배포가 있거나 이 연결로 배포한 기록이 있으면 서버가 409로 거절한다(deployments가 연결을 참조). */
export async function deleteEnvironment(environmentId: string): Promise<void> {
  const response = await fetch(endpoint(`/api/v1/environments/${encodeURIComponent(environmentId)}`), { method: 'DELETE', credentials: 'include' });
  await assertOk(response);
}

/** 이 연결을 같은 종류(AWS / 온프레미스)의 기본 연결로 바꾼다 (#228). 원래 기본이던 연결은 서버가 함께 푼다. */
export async function setDefaultEnvironment(environmentId: string): Promise<void> {
  const response = await fetch(endpoint(`/api/v1/environments/${encodeURIComponent(environmentId)}`), {
    method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isDefault: true }),
  });
  await assertOk(response);
}

function randomSuffix(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 공용 연결 안에서 겹치지 않는 이름 (서버는 같은 이름을 409로 거절한다). 겹치면 -2, -3 …을 붙인다. */
function uniqueName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
}

async function postEnvironment(body: Record<string, unknown>): Promise<string> {
  const response = await fetch(endpoint('/api/v1/environments'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'include',
  });
  const created = asRecord(await readJson(response), '연결 등록');
  return String(created.id);
}

/** 공용 시크릿 저장 (API-28, projectId 없음). 값은 응답에 돌아오지 않는다. */
async function saveSharedSecret(name: string, value: string): Promise<void> {
  const response = await fetch(endpoint('/api/v1/secrets'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, value }), credentials: 'include',
  });
  await assertOk(response);
}

/** 공용 시크릿 삭제. 연결을 지운 뒤 그 연결만 쓰던 키를 치울 때 쓴다. */
export async function deleteSharedSecret(name: string): Promise<void> {
  const response = await fetch(endpoint(`/api/v1/secrets/${encodeURIComponent(name)}`), { method: 'DELETE', credentials: 'include' });
  await assertOk(response);
}

/**
 * 공용 AWS 연결 등록 — 키 두 개를 공용 시크릿으로 저장한 뒤 그 이름을 참조하는 연결을 만든다.
 * 키 값은 시크릿 저장 요청에만 실리고, 연결에는 시크릿 이름과 리전만 들어간다. 시크릿 이름은 연결마다 새로 지어 다른 연결의 키와 섞이지 않게 한다.
 * 연결을 만들지 못하면 방금 저장한 키를 지운다.
 */
export async function createSharedAwsConnection(input: { accessKeyId: string; secretAccessKey: string; region: string }, takenNames: string[]): Promise<void> {
  const suffix = randomSuffix();
  const keyIdName = `aws-access-key-id.${suffix}`;
  const secretKeyName = `aws-secret-access-key.${suffix}`;
  try {
    await saveSharedSecret(keyIdName, input.accessKeyId);
    await saveSharedSecret(secretKeyName, input.secretAccessKey);
    await postEnvironment({
      // 같은 리전에 계정을 여럿 등록해도 구분되게 Access Key ID 끝 네 자리를 붙인다 (Access Key ID는 비밀 값이 아니다).
      name: uniqueName(`aws-${input.region}-${input.accessKeyId.slice(-4)}`, takenNames), type: 'aws',
      awsConfig: { credentialsType: 'access_key', accessKeyIdSecretName: keyIdName, secretAccessKeySecretName: secretKeyName, region: input.region },
    });
  } catch (error) {
    await Promise.allSettled([deleteSharedSecret(keyIdName), deleteSharedSecret(secretKeyName)]);
    throw error;
  }
}

/**
 * 공용 온프레미스 연결 등록. 만든 연결의 ID를 돌려준다.
 * 계약상 onpremConfig.agentRegistrationToken이 필수라 임의 값을 넣는다. Agent 인증에는 쓰이지 않는다 — 실제 등록 토큰은 issueAgentRegistrationToken으로 따로 발급한다.
 */
export async function createSharedOnpremConnection(hostname: string, takenNames: string[]): Promise<string> {
  const placeholder = `${randomSuffix()}${randomSuffix()}${randomSuffix()}${randomSuffix()}`;
  const base = `onprem-${hostname.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'server'}`;
  return postEnvironment({ name: uniqueName(base, takenNames), type: 'onprem', onpremConfig: { agentRegistrationToken: placeholder, hostname } });
}

export interface AgentRegistrationToken { token: string; expiresAt: string }

/** On-Prem Agent 1회용 등록 토큰 발급 (10분 유효). 값은 이 응답에서 한 번만 받는다. */
export async function issueAgentRegistrationToken(environmentId: string): Promise<AgentRegistrationToken> {
  const response = await fetch(endpoint(`/api/v1/environments/${encodeURIComponent(environmentId)}/agent-registration-token`), { method: 'POST', credentials: 'include' });
  const body = asRecord(await readJson(response), '등록 토큰');
  if (typeof body.token !== 'string' || typeof body.expiresAt !== 'string') throw new ResponseFormatError('등록 토큰 응답 형식이 올바르지 않습니다.');
  return { token: body.token, expiresAt: body.expiresAt };
}

export interface ProjectEnvVar { name: string; value: string; updatedAt: string | null }

function envVarsOf(body: unknown): ProjectEnvVar[] {
  const items = body && typeof body === 'object' && Array.isArray((body as { items?: unknown }).items) ? (body as { items: unknown[] }).items : [];
  return items.flatMap((item) => {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return typeof record.name === 'string' && typeof record.value === 'string' ? [{ name: record.name, value: record.value, updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null }] : [];
  });
}

/** DAT-01 — 프로젝트 환경변수(평문 설정값) 목록. 이름순. */
export async function listProjectEnv(projectId: string): Promise<ProjectEnvVar[]> {
  const response = await fetch(endpoint(`/api/v1/projects/${encodeURIComponent(projectId)}/env`), { credentials: 'include' });
  return envVarsOf(await readJson(response));
}

/** DAT-01 — 환경변수 추가 · 수정 · 삭제(값 null). 바뀐 뒤의 전체 목록을 돌려준다. 다음 배포부터 적용된다. */
export async function patchProjectEnv(projectId: string, vars: Record<string, string | null>): Promise<ProjectEnvVar[]> {
  const response = await fetch(endpoint(`/api/v1/projects/${encodeURIComponent(projectId)}/env`), {
    method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vars }),
  });
  return envVarsOf(await readJson(response));
}

export interface DeploymentAiUsageResponse { totalTokenIn: number; totalTokenOut: number; totalCostUsd: number }

/** API-32 — 이 배포에 쓴 AI 토큰 · 비용. */
export async function getDeploymentAiUsage(deploymentId: string): Promise<DeploymentAiUsageResponse> {
  const response = await fetch(endpoint(`/api/v1/deployments/${encodeURIComponent(deploymentId)}/ai-usage`), { credentials: 'include' });
  const body = asRecord(await readJson(response), 'AI 사용량');
  const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  return { totalTokenIn: number(body.totalTokenIn), totalTokenOut: number(body.totalTokenOut), totalCostUsd: number(body.totalCostUsd) };
}

export interface CostLineItem { key: string; monthlyUsd: number; usageBased: boolean }
export interface MonthlyCostEstimate { region: string | null; monthlyUsd: number; items: CostLineItem[] }

/** #327 — 이 배포의 월 예상 인프라 비용. 프로필 · IR 이 아직 없으면 null. */
export async function getDeploymentCostEstimate(deploymentId: string): Promise<MonthlyCostEstimate | null> {
  const response = await fetch(endpoint(`/api/v1/deployments/${encodeURIComponent(deploymentId)}/cost-estimate`), { credentials: 'include' });
  const body = asRecord(await readJson(response), '월 예상 비용');
  const estimate = body.estimate && typeof body.estimate === 'object' ? body.estimate as Record<string, unknown> : null;
  if (!estimate || typeof estimate.monthlyUsd !== 'number') return null;
  const items = (Array.isArray(estimate.items) ? estimate.items : []).flatMap((item): CostLineItem[] => {
    if (!item || typeof item !== 'object') return [];
    const line = item as Record<string, unknown>;
    return typeof line.key === 'string' && typeof line.monthlyUsd === 'number'
      ? [{ key: line.key, monthlyUsd: line.monthlyUsd, usageBased: line.usageBased === true }]
      : [];
  });
  return { region: typeof estimate.region === 'string' ? estimate.region : null, monthlyUsd: estimate.monthlyUsd, items };
}

/** API-21 — 헬스체크 현황. 검증 기록이 아직 없으면(404) null. */
export async function getDeploymentHealth(deploymentId: string): Promise<DeploymentHealthResponse | null> {
  const response = await fetch(endpoint(`/api/v1/deployments/${encodeURIComponent(deploymentId)}/health`), { credentials: 'include' });
  if (response.status === 404) return null;
  const body = asRecord(await readJson(response), '헬스체크');
  const status = body.status === 'passed' || body.status === 'failed' ? body.status : 'checking';
  const phase = body.phase === 'target' || body.phase === 'origin_switching' || body.phase === 'public_url' ? body.phase : undefined;
  const checks = (Array.isArray(body.checks) ? body.checks : []).flatMap((item): DeploymentHealthCheck[] => {
    if (!item || typeof item !== 'object') return [];
    const check = item as Record<string, unknown>;
    if (typeof check.attempt !== 'number' || typeof check.passed !== 'boolean') return [];
    return [{ attempt: check.attempt, passed: check.passed, statusCode: typeof check.statusCode === 'number' ? check.statusCode : undefined, latencyMs: typeof check.latencyMs === 'number' ? check.latencyMs : undefined }];
  });
  return {
    status,
    ...(phase ? { phase } : {}),
    checks,
    consecutivePassed: typeof body.consecutivePassed === 'number' ? body.consecutivePassed : 0,
    requiredPasses: typeof body.requiredPasses === 'number' ? body.requiredPasses : 3,
  };
}

/** packages/contracts LOG_STEPS — the logs endpoint requires one of these as `step`. */
export const deploymentLogSteps = ['analyze', 'build', 'provision', 'verify'] as const;
export type DeploymentLogStep = typeof deploymentLogSteps[number];

/** API-12 — the P0 non-streaming log view of one step. 204 (no log yet) → null. `tail` limits to the last N lines. */
export async function getDeploymentLogs(deploymentId: string, step: DeploymentLogStep, tail?: number): Promise<string | null> {
  const query = new URLSearchParams({ step });
  if (tail) query.set('tail', String(tail));
  const response = await fetch(endpoint(`/api/v1/deployments/${encodeURIComponent(deploymentId)}/logs?${query}`), { credentials: 'include' });
  if (response.status === 204) return null;
  if (!response.ok) throw new DeploymentApiError(response.status, `로그를 불러오지 못했습니다. (${response.status})`);
  return response.text();
}

export function deploymentEventsUrl(deploymentId: string): string {
  return endpoint(`/api/v1/deployments/${encodeURIComponent(deploymentId)}/events`);
}

/** 지금 프로젝트 주소로 서비스 중인 배포 (가장 최근에 성공한 배포). environmentType은 환경 없이 만든 옛 배포면 null */
export interface ProjectLiveDeployment {
  deploymentId: string;
  environmentType: 'aws' | 'onprem' | null;
  environmentName: string | null;
  /** 서비스 중인 배포의 프로필 (aws-lambda-basic 이면 서버리스) */
  targetProfile: string | null;
  publicUrl: string | null;
  succeededAt: string | null;
}

/** 상태와 상관없이 가장 최근에 만든 배포 */
export interface ProjectLatestDeployment {
  deploymentId: string;
  status: string;
  environmentType: 'aws' | 'onprem' | null;
  createdAt: string;
}

/** 자동으로 정리하지 못해 사용자가 직접 해야 하는 일. ONPREM_MANUAL_CLEANUP: 온프레미스 컨테이너는 직접 내려야 한다 */
export type ProjectDeletionWarning = 'ONPREM_MANUAL_CLEANUP';

/** 앱 삭제 진행 상태 (#247). 정리가 끝나면 앱 자체가 목록에서 사라진다 */
export interface ProjectDeletion {
  status: 'deleting' | 'failed';
  requestedAt: string;
  /** 실패 이유 (오류 코드, 다음 줄부터 상세). 진행 중이면 null */
  error: string | null;
  warnings: ProjectDeletionWarning[];
}

/** 앱 주소 변경 (#301) 진행 상태 */
export interface ProjectAddressChange {
  status: 'changing' | 'succeeded' | 'failed';
  from: string;
  to: string;
  requestedAt: string;
  finishedAt: string | null;
  /** 실패 이유 (오류 코드, 다음 줄부터 상세). 실패가 아니면 null */
  error: string | null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: string;
  /** 앱 주소의 앞부분 (#300). 예전 서버 응답에는 없어서 null */
  subdomain: string | null;
  /** 앱 공개 주소. 서버에 플랫폼 도메인 설정이 없으면 null */
  publicUrl: string | null;
  /** 마지막 주소 변경. 바꾼 적이 없으면 null */
  addressChange: ProjectAddressChange | null;
  /** 앱의 배포 형태 — 고르지 않은 배포 · 재배포 · 롤백이 따른다 */
  deployMode: DeployMode;
  /** 서비스 중인 배포가 없으면 null */
  live: ProjectLiveDeployment | null;
  /** 배포가 하나도 없으면 null */
  latest: ProjectLatestDeployment | null;
  /** 삭제를 요청하지 않았으면 null */
  deletion: ProjectDeletion | null;
}

export type EnvironmentType = 'aws' | 'onprem';

export interface ProjectDeploymentSummary {
  id: string;
  status: string;
  targetProfile: string | null;
  publicUrl: string | null;
  sourceSha256: string | null;
  createdAt: string;
  succeededAt: string | null;
  failedAt: string | null;
  /** 배포한 환경. 환경 기록이 없으면 null */
  environmentId: string | null;
  environmentType: EnvironmentType | null;
  environmentName: string | null;
  /** 지금 프로젝트 주소로 서비스 중인 배포(가장 최근에 성공한 배포)인지 */
  isLive: boolean;
}

export interface Page<T> { items: T[]; nextCursor: string | null; }

function optionalString(value: unknown): string | null { return typeof value === 'string' ? value : null; }

function environmentTypeOf(value: unknown): 'aws' | 'onprem' | null { return value === 'aws' || value === 'onprem' ? value : null; }

function parseDeletion(value: unknown): ProjectDeletion | null {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  const status = record?.status;
  const requestedAt = optionalString(record?.requestedAt);
  if ((status !== 'deleting' && status !== 'failed') || !requestedAt) return null;
  return {
    status, requestedAt,
    error: optionalString(record?.error),
    warnings: (Array.isArray(record?.warnings) ? record.warnings : []).filter((warning): warning is ProjectDeletionWarning => warning === 'ONPREM_MANUAL_CLEANUP'),
  };
}

function parseAddressChange(value: unknown): ProjectAddressChange | null {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  const status = record?.status;
  const from = optionalString(record?.from);
  const to = optionalString(record?.to);
  const requestedAt = optionalString(record?.requestedAt);
  if ((status !== 'changing' && status !== 'succeeded' && status !== 'failed') || from === null || to === null || !requestedAt) return null;
  return { status, from, to, requestedAt, finishedAt: optionalString(record?.finishedAt), error: optionalString(record?.error) };
}

/** GET /projects · /projects/:id 의 항목 한 개. id · name · createdAt이 없으면 null */
function parseProject(value: unknown): ProjectSummary | null {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const id = optionalString(record.id);
  const name = optionalString(record.name);
  const createdAt = optionalString(record.createdAt);
  if (!id || !name || !createdAt) return null;
  const live = record.live && typeof record.live === 'object' ? record.live as Record<string, unknown> : null;
  const latest = record.latest && typeof record.latest === 'object' ? record.latest as Record<string, unknown> : null;
  const liveId = optionalString(live?.deploymentId);
  const latestId = optionalString(latest?.deploymentId);
  const latestStatus = optionalString(latest?.status);
  const latestCreatedAt = optionalString(latest?.createdAt);
  return {
    id, name, createdAt,
    subdomain: optionalString(record.subdomain),
    publicUrl: optionalString(record.publicUrl),
    addressChange: parseAddressChange(record.addressChange),
    deployMode: record.deployMode === 'serverless' ? 'serverless' : 'container',
    live: live && liveId ? {
      deploymentId: liveId,
      environmentType: environmentTypeOf(live.environmentType),
      environmentName: optionalString(live.environmentName),
      targetProfile: optionalString(live.targetProfile),
      publicUrl: optionalString(live.publicUrl),
      succeededAt: optionalString(live.succeededAt),
    } : null,
    latest: latest && latestId && latestStatus && latestCreatedAt ? {
      deploymentId: latestId,
      status: latestStatus,
      environmentType: environmentTypeOf(latest.environmentType),
      createdAt: latestCreatedAt,
    } : null,
    deletion: parseDeletion(record.deletion),
  };
}

/** GET /projects — project list, id ascending with cursor pagination. */
export async function listProjects(options: { limit?: number; cursor?: string } = {}): Promise<Page<ProjectSummary>> {
  const query = new URLSearchParams({ limit: String(options.limit ?? 100) });
  if (options.cursor) query.set('cursor', options.cursor);
  const response = await fetch(endpoint(`/api/v1/projects?${query}`), { credentials: 'include' });
  const body = asRecord(await readJson(response), '프로젝트 목록');
  const items = Array.isArray(body.items) ? body.items : [];
  return {
    items: items.flatMap((item) => {
      const project = parseProject(item);
      return project ? [project] : [];
    }),
    nextCursor: optionalString(body.nextCursor),
  };
}

/** GET /projects/:id/deployments (API-22) — deployment history of one project, newest first. */
export async function listProjectDeployments(projectId: string, options: { limit?: number } = {}): Promise<Page<ProjectDeploymentSummary>> {
  const query = new URLSearchParams({ limit: String(options.limit ?? 5) });
  const response = await fetch(endpoint(`/api/v1/projects/${encodeURIComponent(projectId)}/deployments?${query}`), { credentials: 'include' });
  const body = asRecord(await readJson(response), '배포 이력');
  const items = Array.isArray(body.items) ? body.items : [];
  return {
    items: items.flatMap((item) => {
      const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const id = optionalString(record.id);
      const status = optionalString(record.status);
      const createdAt = optionalString(record.createdAt);
      if (!id || !status || !createdAt) return [];
      const sourceVersion = record.sourceVersion && typeof record.sourceVersion === 'object' ? record.sourceVersion as Record<string, unknown> : null;
      return [{
        id, status, createdAt,
        targetProfile: optionalString(record.targetProfile),
        publicUrl: optionalString(record.publicUrl),
        sourceSha256: optionalString(sourceVersion?.sha256),
        succeededAt: optionalString(record.succeededAt),
        failedAt: optionalString(record.failedAt),
        environmentId: optionalString(record.environmentId),
        environmentType: environmentTypeOf(record.environmentType),
        environmentName: optionalString(record.environmentName),
        isLive: record.isLive === true,
      }];
    }),
    nextCursor: optionalString(body.nextCursor),
  };
}

/** GET /projects/:id — the project name (progress screen) and where it is served now (project detail). */
export async function getProject(projectId: string): Promise<ProjectSummary> {
  const response = await fetch(endpoint(`/api/v1/projects/${encodeURIComponent(projectId)}`), { credentials: 'include' });
  const project = parseProject(asRecord(await readJson(response), '프로젝트'));
  if (!project) throw new ResponseFormatError('프로젝트 응답 형식이 올바르지 않습니다.');
  return project;
}

/**
 * DELETE /projects/:id (#247) — 앱 삭제를 시작한다 (202). AWS 리소스 · 공개 주소 · 배포 기록은 서버가 이어서 정리하고,
 * 진행 상황은 getProject 의 deletion 으로 본다 (끝나면 404). 진행 중인 배포가 있으면 409 PROJECT_DEPLOYMENT_IN_PROGRESS.
 */
export async function deleteProject(projectId: string): Promise<ProjectDeletion> {
  const response = await fetch(endpoint(`/api/v1/projects/${encodeURIComponent(projectId)}`), { method: 'DELETE', credentials: 'include' });
  const body = asRecord(await readJson(response), '앱 삭제');
  const deletion = parseDeletion(body.deletion);
  if (!deletion) throw new ResponseFormatError('앱 삭제 응답 형식이 올바르지 않습니다.');
  return deletion;
}

export type SubdomainUnavailableReason = 'format' | 'reserved' | 'taken';
export interface SubdomainAvailability { name: string; available: boolean; reason: SubdomainUnavailableReason | null }

/** GET /projects/subdomain-availability (#300) — 앱 주소를 쓸 수 있는지 (형식 · 예약어 · 다른 앱 사용 중) */
export async function checkSubdomain(name: string, signal?: AbortSignal): Promise<SubdomainAvailability> {
  const query = new URLSearchParams({ name });
  const response = await fetch(endpoint(`/api/v1/projects/subdomain-availability?${query}`), { credentials: 'include', signal });
  const body = asRecord(await readJson(response), '주소 확인');
  const reason = body.reason === 'format' || body.reason === 'reserved' || body.reason === 'taken' ? body.reason : null;
  return { name: optionalString(body.name) ?? name, available: body.available === true, reason };
}

/**
 * PATCH /projects/:id/subdomain (#301) — 앱 주소 변경. 서비스 중인 배포가 있으면 202 로 받고 서버가 새 주소를 연결 · 확인한 뒤
 * 바꾼다(진행은 getProject 의 addressChange). 서비스 중인 배포가 없으면 바로 바뀐다(200).
 */
export async function changeProjectSubdomain(projectId: string, subdomain: string): Promise<ProjectSummary> {
  const response = await fetch(endpoint(`/api/v1/projects/${encodeURIComponent(projectId)}/subdomain`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subdomain }),
    credentials: 'include',
  });
  const project = parseProject(asRecord(await readJson(response), '주소 변경'));
  if (!project) throw new ResponseFormatError('주소 변경 응답 형식이 올바르지 않습니다.');
  return project;
}
