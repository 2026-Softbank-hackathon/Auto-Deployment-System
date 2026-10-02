import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHostMetricsSampler,
  cpuPercent,
  parseCpuTimes,
  parseLoadavg,
  parseMeminfo,
  readBuildCacheBytes,
} from "../src/host-metrics.js";

const PROC_STAT_1 = `cpu  100 0 50 800 50 0 0 0 0 0
cpu0 50 0 25 400 25 0 0 0 0 0
intr 123
`;
// user +60, system +20, idle +100, iowait +20 → total +200, idle(+iowait) +120 → 40% 사용
const PROC_STAT_2 = `cpu  160 0 70 900 70 0 0 0 0 0
cpu0 80 0 35 450 35 0 0 0 0 0
`;

const MEMINFO = `MemTotal:        8003856 kB
MemFree:          900696 kB
MemAvailable:    6780068 kB
Buffers:          123 kB
`;

describe("호스트 지표 파싱 (#308)", () => {
  it("/proc/stat 첫 줄에서 전체 · 유휴(iowait 포함) 시간을 읽는다", () => {
    expect(parseCpuTimes(PROC_STAT_1)).toEqual({ total: 1000, idle: 850 });
  });

  it("두 샘플의 차이로 CPU 사용률을 계산한다", () => {
    expect(cpuPercent(parseCpuTimes(PROC_STAT_1), parseCpuTimes(PROC_STAT_2))).toBeCloseTo(40, 5);
    expect(cpuPercent(parseCpuTimes(PROC_STAT_1), parseCpuTimes(PROC_STAT_1))).toBeNull();
  });

  it("/proc/meminfo 의 MemTotal · MemAvailable 로 사용 중 메모리를 계산한다", () => {
    expect(parseMeminfo(MEMINFO)).toEqual({ totalBytes: 8003856 * 1024, usedBytes: (8003856 - 6780068) * 1024 });
  });

  it("/proc/loadavg 의 1 · 5 · 15분 값을 읽는다", () => {
    expect(parseLoadavg("0.06 0.46 0.62 2/386 257\n")).toEqual([0.06, 0.46, 0.62]);
  });

  it("형식이 다르면 오류를 낸다", () => {
    expect(() => parseCpuTimes("intr 1\n")).toThrow();
    expect(() => parseMeminfo("Foo: 1 kB\n")).toThrow();
    expect(() => parseLoadavg("")).toThrow();
  });
});

describe("Docker 빌드 캐시 크기", () => {
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  async function serveDf(body: unknown): Promise<{ socketPath: string; paths: string[]; close: () => Promise<void> }> {
    dir = await mkdtemp(path.join(tmpdir(), "docker-sock-"));
    const socketPath = process.platform === "win32"
      ? `\\\\.\\pipe\\camellia-test-${process.pid}-${Date.now()}`
      : path.join(dir, "docker.sock");
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url ?? "");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    return { socketPath, paths, close: () => new Promise((resolve) => server.close(() => resolve())) };
  }

  it("Docker API /system/df?type=build-cache 의 BuildCacheUsage.TotalSize (docker system df 의 Build Cache SIZE) 를 쓴다", async () => {
    const s = await serveDf({ BuildCacheUsage: { TotalSize: 5622057098, Reclaimable: 5280748166 }, BuildCache: [{ Size: 1 }] });
    try {
      expect(await readBuildCacheBytes(s.socketPath)).toBe(5622057098);
      expect(s.paths).toEqual(["/system/df?type=build-cache"]);
    } finally {
      await s.close();
    }
  });

  it("BuildCacheUsage 가 없는 예전 API 는 BuildCache 항목 크기를 모두 더한다", async () => {
    const s = await serveDf({ BuildCache: [{ Size: 100, Shared: false }, { Size: 50, Shared: true }] });
    try {
      expect(await readBuildCacheBytes(s.socketPath)).toBe(150);
    } finally {
      await s.close();
    }
  });
});

