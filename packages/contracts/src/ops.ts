/**
 * packages/contracts/src/ops.ts
 * 플랫폼 운영 화면 API 계약 (#308) — 사용자 앱이 아니라 플랫폼 자체의 상태.
 *
 *   GET /api/v1/ops/queue      작업 큐(pg-boss) · 워커 하트비트
 *   GET /api/v1/ops/server     플랫폼 호스트(EC2) 지표 — 최신 값 · 24시간 추이 · 경고
 *   GET /api/v1/ops/ai-usage   AI 사용량 · 비용 추정치
 *   GET /api/v1/ops/deploys    플랫폼 자동 배포(CD) 기록
 *
 * 경과 시간(…Seconds)은 서버(DB) 시계로 계산해 보낸다 — 브라우저 시계가 달라도 같다.
 */

import { z } from "zod";
import { IdStringSchema, IsoDateTimeSchema } from "./common.js";

// ── 작업 큐 · 워커 ───────────────────────────────────────────────────────────

export const OpsQueueStatsSchema = z.object({
  /** pg-boss 큐 이름 (analyze · build · provision · verify · diagnose · teardown · address-change …) */
  name: z.string(),
  /** 대기 (state = created) */
  created: z.number().int().nonnegative(),
  /** 재시도 대기 (state = retry) */
  retry: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  completed24h: z.number().int().nonnegative(),
  failed24h: z.number().int().nonnegative(),
  /** 가장 오래 기다린 작업(created · retry)의 대기 시간. 없으면 null */
  oldestWaitingSeconds: z.number().int().nonnegative().nullable(),
}).strict();
export type OpsQueueStats = z.infer<typeof OpsQueueStatsSchema>;

export const OpsActiveJobSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 작업 데이터의 deployment_id · project_id (없으면 null) */
  deploymentId: IdStringSchema.nullable(),
  projectId: IdStringSchema.nullable(),
  startedAt: IsoDateTimeSchema,
  runningSeconds: z.number().int().nonnegative(),
  retryCount: z.number().int().nonnegative(),
}).strict();
export type OpsActiveJob = z.infer<typeof OpsActiveJobSchema>;

export const OpsWorkerSchema = z.object({
  workerId: z.string(),
  hostname: z.string(),
  /** 워커 이미지의 커밋 SHA. 모르면 null */
  commit: z.string().nullable(),
  startedAt: IsoDateTimeSchema,
  lastSeenAt: IsoDateTimeSchema,
  uptimeSeconds: z.number().int().nonnegative(),
  lastSeenSecondsAgo: z.number().int().nonnegative(),
  /** 마지막 하트비트가 30초 안이면 true */
  online: z.boolean(),
  /** 종료 신호를 받아 진행 중인 작업만 마치는 중 */
  draining: z.boolean(),
  activeJobs: z.number().int().nonnegative(),
}).strict();
export type OpsWorker = z.infer<typeof OpsWorkerSchema>;

export const OpsQueueSchema = z.object({
  generatedAt: IsoDateTimeSchema,
  queues: z.array(OpsQueueStatsSchema),
  activeJobs: z.array(OpsActiveJobSchema),
  /** 최근 10분 안에 하트비트를 보낸 워커 (새로 뜬 순) */
  workers: z.array(OpsWorkerSchema),
}).strict();
export type OpsQueue = z.infer<typeof OpsQueueSchema>;

// ── 플랫폼 서버 ──────────────────────────────────────────────────────────────

export const OPS_DISK_WARN_PERCENT = 80;
export const OPS_MEMORY_WARN_PERCENT = 90;

export const OpsServerSampleSchema = z.object({
  sampledAt: IsoDateTimeSchema,
  sampledSecondsAgo: z.number().int().nonnegative(),
  /** 직전 샘플과의 차이로 계산 — 워커가 막 떠서 직전 샘플이 없으면 null */
  cpuPercent: z.number().nullable(),
  memUsedBytes: z.number().nonnegative(),
  memTotalBytes: z.number().nonnegative(),
  memPercent: z.number(),
  load1: z.number(),
  load5: z.number(),
  load15: z.number(),
  diskUsedBytes: z.number().nonnegative(),
  diskTotalBytes: z.number().nonnegative(),
  diskPercent: z.number(),
}).strict();
export type OpsServerSample = z.infer<typeof OpsServerSampleSchema>;

/** 24시간 추이 한 칸 (5분 단위). cpu 는 평균, mem · disk 는 최댓값(%) */
export const OpsServerPointSchema = z.object({
  t: IsoDateTimeSchema,
  cpu: z.number().nullable(),
  mem: z.number(),
  disk: z.number(),
}).strict();
export type OpsServerPoint = z.infer<typeof OpsServerPointSchema>;

