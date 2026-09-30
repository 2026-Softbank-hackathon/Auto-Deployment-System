const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');

export class DeploymentApiError extends Error {
  constructor(public readonly status: number, message: string) {
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
  createdAt: unknown;
}

export interface DeploymentIrResponse {
  deploymentId: unknown;
  ir: unknown;
  version: unknown;
  generatedAt: unknown;
}

function endpoint(path: string): string {
  const suffix = path.replace(/^\/api\/v1(?=\/|$)/, '');
  return `${apiBaseUrl}${suffix}`;
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new DeploymentApiError(response.status, `요청을 완료하지 못했습니다. (${response.status})`);
  return response.json();
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 응답 형식이 올바르지 않습니다.`);
  return value as Record<string, unknown>;
}

/**
 * Current backend contract for the P0 demo upload endpoint.
 * The target profile remains frontend configuration and the project is created automatically.
 */
export async function createDeployment(source: File, projectId: string, targetProfile: string): Promise<CreateDeploymentResponse> {
  const form = new FormData();
  form.append('source', source);
  form.append('project_id', projectId);
  form.append('target', targetProfile);

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

/** API-02 — create an opaque project record for a one-click deployment. */
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
    createdAt: body.createdAt,
  };
}

/** API-08 — the generated IR is exposed as an opaque payload until a display schema is finalized. */
export async function getDeploymentIr(deploymentId: string): Promise<DeploymentIrResponse> {
  const response = await fetch(endpoint(`/api/v1/deployments/${encodeURIComponent(deploymentId)}/ir`), { credentials: 'include' });
  const body = asRecord(await readJson(response), 'IR');
  return { deploymentId: body.deploymentId, ir: body.ir, version: body.version, generatedAt: body.generatedAt };
}

/** packages/contracts LOG_STEPS — the logs endpoint requires one of these as `step`. */
export const deploymentLogSteps = ['analyze', 'build', 'provision', 'verify'] as const;
export type DeploymentLogStep = typeof deploymentLogSteps[number];

/** API-12 — the P0 non-streaming log view of one step. 204 (no log yet) → null. */
export async function getDeploymentLogs(deploymentId: string, step: DeploymentLogStep): Promise<string | null> {
  const query = new URLSearchParams({ step });
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
