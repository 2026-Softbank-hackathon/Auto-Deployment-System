/**
 * apps/api/src/services/ops-service.ts
 * 플랫폼 운영 화면 (#308) — 플랫폼 자체의 상태를 기존 Postgres 에서 읽는다.
 *
 *   queue()    pg-boss 테이블(pgboss.job · archive · queue) + worker_heartbeats
 *   server()   platform_metrics (워커가 30초마다 남기는 EC2 호스트 지표)
 *   aiUsage()  ai_usage (비용은 호출할 때 요금표로 계산해 둔 추정치)
 *   deploys()  platform_deploys (infra/platform/scripts/deploy.sh 가 남기는 CD 기록)
 *
 * BIGINT · NUMERIC · count 는 pg 드라이버가 문자열로 주므로 Number() 로 바꾼다.
 * 경과 시간은 DB 시계(now())로 계산한다.
 */

import type { Pool } from "@camellia/db";
import {
  OPS_DISK_WARN_PERCENT,
  OPS_MEMORY_WARN_PERCENT,
  type OpsAiPurpose,
  type OpsAiTotals,
  type OpsAiUsage,
  type OpsDeployList,
  type OpsQueue,
  type OpsServer,
  type OpsServerWarning,
} from "@camellia/contracts";

/** 화면에 보여 줄 큐 순서 (배포 흐름 순). 모르는 큐는 뒤에 이름순 */
const QUEUE_ORDER = ["analyze", "build", "provision", "verify", "diagnose", "teardown", "address-change"];
const WORKER_ONLINE_SECONDS = 30;
const AI_PURPOSES: readonly OpsAiPurpose[] = ["analysis_fill", "sqlite_patch", "diagnosis", "unknown"];

type Num = number | string | null;

