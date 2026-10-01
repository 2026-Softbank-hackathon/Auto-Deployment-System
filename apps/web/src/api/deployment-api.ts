const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');

export class DeploymentApiError extends Error {
  /**
   * code — 서버 오류 본문의 error.code (예: DEPLOYMENT_LOCKED). 본문을 읽은 경우에만 있다.
   * serverMessage — 서버가 준 설명(error.message). 화면이 모르는 오류 코드일 때 그대로 보여 준다.
   */
  constructor(public readonly status: number, message: string, public readonly code?: string, public readonly serverMessage?: string) {
    super(message);
    this.name = 'DeploymentApiError';
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
  checks: DeploymentHealthCheck[];
  consecutivePassed: number;
  requiredPasses: number;
}

function endpoint(path: string): string {
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

async function readJson(response: Response): Promise<unknown> {
  await assertOk(response);
  return response.json();
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 응답 형식이 올바르지 않습니다.`);
  return value as Record<string, unknown>;
}

/**
 * Current backend contract for the P0 demo upload endpoint.
 * `target` is the vendor (aws | onprem); the server resolves it to a profile and to the project's default environment.
 */
export async function createDeployment(source: File, projectId: string, target: string): Promise<CreateDeploymentResponse> {
  const form = new FormData();
  form.append('source', source);
  form.append('project_id', projectId);
  form.append('target', target);

  const response = await fetch(endpoint('/api/v1/deployments'), {
    method: 'POST',
    body: form,
    credentials: 'include',
  });
  const body = asRecord(await readJson(response), '배포 생성');
  const deploymentId = typeof body.deploymentId === 'string' ? body.deploymentId : null;
  const status = body.status === 'received' ? body.status : null;
  const eventsUrl = typeof body.eventsUrl === 'string' ? body.eventsUrl : null;
  if (!deploymentId || !status || !eventsUrl) throw new Error('배포 생성 응답 형식이 올바르지 않습니다.');
  return { deploymentId, status, eventsUrl };
}

/** API-02 — 프로젝트 생성. 프로젝트는 한 애플리케이션의 배포 이력을 묶는 단위라 처음 한 번만 만든다. */
export async function createProject(name: string): Promise<CreateProjectResponse> {
  const response = await fetch(endpoint('/api/v1/projects'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
    credentials: 'include',
  });
  const body = asRecord(await readJson(response), '프로젝트 생성');
  const id = typeof body.id === 'string' ? body.id : null;
  const projectName = typeof body.name === 'string' ? body.name : null;
  if (!id || !projectName) throw new Error('프로젝트 생성 응답 형식이 올바르지 않습니다.');
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

export interface DeploymentPatchCandidate { description: string; diff: string }
export interface DeploymentDiagnosisResponse { failedStep: string | null; summary: string; patchCandidates: DeploymentPatchCandidate[] }

/** API-36 — 실패한 배포의 AI 진단. 진단이 아직 없으면(404) null. */
export async function getDeploymentDiagnosis(deploymentId: string): Promise<DeploymentDiagnosisResponse | null> {
  const response = await fetch(endpoint(`/api/v1/deployments/${encodeURIComponent(deploymentId)}/diagnosis`), { credentials: 'include' });
  if (response.status === 404) return null;
  const body = asRecord(await readJson(response), 'AI 진단');
  if (typeof body.summary !== 'string') throw new Error('AI 진단 응답 형식이 올바르지 않습니다.');
  const patchCandidates = (Array.isArray(body.patchCandidates) ? body.patchCandidates : []).flatMap((item): DeploymentPatchCandidate[] => {
    if (!item || typeof item !== 'object') return [];
    const { description, diff } = item as { description?: unknown; diff?: unknown };
    return typeof description === 'string' && typeof diff === 'string' ? [{ description, diff }] : [];
  });
  return { failedStep: typeof body.failedStep === 'string' ? body.failedStep : null, summary: body.summary, patchCandidates };
}

/**
 * 재배포 (#138) — 끝난 배포의 소스 · IR · 대상 환경을 그대로 써서 새 배포를 만든다. 분석과 대상 승인을 건너뛰고 빌드부터 시작한다.
 * 소스 배포가 진행 중이거나 환경이 사용 중이면 409, 분석 결과가 없으면 400.
 */
export async function redeployDeployment(deploymentId: string): Promise<{ deploymentId: string }> {
  const response = await fetch(endpoint(`/api/v1/deployments/${encodeURIComponent(deploymentId)}/redeploy`), {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  const body = asRecord(await readJson(response), '재배포');
  const id = typeof body.deploymentId === 'string' || typeof body.deploymentId === 'number' ? String(body.deploymentId) : '';
  if (!id) throw new Error('재배포 응답 형식이 올바르지 않습니다.');
  return { deploymentId: id };
}

export type ApprovalGate = 'target' | 'plan';

/**
 * API-11 — 승인 게이트 통과. 원클릭 흐름에서 프론트가 사용자 입력 없이 호출한다 (2026-10-01 팀 결정:
 * 사용자는 벤더만 고르고 대상 확인은 승인으로 받지 않는다). 프론트는 target만 호출하고, plan 승인은 서버가 자동으로 처리한다.
 */
export async function approveDeploymentGate(deploymentId: string, gate: ApprovalGate, note: string): Promise<void> {
  const response = await fetch(endpoint(`/api/v1/deployments/${encodeURIComponent(deploymentId)}/approvals`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gate, decision: 'approve', note }),
    credentials: 'include',
  });
  await assertOk(response);
}

/** 배포 환경 (API-24). 화면에는 종류 · 기본 여부 · 표시용 값(리전 / 호스트 이름)만 쓴다. */
export interface EnvironmentSummary {
  id: string; name: string; type: 'aws' | 'onprem'; isDefault: boolean; region: string | null; hostname: string | null;
  /** 이 환경이 참조하는 시크릿 이름 (AWS access_key 방식). 값은 응답에 없다. */
  secretNames: string[];
  /** 온프레미스 Agent가 마지막으로 연결을 알린 시각. 서버가 아직 채우지 않으면 null (모르는 상태). */
  lastSeenAt: string | null;
}

/** API-24 — 프로젝트에 등록된 배포 환경 목록. */
export async function listEnvironments(projectId: string): Promise<EnvironmentSummary[]> {
  const response = await fetch(endpoint(`/api/v1/environments?projectId=${encodeURIComponent(projectId)}`), { credentials: 'include' });
  const body = await readJson(response);
  return (Array.isArray(body) ? body : []).flatMap((item): EnvironmentSummary[] => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    if (record.type !== 'aws' && record.type !== 'onprem') return [];
    const aws = record.awsConfig && typeof record.awsConfig === 'object' ? record.awsConfig as Record<string, unknown> : {};
    const onprem = record.onpremConfig && typeof record.onpremConfig === 'object' ? record.onpremConfig as Record<string, unknown> : {};
    return [{
      id: String(record.id), name: typeof record.name === 'string' ? record.name : '', type: record.type, isDefault: record.isDefault === true,
      region: typeof aws.region === 'string' ? aws.region : null, hostname: typeof onprem.hostname === 'string' ? onprem.hostname : null,
      secretNames: [aws.accessKeyIdSecretName, aws.secretAccessKeySecretName].filter((name): name is string => typeof name === 'string'),
      lastSeenAt: typeof record.lastSeenAt === 'string' ? record.lastSeenAt : null,
    }];
  });
}

/** 배포 환경 삭제. 진행 중인 배포가 있으면 409, 이 환경으로 배포한 기록이 있으면 서버가 거절한다(deployments가 환경을 참조). */
export async function deleteEnvironment(environmentId: string): Promise<void> {
  const response = await fetch(endpoint(`/api/v1/environments/${encodeURIComponent(environmentId)}`), { method: 'DELETE', credentials: 'include' });
  await assertOk(response);
}

const ONPREM_ENVIRONMENT_NAME = 'onprem-default';

/**
 * 온프레미스 환경 등록 (API-23). 계약상 onpremConfig.agentRegistrationToken이 필수라 임의 값을 넣는다.
 * Agent 인증에는 쓰이지 않는다 — 실제 등록 토큰은 issueAgentRegistrationToken으로 따로 발급한다.
 */
export async function createOnpremEnvironment(projectId: string, hostname: string): Promise<EnvironmentSummary> {
  const placeholder = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const response = await fetch(endpoint('/api/v1/environments'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: Number(projectId), name: ONPREM_ENVIRONMENT_NAME, type: 'onprem', isDefault: true, onpremConfig: { agentRegistrationToken: placeholder, hostname } }),
    credentials: 'include',
  });
  const body = asRecord(await readJson(response), '환경 등록');
  return { id: String(body.id), name: ONPREM_ENVIRONMENT_NAME, type: 'onprem', isDefault: body.isDefault === true, region: null, hostname, secretNames: [], lastSeenAt: null };
}

export interface AgentRegistrationToken { token: string; expiresAt: string }

/** On-Prem Agent 1회용 등록 토큰 발급 (10분 유효). 값은 이 응답에서 한 번만 받는다. */
export async function issueAgentRegistrationToken(environmentId: string): Promise<AgentRegistrationToken> {
  const response = await fetch(endpoint(`/api/v1/environments/${encodeURIComponent(environmentId)}/agent-registration-token`), { method: 'POST', credentials: 'include' });
  const body = asRecord(await readJson(response), '등록 토큰');
  if (typeof body.token !== 'string' || typeof body.expiresAt !== 'string') throw new Error('등록 토큰 응답 형식이 올바르지 않습니다.');
  return { token: body.token, expiresAt: body.expiresAt };
}

/** API-29 — 프로젝트에 저장된 시크릿 이름 목록 (값은 응답에 없다). */
export async function listSecretNames(projectId: string): Promise<string[]> {
  const response = await fetch(endpoint(`/api/v1/secrets?projectId=${encodeURIComponent(projectId)}`), { credentials: 'include' });
  const body = await readJson(response);
  return (Array.isArray(body) ? body : []).flatMap((item) => (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string' ? [(item as { name: string }).name] : []));
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

/** 팀이 정한 시크릿 이름 (2026-10-01). 환경은 이 이름으로만 키를 참조한다. */
const AWS_ACCESS_KEY_ID_SECRET = 'AWS_ACCESS_KEY_ID';
const AWS_SECRET_ACCESS_KEY_SECRET = 'AWS_SECRET_ACCESS_KEY';
const AWS_ENVIRONMENT_NAME = 'aws-default';

/** API-28 · 30 — 시크릿 저장. 같은 이름이 있으면 지우고 다시 저장한다(키 교체). 값은 응답에 돌아오지 않는다. */
async function saveSecret(projectId: string, name: string, value: string): Promise<void> {
  const post = () => fetch(endpoint('/api/v1/secrets'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: Number(projectId), name, value }),
    credentials: 'include',
  });
  let response = await post();
  if (response.status === 409) {
    await assertOk(await fetch(endpoint(`/api/v1/secrets/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`), { method: 'DELETE', credentials: 'include' }));
    response = await post();
  }
  await assertOk(response);
}

/**
 * AWS 키 등록 — 시크릿 2개 저장(API-28) 후 그 이름을 참조하는 기본 AWS 환경을 만든다(API-23).
 * 키 값은 시크릿 저장 요청에만 실리고, 환경에는 시크릿 이름과 리전만 들어간다.
 * 이미 등록된 환경(current)이 있으면 키만 바꾼다. 리전이 달라졌을 때만 새 기본 환경을 만든다(이전 환경은 기본에서 내려간다).
 */
export async function registerAwsEnvironment(projectId: string, input: { accessKeyId: string; secretAccessKey: string; region: string }, current?: EnvironmentSummary | null): Promise<void> {
  await saveSecret(projectId, AWS_ACCESS_KEY_ID_SECRET, input.accessKeyId);
  await saveSecret(projectId, AWS_SECRET_ACCESS_KEY_SECRET, input.secretAccessKey);
  if (current && current.region === input.region) return;
  const name = current ? `aws-${input.region}-${Date.now()}` : AWS_ENVIRONMENT_NAME;
  const response = await fetch(endpoint('/api/v1/environments'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: Number(projectId), name, type: 'aws', isDefault: true,
      awsConfig: { credentialsType: 'access_key', accessKeyIdSecretName: AWS_ACCESS_KEY_ID_SECRET, secretAccessKeySecretName: AWS_SECRET_ACCESS_KEY_SECRET, region: input.region },
    }),
    credentials: 'include',
  });
  await assertOk(response);
}

export interface DeploymentAiUsageResponse { totalTokenIn: number; totalTokenOut: number; totalCostUsd: number }

/** API-32 — 이 배포에 쓴 AI 토큰 · 비용. */
export async function getDeploymentAiUsage(deploymentId: string): Promise<DeploymentAiUsageResponse> {
  const response = await fetch(endpoint(`/api/v1/deployments/${encodeURIComponent(deploymentId)}/ai-usage`), { credentials: 'include' });
  const body = asRecord(await readJson(response), 'AI 사용량');
  const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  return { totalTokenIn: number(body.totalTokenIn), totalTokenOut: number(body.totalTokenOut), totalCostUsd: number(body.totalCostUsd) };
}

/** API-21 — 헬스체크 현황. 검증 기록이 아직 없으면(404) null. */
export async function getDeploymentHealth(deploymentId: string): Promise<DeploymentHealthResponse | null> {
  const response = await fetch(endpoint(`/api/v1/deployments/${encodeURIComponent(deploymentId)}/health`), { credentials: 'include' });
  if (response.status === 404) return null;
  const body = asRecord(await readJson(response), '헬스체크');
  const status = body.status === 'passed' || body.status === 'failed' ? body.status : 'checking';
  const checks = (Array.isArray(body.checks) ? body.checks : []).flatMap((item): DeploymentHealthCheck[] => {
    if (!item || typeof item !== 'object') return [];
    const check = item as Record<string, unknown>;
    if (typeof check.attempt !== 'number' || typeof check.passed !== 'boolean') return [];
    return [{ attempt: check.attempt, passed: check.passed, statusCode: typeof check.statusCode === 'number' ? check.statusCode : undefined, latencyMs: typeof check.latencyMs === 'number' ? check.latencyMs : undefined }];
  });
  return {
    status,
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

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: string;
}

export interface ProjectDeploymentSummary {
  id: string;
  status: string;
  targetProfile: string | null;
  publicUrl: string | null;
  sourceSha256: string | null;
  createdAt: string;
  succeededAt: string | null;
  failedAt: string | null;
}

export interface Page<T> { items: T[]; nextCursor: string | null; }

function optionalString(value: unknown): string | null { return typeof value === 'string' ? value : null; }

/** GET /projects — project list, id ascending with cursor pagination. */
export async function listProjects(options: { limit?: number; cursor?: string } = {}): Promise<Page<ProjectSummary>> {
  const query = new URLSearchParams({ limit: String(options.limit ?? 100) });
  if (options.cursor) query.set('cursor', options.cursor);
  const response = await fetch(endpoint(`/api/v1/projects?${query}`), { credentials: 'include' });
  const body = asRecord(await readJson(response), '프로젝트 목록');
  const items = Array.isArray(body.items) ? body.items : [];
  return {
    items: items.flatMap((item) => {
      const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const id = optionalString(record.id);
      const name = optionalString(record.name);
      const createdAt = optionalString(record.createdAt);
      return id && name && createdAt ? [{ id, name, createdAt }] : [];
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
      }];
    }),
    nextCursor: optionalString(body.nextCursor),
  };
}

/** GET /projects/:id — used only to show the project name on the progress screen. */
export async function getProject(projectId: string): Promise<ProjectSummary> {
  const response = await fetch(endpoint(`/api/v1/projects/${encodeURIComponent(projectId)}`), { credentials: 'include' });
  const body = asRecord(await readJson(response), '프로젝트');
  const id = optionalString(body.id);
  const name = optionalString(body.name);
  const createdAt = optionalString(body.createdAt);
  if (!id || !name || !createdAt) throw new Error('프로젝트 응답 형식이 올바르지 않습니다.');
  return { id, name, createdAt };
}
