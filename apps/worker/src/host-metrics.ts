/**
 * apps/worker/src/host-metrics.ts
 *
 * 플랫폼 호스트(EC2) 지표 샘플러 (#308). 워커가 30초마다 platform_metrics 에 한 행을 남긴다.
 *
 * 컨테이너 안에서 호스트 값을 읽는 근거 (2026-10-02 플랫폼 EC2 에서 확인):
 *   - /proc/stat · /proc/meminfo · /proc/loadavg 는 Docker 가 가상화하지 않아 호스트 커널 값이다
 *     (워커 컨테이너와 호스트의 meminfo · loadavg 가 같았다).
 *   - statfs("/") 는 컨테이너 루트(overlay)의 upper 층이 있는 파일시스템, 즉 /var/lib/docker 를 담은
 *     파일시스템을 돌려준다. 이 EC2 는 /var/lib/docker 가 루트(/dev/nvme0n1p1 ext4)라 호스트 `df /` 와 같다.
 *   - 빌드 캐시는 워커에 붙어 있는 docker.sock 의 /system/df?type=build-cache (docker system df 의 Build Cache SIZE).
 *     비교적 무거워 5분마다만 잰다.
 * 24시간 지난 지표 · 하트비트는 10분마다 지운다. 실패는 경고만 — 작업 처리에 영향을 주지 않는다.
 */

import { request } from "node:http";
import type { Logger } from "pino";

export const SAMPLE_INTERVAL_MS = 30_000;
export const BUILD_CACHE_INTERVAL_MS = 5 * 60_000;
export const CLEANUP_INTERVAL_MS = 10 * 60_000;

export type CpuTimes = { total: number; idle: number };

/** /proc/stat 첫 줄(cpu)의 전체 · 유휴 시간. guest 는 user 에 이미 들어 있어 앞 8개만 더한다 */
export function parseCpuTimes(procStat: string): CpuTimes {
  const line = procStat.split("\n").find((l) => /^cpu\s/.test(l));
  if (!line) throw new Error("/proc/stat 에 cpu 줄이 없다");
  const fields = line.trim().split(/\s+/).slice(1, 9).map(Number);
  if (fields.length < 5 || fields.some((n) => !Number.isFinite(n))) throw new Error("/proc/stat cpu 줄 형식이 다르다");
  const [, , , idle = 0, iowait = 0] = fields;
  return { total: fields.reduce((sum, n) => sum + n, 0), idle: idle + iowait };
}

/** 두 샘플 사이 CPU 사용률(%). 시간이 흐르지 않았으면 null */
export function cpuPercent(prev: CpuTimes, cur: CpuTimes): number | null {
  const total = cur.total - prev.total;
  if (total <= 0) return null;
  return ((total - (cur.idle - prev.idle)) / total) * 100;
}

/** 사용 중 메모리 = MemTotal - MemAvailable (페이지 캐시 등 회수 가능한 메모리는 뺀다) */
export function parseMeminfo(meminfo: string): { totalBytes: number; usedBytes: number } {
  const kb = (key: string) => {
    const match = meminfo.match(new RegExp(`^${key}:\\s+(\\d+) kB`, "m"));
    if (!match) throw new Error(`/proc/meminfo 에 ${key} 가 없다`);
    return Number(match[1]) * 1024;
  };
  const totalBytes = kb("MemTotal");
  return { totalBytes, usedBytes: totalBytes - kb("MemAvailable") };
}

export function parseLoadavg(loadavg: string): [number, number, number] {
  const [a, b, c] = loadavg.trim().split(/\s+/).map(Number);
  if (![a, b, c].every((n) => typeof n === "number" && Number.isFinite(n))) throw new Error("/proc/loadavg 형식이 다르다");
  return [a!, b!, c!];
}