describe("호스트 지표 샘플러", () => {
  function makeSampler(overrides: { buildCacheBytes?: () => Promise<number> } = {}) {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        return { rows: [] };
      }),
    };
    let stat = PROC_STAT_1;
    let clock = 0;
    const files: Record<string, () => string> = {
      "/proc/stat": () => stat,
      "/proc/meminfo": () => MEMINFO,
      "/proc/loadavg": () => "0.5 0.25 0.1 1/100 1\n",
    };
    const buildCacheBytes = vi.fn(overrides.buildCacheBytes ?? (async () => 5_000_000_000));
    const log = { warn: vi.fn() };
    const sampler = createHostMetricsSampler({
      pool,
      log,
      readText: async (file) => {
        const read = files[file];
        if (!read) throw new Error(`unexpected ${file}`);
        return read();
      },
      statfs: async () => ({ bsize: 4096, blocks: 1000, bfree: 300 }),
      buildCacheBytes,
      now: () => clock,
    });
    return {
      sampler, queries, pool, buildCacheBytes, log,
      setStat: (s: string) => { stat = s; },
      advance: (ms: number) => { clock += ms; },
      inserts: () => queries.filter((q) => q.sql.includes("INSERT INTO platform_metrics")),
      deletes: () => queries.filter((q) => q.sql.includes("DELETE FROM")),
    };
  }

  it("CPU · 메모리 · load · 루트 디스크 · 빌드 캐시를 platform_metrics 에 남긴다 (첫 샘플의 CPU 는 비움)", async () => {
    const h = makeSampler();
    await h.sampler.sample();

    expect(h.inserts()).toHaveLength(1);
    const [cpu, memUsed, memTotal, load1, load5, load15, diskUsed, diskTotal, buildCache] = h.inserts()[0]!.params;
    expect(cpu).toBeNull();
    expect(memUsed).toBe((8003856 - 6780068) * 1024);
    expect(memTotal).toBe(8003856 * 1024);
    expect([load1, load5, load15]).toEqual([0.5, 0.25, 0.1]);
    expect(diskUsed).toBe(700 * 4096);
    expect(diskTotal).toBe(1000 * 4096);
    expect(buildCache).toBe(5_000_000_000);

    h.setStat(PROC_STAT_2);
    h.advance(30_000);
    await h.sampler.sample();
    expect(h.inserts()[1]!.params[0]).toBeCloseTo(40, 5);
  });

  it("빌드 캐시는 5분마다만 잰다", async () => {
    const h = makeSampler();
    await h.sampler.sample();
    h.advance(30_000);
    await h.sampler.sample();
    expect(h.buildCacheBytes).toHaveBeenCalledTimes(1);
    expect(h.inserts()[1]!.params[8]).toBeNull();

    h.advance(5 * 60_000);
    await h.sampler.sample();
    expect(h.buildCacheBytes).toHaveBeenCalledTimes(2);
  });

  it("빌드 캐시를 못 재도 나머지 지표는 남긴다", async () => {
    const h = makeSampler({ buildCacheBytes: async () => { throw new Error("permission denied"); } });
    await h.sampler.sample();
    expect(h.inserts()).toHaveLength(1);
    expect(h.inserts()[0]!.params[8]).toBeNull();
    expect(h.log.warn).toHaveBeenCalled();
  });

  it("10분마다 24시간 지난 지표와 하트비트를 지운다", async () => {
    const h = makeSampler();
    await h.sampler.sample();
    expect(h.deletes()).toHaveLength(2);
    expect(h.deletes().map((q) => q.sql).join("\n")).toMatch(/platform_metrics WHERE sampled_at < now\(\) - interval '24 hours'/);
    expect(h.deletes().map((q) => q.sql).join("\n")).toMatch(/worker_heartbeats WHERE last_seen_at < now\(\) - interval '24 hours'/);

    h.advance(30_000);
    await h.sampler.sample();
    expect(h.deletes()).toHaveLength(2);

    h.advance(10 * 60_000);
    await h.sampler.sample();
    expect(h.deletes()).toHaveLength(4);
  });

  it("DB 오류는 경고만 남긴다", async () => {
    const h = makeSampler();
    h.pool.query.mockRejectedValue(new Error("db down"));
    await expect(h.sampler.sample()).resolves.toBeUndefined();
    expect(h.log.warn).toHaveBeenCalled();
  });
});