function num(value: Num | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function numOrNull(value: Num | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function idOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return /^\d+$/.test(text) ? text : null;
}

function httpsOrNull(value: string | null): string | null {
  return value && /^https:\/\/[^\s]+$/.test(value) ? value : null;
}

function percent(used: number, total: number): number {
  return total > 0 ? Math.round((used / total) * 1000) / 10 : 0;
}

function round1(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

type TotalsRow = { calls: Num; input_tokens: Num; output_tokens: Num; cost_usd: Num };

function totals(row: TotalsRow | undefined): OpsAiTotals {
  return {
    calls: num(row?.calls),
    inputTokens: num(row?.input_tokens),
    outputTokens: num(row?.output_tokens),
    costUsd: num(row?.cost_usd),
  };
}

function purposeOf(value: string | null): OpsAiPurpose {
  return (AI_PURPOSES as readonly string[]).includes(value ?? "") ? (value as OpsAiPurpose) : "unknown";
}

export class OpsService {
  private readonly boss: string;

  /** bossSchema: pg-boss 스키마 이름 (기본 pgboss, 테스트는 따로 만든 스키마) */
  constructor(private readonly pool: Pool, bossSchema = "pgboss") {
    if (!/^[a-z_][a-z0-9_]*$/.test(bossSchema)) throw new Error(`잘못된 pg-boss 스키마 이름: ${bossSchema}`);
    this.boss = bossSchema;
  }

  async queue(): Promise<OpsQueue> {
    const b = this.boss;
    const [queues, active, workers] = await Promise.all([
      this.pool.query<{
        name: string; created: Num; retry: Num; active: Num; completed: Num; failed: Num; oldest_waiting_seconds: Num;
      }>(
        `WITH live AS (
           SELECT name,
                  count(*) FILTER (WHERE state = 'created') AS created,
                  count(*) FILTER (WHERE state = 'retry') AS retry,
                  count(*) FILTER (WHERE state = 'active') AS active,
                  min(created_on) FILTER (WHERE state IN ('created', 'retry')) AS oldest_waiting
           FROM ${b}.job
           WHERE state IN ('created', 'retry', 'active')
           GROUP BY name
         ),
         done AS (
           SELECT name,
                  count(*) FILTER (WHERE state = 'completed') AS completed,
                  count(*) FILTER (WHERE state = 'failed') AS failed
           FROM (
             SELECT name, state FROM ${b}.job
             WHERE state IN ('completed', 'failed') AND completed_on > now() - interval '24 hours'
             UNION ALL
             SELECT name, state FROM ${b}.archive
             WHERE state IN ('completed', 'failed') AND completed_on > now() - interval '24 hours'
           ) finished
           GROUP BY name
         )
         SELECT q.name,
                COALESCE(l.created, 0) AS created,
                COALESCE(l.retry, 0) AS retry,
                COALESCE(l.active, 0) AS active,
                COALESCE(d.completed, 0) AS completed,
                COALESCE(d.failed, 0) AS failed,
                -- GREATEST 는 NULL 을 무시하므로 대기 작업이 없을 때(NULL)는 따로 둔다
                CASE WHEN l.oldest_waiting IS NOT NULL
                  THEN GREATEST(0, floor(EXTRACT(EPOCH FROM now() - l.oldest_waiting))) END AS oldest_waiting_seconds
         FROM ${b}.queue q
         LEFT JOIN live l ON l.name = q.name
         LEFT JOIN done d ON d.name = q.name
         ORDER BY array_position($1::text[], q.name) NULLS LAST, q.name`,
        [QUEUE_ORDER],
      ),
      this.pool.query<{
        id: string; name: string; deployment_id: string | null; project_id: string | null;
        started_on: Date; running_seconds: Num; retry_count: Num;
      }>(
        `SELECT j.id::text AS id, j.name,
                j.data->>'deployment_id' AS deployment_id,
                COALESCE(j.data->>'project_id', d.project_id::text) AS project_id,
                j.started_on,
                GREATEST(0, floor(EXTRACT(EPOCH FROM now() - j.started_on))) AS running_seconds,
                j.retry_count
         FROM ${b}.job j
         LEFT JOIN deployments d
           ON j.data->>'deployment_id' ~ '^[0-9]+$' AND d.id = (j.data->>'deployment_id')::bigint
         WHERE j.state = 'active'
         ORDER BY j.started_on`,
      ),
      this.pool.query<{
        worker_id: string; hostname: string; commit_sha: string | null; started_at: Date; last_seen_at: Date;
        uptime_seconds: Num; last_seen_seconds_ago: Num; draining: boolean; active_jobs: Num;
      }>(
        `SELECT worker_id, hostname, commit_sha, started_at, last_seen_at,
                GREATEST(0, floor(EXTRACT(EPOCH FROM now() - started_at))) AS uptime_seconds,
                GREATEST(0, floor(EXTRACT(EPOCH FROM now() - last_seen_at))) AS last_seen_seconds_ago,
                draining, active_jobs
         FROM worker_heartbeats
         WHERE last_seen_at > now() - interval '10 minutes'
         ORDER BY started_at DESC`,
      ),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      queues: queues.rows.map((r) => ({
        name: r.name,
        created: num(r.created),
        retry: num(r.retry),
        active: num(r.active),
        completed24h: num(r.completed),
        failed24h: num(r.failed),
        oldestWaitingSeconds: numOrNull(r.oldest_waiting_seconds),
      })),
      activeJobs: active.rows.map((r) => ({
        id: r.id,
        name: r.name,
        deploymentId: idOrNull(r.deployment_id),
        projectId: idOrNull(r.project_id),
        startedAt: iso(r.started_on),
        runningSeconds: num(r.running_seconds),
        retryCount: num(r.retry_count),
      })),
      workers: workers.rows.map((r) => ({
        workerId: r.worker_id,
        hostname: r.hostname,
        commit: r.commit_sha,
        startedAt: iso(r.started_at),
        lastSeenAt: iso(r.last_seen_at),
        uptimeSeconds: num(r.uptime_seconds),
        lastSeenSecondsAgo: num(r.last_seen_seconds_ago),
        online: num(r.last_seen_seconds_ago) <= WORKER_ONLINE_SECONDS,
        draining: r.draining,
        activeJobs: num(r.active_jobs),
      })),
    };
  }

  async server(): Promise<OpsServer> {
    const [latest, buildCache, series] = await Promise.all([
      this.pool.query<{
        sampled_at: Date; sampled_seconds_ago: Num; cpu_percent: Num; mem_used_bytes: Num; mem_total_bytes: Num;
        load1: Num; load5: Num; load15: Num; disk_used_bytes: Num; disk_total_bytes: Num;
      }>(
        `SELECT sampled_at,
                GREATEST(0, floor(EXTRACT(EPOCH FROM now() - sampled_at))) AS sampled_seconds_ago,
                cpu_percent, mem_used_bytes, mem_total_bytes, load1, load5, load15, disk_used_bytes, disk_total_bytes
         FROM platform_metrics
         ORDER BY sampled_at DESC
         LIMIT 1`,
      ),
      this.pool.query<{ build_cache_bytes: Num; sampled_at: Date }>(
        `SELECT build_cache_bytes, sampled_at
         FROM platform_metrics
         WHERE build_cache_bytes IS NOT NULL
         ORDER BY sampled_at DESC
         LIMIT 1`,
      ),
      this.pool.query<{ t: Date; cpu: Num; mem: Num; disk: Num }>(
        `SELECT date_bin('5 minutes', sampled_at, TIMESTAMPTZ '2000-01-01 00:00:00+00') AS t,
                avg(cpu_percent) AS cpu,
                max(mem_used_bytes::float8 / NULLIF(mem_total_bytes, 0) * 100) AS mem,
                max(disk_used_bytes::float8 / NULLIF(disk_total_bytes, 0) * 100) AS disk
         FROM platform_metrics
         WHERE sampled_at > now() - interval '24 hours'
         GROUP BY 1
         ORDER BY 1`,
      ),
    ]);

    const row = latest.rows[0];
    const sample = row
      ? {
          sampledAt: iso(row.sampled_at),
          sampledSecondsAgo: num(row.sampled_seconds_ago),
          cpuPercent: round1(numOrNull(row.cpu_percent)),
          memUsedBytes: num(row.mem_used_bytes),
          memTotalBytes: num(row.mem_total_bytes),
          memPercent: percent(num(row.mem_used_bytes), num(row.mem_total_bytes)),
          load1: num(row.load1),
          load5: num(row.load5),
          load15: num(row.load15),
          diskUsedBytes: num(row.disk_used_bytes),
          diskTotalBytes: num(row.disk_total_bytes),
          diskPercent: percent(num(row.disk_used_bytes), num(row.disk_total_bytes)),
        }
      : null;

    const warnings: OpsServerWarning[] = [];
    if (sample && sample.diskPercent >= OPS_DISK_WARN_PERCENT) {
      warnings.push({ code: "DISK_HIGH", percent: sample.diskPercent, threshold: OPS_DISK_WARN_PERCENT });
    }
    if (sample && sample.memPercent >= OPS_MEMORY_WARN_PERCENT) {
      warnings.push({ code: "MEMORY_HIGH", percent: sample.memPercent, threshold: OPS_MEMORY_WARN_PERCENT });
    }

    const cache = buildCache.rows[0];
    return {
      generatedAt: new Date().toISOString(),
      latest: sample,
      buildCache: cache ? { bytes: num(cache.build_cache_bytes), sampledAt: iso(cache.sampled_at) } : null,
      series: series.rows.map((p) => ({
        t: iso(p.t),
        cpu: round1(numOrNull(p.cpu)),
        mem: round1(num(p.mem)) ?? 0,
        disk: round1(num(p.disk)) ?? 0,
      })),
      warnings,
    };
  }

  async aiUsage(): Promise<OpsAiUsage> {
    const [summary, byModel, byPurpose, recent] = await Promise.all([
      this.pool.query<{
        today_start: Date;
        today_calls: Num; today_input: Num; today_output: Num; today_cost: Num;
        week_calls: Num; week_input: Num; week_output: Num; week_cost: Num;
      }>(
        `WITH bounds AS (
           SELECT (date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul') AS today_start
         )
         SELECT b.today_start,
                count(u.id) FILTER (WHERE u.created_at >= b.today_start) AS today_calls,
                COALESCE(sum(u.input_tokens) FILTER (WHERE u.created_at >= b.today_start), 0) AS today_input,
                COALESCE(sum(u.output_tokens) FILTER (WHERE u.created_at >= b.today_start), 0) AS today_output,
                COALESCE(sum(u.estimated_cost_usd) FILTER (WHERE u.created_at >= b.today_start), 0) AS today_cost,
                count(u.id) AS week_calls,
                COALESCE(sum(u.input_tokens), 0) AS week_input,
                COALESCE(sum(u.output_tokens), 0) AS week_output,
                COALESCE(sum(u.estimated_cost_usd), 0) AS week_cost
         FROM bounds b
         LEFT JOIN ai_usage u ON u.created_at > now() - interval '7 days'
         GROUP BY b.today_start`,
      ),
      this.pool.query<TotalsRow & { model: string }>(
        `SELECT model, count(*) AS calls, COALESCE(sum(input_tokens), 0) AS input_tokens,
                COALESCE(sum(output_tokens), 0) AS output_tokens, COALESCE(sum(estimated_cost_usd), 0) AS cost_usd
         FROM ai_usage
         WHERE created_at > now() - interval '7 days'
         GROUP BY model
         ORDER BY sum(estimated_cost_usd) DESC, model`,
      ),
      this.pool.query<TotalsRow & { purpose: string | null }>(
        `SELECT COALESCE(purpose, 'unknown') AS purpose, count(*) AS calls, COALESCE(sum(input_tokens), 0) AS input_tokens,
                COALESCE(sum(output_tokens), 0) AS output_tokens, COALESCE(sum(estimated_cost_usd), 0) AS cost_usd
         FROM ai_usage
         WHERE created_at > now() - interval '7 days'
         GROUP BY 1
         ORDER BY sum(estimated_cost_usd) DESC, 1`,
      ),
      this.pool.query<{
        id: Num; created_at: Date; model: string; purpose: string | null; deployment_id: Num; project_id: Num;
        input_tokens: Num; output_tokens: Num; estimated_cost_usd: Num;
      }>(
        `SELECT u.id, u.created_at, u.model, u.purpose, u.deployment_id, d.project_id,
                u.input_tokens, u.output_tokens, u.estimated_cost_usd
         FROM ai_usage u
         LEFT JOIN deployments d ON d.id = u.deployment_id
         ORDER BY u.created_at DESC, u.id DESC
         LIMIT 20`,
      ),
    ]);

    const s = summary.rows[0];
    return {
      generatedAt: new Date().toISOString(),
      timezone: "Asia/Seoul",
      todayStartsAt: s ? iso(s.today_start) : new Date().toISOString(),
      today: totals(s && { calls: s.today_calls, input_tokens: s.today_input, output_tokens: s.today_output, cost_usd: s.today_cost }),
      last7d: totals(s && { calls: s.week_calls, input_tokens: s.week_input, output_tokens: s.week_output, cost_usd: s.week_cost }),
      byModel: byModel.rows.map((r) => ({ model: r.model, ...totals(r) })),
      byPurpose: byPurpose.rows.map((r) => ({ purpose: purposeOf(r.purpose), ...totals(r) })),
      recent: recent.rows.map((r) => ({
        id: String(r.id),
        createdAt: iso(r.created_at),
        model: r.model,
        purpose: purposeOf(r.purpose),
        deploymentId: idOrNull(r.deployment_id),
        projectId: idOrNull(r.project_id),
        inputTokens: num(r.input_tokens),
        outputTokens: num(r.output_tokens),
        costUsd: num(r.estimated_cost_usd),
      })),
    };
  }

  async deploys(limit = 20): Promise<OpsDeployList> {
    const res = await this.pool.query<{
      id: Num; status: "running" | "success" | "failed"; interrupted: boolean; ref: string | null;
      commit_sha: string | null; commit_subject: string | null; commit_url: string | null;
      started_at: Date; finished_at: Date | null; duration_seconds: Num;
      disk_used_before_bytes: Num; disk_used_after_bytes: Num; disk_total_bytes: Num;
      run_id: string | null; run_url: string | null;
    }>(
      `SELECT id, status,
              (status = 'running' AND started_at < now() - interval '75 minutes') AS interrupted,
              ref, commit_sha, commit_subject, commit_url, started_at, finished_at,
              GREATEST(0, floor(EXTRACT(EPOCH FROM COALESCE(finished_at, now()) - started_at))) AS duration_seconds,
              disk_used_before_bytes, disk_used_after_bytes, disk_total_bytes, run_id, run_url
       FROM platform_deploys
       ORDER BY started_at DESC, id DESC
       LIMIT $1`,
      [limit],
    );
    return {
      items: res.rows.map((r) => ({
        id: String(r.id),
        status: r.interrupted ? "interrupted" : r.status,
        ref: r.ref,
        commitSha: r.commit_sha,
        commitSubject: r.commit_subject,
        commitUrl: httpsOrNull(r.commit_url),
        startedAt: iso(r.started_at),
        finishedAt: r.finished_at ? iso(r.finished_at) : null,
        durationSeconds: r.interrupted ? null : num(r.duration_seconds),
        diskUsedBeforeBytes: numOrNull(r.disk_used_before_bytes),
        diskUsedAfterBytes: numOrNull(r.disk_used_after_bytes),
        diskTotalBytes: numOrNull(r.disk_total_bytes),
        runId: r.run_id,
        runUrl: httpsOrNull(r.run_url),
      })),
    };
  }
}