/**
 * Docker 빌드 캐시 크기(바이트). API 1.52+ 는 BuildCacheUsage.TotalSize, 예전 API 는 항목 크기 합
 * — 둘 다 `docker system df` 의 Build Cache SIZE 와 같은 값이다.
 */
export function readBuildCacheBytes(socketPath = "/var/run/docker.sock", timeoutMs = 20_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: "/system/df?type=build-cache", method: "GET", timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => {
        if ((res.statusCode ?? 500) >= 400) {
          reject(new Error(`docker /system/df ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try {
          const json = JSON.parse(body) as {
            BuildCacheUsage?: { TotalSize?: number };
            BuildCache?: Array<{ Size?: number }> | null;
          };
          const total = json.BuildCacheUsage?.TotalSize;
          resolve(typeof total === "number" ? total : (json.BuildCache ?? []).reduce((sum, item) => sum + (item.Size ?? 0), 0));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("docker /system/df timed out")));
    req.on("error", reject);
    req.end();
  });
}

type SamplerDeps = {
  pool: { query(sql: string, params?: unknown[]): Promise<unknown> };
  log: Pick<Logger, "warn">;
  readText: (file: string) => Promise<string>;
  statfs: (path: string) => Promise<{ bsize: number; blocks: number; bfree: number }>;
  buildCacheBytes: () => Promise<number>;
  /** 테스트용 시계 (ms) */
  now?: () => number;
};

export type HostMetricsSampler = {
  sample(): Promise<void>;
  start(intervalMs?: number): void;
  stop(): void;
};

export function createHostMetricsSampler(deps: SamplerDeps): HostMetricsSampler {
  const now = deps.now ?? Date.now;
  let prevCpu: CpuTimes | undefined;
  let lastBuildCacheAt: number | undefined;
  let lastCleanupAt: number | undefined;
  let running = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function measureBuildCache(): Promise<number | null> {
    const t = now();
    if (lastBuildCacheAt !== undefined && t - lastBuildCacheAt < BUILD_CACHE_INTERVAL_MS) return null;
    lastBuildCacheAt = t;
    try {
      return await deps.buildCacheBytes();
    } catch (err) {
      deps.log.warn({ err }, "build cache size unavailable");
      return null;
    }
  }

  async function cleanup(): Promise<void> {
    const t = now();
    if (lastCleanupAt !== undefined && t - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
    lastCleanupAt = t;
    await deps.pool.query(`DELETE FROM platform_metrics WHERE sampled_at < now() - interval '24 hours'`);
    await deps.pool.query(`DELETE FROM worker_heartbeats WHERE last_seen_at < now() - interval '24 hours'`);
  }

  async function sample(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const [stat, meminfo, loadavg, disk] = await Promise.all([
        deps.readText("/proc/stat"),
        deps.readText("/proc/meminfo"),
        deps.readText("/proc/loadavg"),
        deps.statfs("/"),
      ]);
      const cpu = parseCpuTimes(stat);
      const cpuPct = prevCpu ? cpuPercent(prevCpu, cpu) : null;
      prevCpu = cpu;
      const mem = parseMeminfo(meminfo);
      const [load1, load5, load15] = parseLoadavg(loadavg);
      const buildCache = await measureBuildCache();

      await deps.pool.query(
        `INSERT INTO platform_metrics
           (cpu_percent, mem_used_bytes, mem_total_bytes, load1, load5, load15, disk_used_bytes, disk_total_bytes, build_cache_bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          cpuPct,
          mem.usedBytes,
          mem.totalBytes,
          load1,
          load5,
          load15,
          (disk.blocks - disk.bfree) * disk.bsize,
          disk.blocks * disk.bsize,
          buildCache,
        ],
      );
      await cleanup();
    } catch (err) {
      deps.log.warn({ err }, "host metrics sample failed");
    } finally {
      running = false;
    }
  }

  return {
    sample,
    start(intervalMs = SAMPLE_INTERVAL_MS) {
      void sample();
      timer = setInterval(() => void sample(), intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
