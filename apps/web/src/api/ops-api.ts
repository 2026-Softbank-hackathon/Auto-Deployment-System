/**
 * 플랫폼 운영 화면 API (#308 계약: packages/contracts/src/ops.ts). 웹은 contracts 에 의존하지 않으므로 필요한 모양만 옮겨 둔다.
 * 응답의 큰 틀(배열 · 객체)만 확인하고, 값은 서버 계약(strict 테스트)을 믿는다.
 */
import { endpoint, readJson, ResponseFormatError } from './deployment-api';

export interface OpsQueueStats {
  name: string;
  created: number;
  retry: number;
  active: number;
  completed24h: number;
  failed24h: number;
  oldestWaitingSeconds: number | null;
}

export interface OpsActiveJob {
  id: string;
  name: string;
  deploymentId: string | null;
  projectId: string | null;
  startedAt: string;
  runningSeconds: number;
  retryCount: number;
}

export interface OpsWorker {
  workerId: string;
  hostname: string;
  commit: string | null;
  startedAt: string;
  lastSeenAt: string;
  uptimeSeconds: number;
  lastSeenSecondsAgo: number;
  online: boolean;
  draining: boolean;
  activeJobs: number;
}

export interface OpsQueue {
  generatedAt: string;
  queues: OpsQueueStats[];
  activeJobs: OpsActiveJob[];
  workers: OpsWorker[];
}

export interface OpsServerSample {
  sampledAt: string;
  sampledSecondsAgo: number;
  cpuPercent: number | null;
  memUsedBytes: number;
  memTotalBytes: number;
  memPercent: number;
  load1: number;
  load5: number;
  load15: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  diskPercent: number;
}

export interface OpsServerPoint { t: string; cpu: number | null; mem: number; disk: number }

export interface OpsServerWarning { code: 'DISK_HIGH' | 'MEMORY_HIGH'; percent: number; threshold: number }

export interface OpsServer {
  generatedAt: string;
  latest: OpsServerSample | null;
  buildCache: { bytes: number; sampledAt: string } | null;
  series: OpsServerPoint[];
  warnings: OpsServerWarning[];
}

export type OpsAiPurpose = 'analysis_fill' | 'sqlite_patch' | 'diagnosis' | 'unknown';

export interface OpsAiTotals { calls: number; inputTokens: number; outputTokens: number; costUsd: number }

export interface OpsAiUsageCall extends Omit<OpsAiTotals, 'calls'> {
  id: string;
  createdAt: string;
  model: string;
  purpose: OpsAiPurpose;
  deploymentId: string | null;
  projectId: string | null;
}

export interface OpsAiUsage {
  generatedAt: string;
  timezone: 'Asia/Seoul';
  todayStartsAt: string;
  today: OpsAiTotals;
  last7d: OpsAiTotals;
  byModel: Array<OpsAiTotals & { model: string }>;
  byPurpose: Array<OpsAiTotals & { purpose: OpsAiPurpose }>;
  recent: OpsAiUsageCall[];
}

export type OpsDeployStatus = 'running' | 'success' | 'failed' | 'interrupted';

export interface OpsDeploy {
  id: string;
  status: OpsDeployStatus;
  ref: string | null;
  commitSha: string | null;
  commitSubject: string | null;
  commitUrl: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationSeconds: number | null;
  diskUsedBeforeBytes: number | null;
  diskUsedAfterBytes: number | null;
  diskTotalBytes: number | null;
  runId: string | null;
  runUrl: string | null;
}

export interface OpsDeployList { items: OpsDeploy[] }

async function getOps(path: string, arrays: string[], label: string): Promise<Record<string, unknown>> {
  const response = await fetch(endpoint(`/api/v1/ops/${path}`), { credentials: 'include' });
  const body = await readJson(response);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ResponseFormatError(`${label} 응답 형식이 올바르지 않습니다.`);
  const record = body as Record<string, unknown>;
  if (arrays.some((key) => !Array.isArray(record[key]))) throw new ResponseFormatError(`${label} 응답 형식이 올바르지 않습니다.`);
  return record;
}

export async function getOpsQueue(): Promise<OpsQueue> {
  return await getOps('queue', ['queues', 'activeJobs', 'workers'], '작업 큐') as unknown as OpsQueue;
}

export async function getOpsServer(): Promise<OpsServer> {
  return await getOps('server', ['series', 'warnings'], '서버 지표') as unknown as OpsServer;
}

export async function getOpsAiUsage(): Promise<OpsAiUsage> {
  return await getOps('ai-usage', ['byModel', 'byPurpose', 'recent'], 'AI 사용량') as unknown as OpsAiUsage;
}

export async function getOpsDeploys(): Promise<OpsDeployList> {
  return await getOps('deploys', ['items'], '자동 배포 기록') as unknown as OpsDeployList;
}

/** 서버가 준 링크 중 https 만 링크로 쓴다 */
export function safeHttpsUrl(url: string | null): string | null {
  if (!url) return null;
  try { return new URL(url).protocol === 'https:' ? url : null; } catch { return null; }
}