export const OpsServerWarningSchema = z.object({
  code: z.enum(["DISK_HIGH", "MEMORY_HIGH"]),
  percent: z.number(),
  threshold: z.number(),
}).strict();
export type OpsServerWarning = z.infer<typeof OpsServerWarningSchema>;

export const OpsServerSchema = z.object({
  generatedAt: IsoDateTimeSchema,
  /** 최신 샘플. 아직 없으면 null */
  latest: OpsServerSampleSchema.nullable(),
  /** 최근 Docker 빌드 캐시 크기 (5분마다 측정). 없으면 null */
  buildCache: z.object({
    bytes: z.number().nonnegative(),
    sampledAt: IsoDateTimeSchema,
  }).strict().nullable(),
  series: z.array(OpsServerPointSchema),
  warnings: z.array(OpsServerWarningSchema),
}).strict();
export type OpsServer = z.infer<typeof OpsServerSchema>;

// ── AI 사용량 ────────────────────────────────────────────────────────────────

/** analysis_fill = 분석 빈칸 채우기, sqlite_patch = SQLite → PostgreSQL 수정안, diagnosis = 실패 진단, unknown = 목적을 남기기 전 기록 */
export const OPS_AI_PURPOSES = ["analysis_fill", "sqlite_patch", "diagnosis", "unknown"] as const;
export const OpsAiPurposeSchema = z.enum(OPS_AI_PURPOSES);
export type OpsAiPurpose = z.infer<typeof OpsAiPurposeSchema>;

export const OpsAiTotalsSchema = z.object({
  calls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** 호출할 때 코드의 요금표(@camellia/analyzer estimateCost)로 계산해 둔 추정치 합 — 실제 청구액 아님 */
  costUsd: z.number().nonnegative(),
}).strict();
export type OpsAiTotals = z.infer<typeof OpsAiTotalsSchema>;

export const OpsAiUsageCallSchema = z.object({
  id: IdStringSchema,
  createdAt: IsoDateTimeSchema,
  model: z.string(),
  purpose: OpsAiPurposeSchema,
  deploymentId: IdStringSchema.nullable(),
  projectId: IdStringSchema.nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
}).strict();
export type OpsAiUsageCall = z.infer<typeof OpsAiUsageCallSchema>;

export const OpsAiUsageSchema = z.object({
  generatedAt: IsoDateTimeSchema,
  /** "오늘"의 기준 시간대와 시작 시각 (Asia/Seoul 자정) */
  timezone: z.literal("Asia/Seoul"),
  todayStartsAt: IsoDateTimeSchema,
  today: OpsAiTotalsSchema,
  last7d: OpsAiTotalsSchema,
  /** 최근 7일, 비용 큰 순 */
  byModel: z.array(OpsAiTotalsSchema.extend({ model: z.string() }).strict()),
  byPurpose: z.array(OpsAiTotalsSchema.extend({ purpose: OpsAiPurposeSchema }).strict()),
  /** 최근 호출 20건 (새것부터) */
  recent: z.array(OpsAiUsageCallSchema),
}).strict();
export type OpsAiUsage = z.infer<typeof OpsAiUsageSchema>;

// ── 플랫폼 자동 배포(CD) ────────────────────────────────────────────────────

/** interrupted = running 인 채로 75분이 지남(deploy.sh 가 끝 기록을 못 남기고 중단됨) */
export const OpsDeployStatusSchema = z.enum(["running", "success", "failed", "interrupted"]);
export type OpsDeployStatus = z.infer<typeof OpsDeployStatusSchema>;

export const OpsDeploySchema = z.object({
  id: IdStringSchema,
  status: OpsDeployStatusSchema,
  ref: z.string().nullable(),
  commitSha: z.string().nullable(),
  commitSubject: z.string().nullable(),
  /** GitHub 커밋 페이지 (https 만) */
  commitUrl: z.string().nullable(),
  startedAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema.nullable(),
  /** 끝났으면 걸린 시간, 진행 중이면 지금까지, 중단됨(interrupted)이면 null */
  durationSeconds: z.number().int().nonnegative().nullable(),
  diskUsedBeforeBytes: z.number().nonnegative().nullable(),
  diskUsedAfterBytes: z.number().nonnegative().nullable(),
  diskTotalBytes: z.number().nonnegative().nullable(),
  runId: z.string().nullable(),
  /** GitHub Actions 실행 페이지 (https 만) */
  runUrl: z.string().nullable(),
}).strict();
export type OpsDeploy = z.infer<typeof OpsDeploySchema>;

export const OpsDeployListSchema = z.object({
  items: z.array(OpsDeploySchema),
}).strict();
export type OpsDeployList = z.infer<typeof OpsDeployListSchema>;
