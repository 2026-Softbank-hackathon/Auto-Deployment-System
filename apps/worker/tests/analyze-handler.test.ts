/**
 * apps/worker/tests/analyze-handler.test.ts
 *
 * analyze 핸들러 테스트 — MockPool + MockStorage + mock analyzeWithAI.
 * Postgres 없이 실행.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleAnalyze, type AnalyzeJobPayload } from "../src/handlers/analyze.js";
import type { WorkerDeps } from "../src/deps.js";

// ---------------------------------------------------------------------------
// analyzeWithAI, stage 모킹
// ---------------------------------------------------------------------------

vi.mock("@camellia/analyzer", () => ({
  analyzeWithAI: vi.fn(),
}));

vi.mock("@camellia/analyzer/stager", () => ({
  stage: vi.fn(),
}));

// node:fs/promises 의 writeFile / rm 모킹
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    promises: {
      ...original.promises,
      writeFile: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
    },
  };
});

import { analyzeWithAI } from "@camellia/analyzer";
import { stage } from "@camellia/analyzer/stager";

// ---------------------------------------------------------------------------
// 헬퍼: MockPool
// ---------------------------------------------------------------------------

function makeMockPool(currentStatus = "received") {
  const insertedRows: Array<{ table: string; params: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT status")) return { rows: [{ status: currentStatus }] };
      if (sql.includes("UPDATE deployments")) {
        // 상태 전이 UPDATE — 다음 SELECT 시 상태 갱신 시뮬레이션
        if (params && typeof params[0] === "string") {
          currentStatus = params[0] as string;
        }
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO ai_usage")) {
        insertedRows.push({ table: "ai_usage", params: params ?? [] });
      }
      if (sql.includes("INSERT INTO analysis_reports")) {
        insertedRows.push({ table: "analysis_reports", params: params ?? [] });
      }
      if (sql.includes("INSERT INTO ir_versions")) {
        insertedRows.push({ table: "ir_versions", params: params ?? [] });
      }
      // 재진입 체크용 상태 조회 — makeMockPool(currentStatus) 로 분기 테스트.
      if (sql.includes("SELECT status FROM deployments")) {
        return { rows: [{ status: currentStatus }] };
      }
      return { rows: [] };
    }),
    insertedRows,
  };
  return pool;
}

// ---------------------------------------------------------------------------
// 기본 분석 결과 fixture
// ---------------------------------------------------------------------------

function makeAnalysisResult(overrides: Record<string, unknown> = {}) {
  return {
    services: [{ name: "api", path: ".", type: "http", env_names: [], detected_from: [] }],
    resources: [],
    warnings: [],
    unresolved: [],
    ir_draft: { name: "test-app", version: "1.0.0" },
    ir_valid: true,
    ir_errors: [],
    ai: {
      ir_after: { name: "test-app", version: "1.0.0" },
      ir_valid_after: true,
      ir_errors_after: [],
      still_unresolved: [],
      skipped: false,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 기본 deps fixture
// ---------------------------------------------------------------------------

function makeDeps(pool: ReturnType<typeof makeMockPool>, notifierCalls: unknown[][] = []) {
  const notifier = {
    notify: vi.fn(async (...args: unknown[]) => {
      notifierCalls.push(args);
    }),
  };
  const files = new Map<string, Buffer>();
  const storage = {
    get: vi.fn(async (key: string) => files.get(key) ?? Buffer.from("fake-zip")),
    exists: vi.fn(async (key: string) => files.has(key)),
    put: vi.fn(async (key: string, buf: Buffer) => {
      files.set(key, buf);
    }),
    files,
  };
  return {
    deps: {
      pool,
      boss: {} as any,
      storage,
      notifier,
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as any,
    } satisfies WorkerDeps,
    notifier,
    storage,
  };
}

// ---------------------------------------------------------------------------
// 기본 job fixture
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<AnalyzeJobPayload> = {}) {
  return {
    data: {
      deployment_id: 42,
      source_storage_key: "sources/abc123.zip",
      sha256: "abc123",
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe("handleAnalyze", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // stage mock: cleanup 있는 StageResult 반환
    vi.mocked(stage).mockResolvedValue({
      resolvedPath: "/tmp/staged-src",
      isDirectory: true,
      cleanup: vi.fn(async () => {}),
    });
  });

  it("성공 시 analysis_reports + ir_versions row를 INSERT한다", async () => {
    const pool = makeMockPool("received");
    const { deps } = makeDeps(pool);
    vi.mocked(analyzeWithAI).mockResolvedValue(makeAnalysisResult() as any);

    await handleAnalyze(makeJob(), deps);

    const tables = pool.insertedRows.map((r) => r.table);
    expect(tables).toContain("analysis_reports");
    expect(tables).toContain("ir_versions");
  });

  it("캐시 미스(최초 분석)에도 analysis_reports에 source_version_id를 저장한다 — ANL-08 캐시 조회가 이 값으로 JOIN 한다", async () => {
    const pool = makeMockPool("received");
    const { deps } = makeDeps(pool);
    vi.mocked(analyzeWithAI).mockResolvedValue(makeAnalysisResult() as any);

    await handleAnalyze(makeJob({ source_version_id: 7 }), deps);

    const row = pool.insertedRows.find((r) => r.table === "analysis_reports");
    expect(row?.params).toContain(7);
  });

  it("성공 시 상태 전이 호출 2회 + notifier state_changed 2회", async () => {
    const pool = makeMockPool("received");
    const notifierCalls: unknown[][] = [];
    const { deps, notifier } = makeDeps(pool, notifierCalls);
    vi.mocked(analyzeWithAI).mockResolvedValue(makeAnalysisResult() as any);

    await handleAnalyze(makeJob(), deps);

    // notifier.notify 가 state_changed 로 호출된 횟수
    const stateChangedCalls = (notifier.notify.mock.calls as unknown[][]).filter(
      (c) => c[1] === "state_changed"
    );
    expect(stateChangedCalls.length).toBe(2);
    expect(stateChangedCalls[0]?.[2]).toMatchObject({ status: "analyzing" });
    expect(stateChangedCalls[1]?.[2]).toMatchObject({
      status: "awaiting_target_confirmation",
    });
  });

  it("AI 사용 시 onUsage 콜백으로 ai_usage INSERT", async () => {
    const pool = makeMockPool("received");
    const { deps } = makeDeps(pool);

    vi.mocked(analyzeWithAI).mockImplementation(async (_path, opts) => {
      await opts?.onUsage?.({
        model: "claude-sonnet-4-5",
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 5,
        estimated_cost_usd: 0.001,
      });
      return makeAnalysisResult() as any;
    });

    await handleAnalyze(makeJob(), deps);

    const aiUsageRows = pool.insertedRows.filter((r) => r.table === "ai_usage");
    expect(aiUsageRows.length).toBe(1);
    expect(aiUsageRows[0]?.params[0]).toBe(42); // deployment_id
    expect(aiUsageRows[0]?.params[1]).toBe("claude-sonnet-4-5"); // model
  });

  it("analyzeWithAI가 throw하면 재던지고 staged.cleanup을 여전히 호출한다", async () => {
    const pool = makeMockPool("received");
    const { deps } = makeDeps(pool);

    const cleanupFn = vi.fn(async () => {});
    vi.mocked(stage).mockResolvedValue({
      resolvedPath: "/tmp/staged-src",
      isDirectory: true,
      cleanup: cleanupFn,
    });

    vi.mocked(analyzeWithAI).mockRejectedValue(new Error("AI failed"));

    await expect(handleAnalyze(makeJob(), deps)).rejects.toThrow("AI failed");

    // finally 블록에서 cleanup 호출 확인
    expect(cleanupFn).toHaveBeenCalledOnce();
  });

  it("analyzeWithAI가 throw해도 상태 전이는 once만 호출된다 (pg-boss retry에 맡김)", async () => {
    const pool = makeMockPool("received");
    const notifierCalls: unknown[][] = [];
    const { deps, notifier } = makeDeps(pool, notifierCalls);

    vi.mocked(analyzeWithAI).mockRejectedValue(new Error("analyze error"));

    await expect(handleAnalyze(makeJob(), deps)).rejects.toThrow();

    // analyzing 전이는 1회 (received → analyzing), succeeded 전이는 없어야 함
    const stateChangedCalls = (notifier.notify.mock.calls as unknown[][]).filter(
      (c) => c[1] === "state_changed"
    );
    expect(stateChangedCalls.length).toBe(1);
    expect(stateChangedCalls[0]?.[2]).toMatchObject({ status: "analyzing" });
  });

  it("AI가 skipped일 때 ir_versions source는 'analyzer'", async () => {
    const pool = makeMockPool("received");
    const { deps } = makeDeps(pool);

    vi.mocked(analyzeWithAI).mockResolvedValue(
      makeAnalysisResult({
        ai: {
          ir_after: { name: "test-app" },
          ir_valid_after: true,
          ir_errors_after: [],
          still_unresolved: [],
          skipped: true,
        },
      }) as any
    );

    await handleAnalyze(makeJob(), deps);

    const irRow = pool.insertedRows.find((r) => r.table === "ir_versions");
    expect(irRow?.params[2]).toBe("analyzer");
  });

  it("성공 시 approval_requested(gate:target) NOTIFY가 발행된다", async () => {
    const pool = makeMockPool("received");
    const notifierCalls: unknown[][] = [];
    const { deps, notifier } = makeDeps(pool, notifierCalls);
    vi.mocked(analyzeWithAI).mockResolvedValue(makeAnalysisResult() as any);

    await handleAnalyze(makeJob(), deps);

    const approvalCalls = (notifier.notify.mock.calls as unknown[][]).filter(
      (c) => c[1] === "approval_requested"
    );
    expect(approvalCalls.length).toBe(1);
    expect(approvalCalls[0]?.[2]).toMatchObject({ gate: "target" });
  });

  it("LOG-02: 분석 진행 과정을 analyze 단계 로그 파일에 남긴다", async () => {
    const pool = makeMockPool("received");
    const { deps, storage } = makeDeps(pool);
    vi.mocked(analyzeWithAI).mockResolvedValue(makeAnalysisResult() as any);

    await handleAnalyze(makeJob(), deps);

    const log = storage.files.get("logs/deployments/42/analyze.log")?.toString("utf8") ?? "";
    expect(log).toContain("분석 시작");
    expect(log).toContain("분석 완료");
    expect(log).toContain("대상 확인 대기");
  });

  it("LOG-02: 분석이 실패하면 실패 원인을 로그에 남기고 재던진다", async () => {
    const pool = makeMockPool("received");
    const { deps, storage } = makeDeps(pool);
    vi.mocked(analyzeWithAI).mockRejectedValue(new Error("AI failed"));

    await expect(handleAnalyze(makeJob(), deps)).rejects.toThrow("AI failed");

    const log = storage.files.get("logs/deployments/42/analyze.log")?.toString("utf8") ?? "";
    expect(log).toContain("분석 실패: AI failed");
  });

  it("LOG-02: 캐시 재사용도 로그에 남긴다", async () => {
    const pool = makeMockPool("received");
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT status FROM deployments")) {
        return { rows: [{ status: "received" }] };
      }
      if (sql.includes("FROM source_versions sv")) {
        return {
          rows: [
            {
              source_version_id: 5,
              services_json: [],
              resources_json: [],
              warnings_json: [],
              unresolved_json: [],
              ir_valid: true,
              ir_errors_json: null,
              ir_json: null,
            },
          ],
        };
      }
      return { rows: [] };
    });
    const { deps, storage } = makeDeps(pool);

    await handleAnalyze(makeJob(), deps);

    const log = storage.files.get("logs/deployments/42/analyze.log")?.toString("utf8") ?? "";
    expect(log).toContain("이전 분석 결과 재사용");
  });

  it("analyzing 상태 재진입 (pg-boss retry) — invalid transition 로 crash 안 함", async () => {
    const pool = makeMockPool("analyzing");
    const { deps, storage } = makeDeps(pool);

    // 핵심 — 이전엔 'transitionTo: invalid transition analyzing → analyzing' 로 즉시 throw.
    // 지금은 재진입 분기 로 통과해서 분석 흐름까지 진입함 (분석 내부 성패는 별건).
    await handleAnalyze(makeJob(), deps).catch(() => {});

    const log = storage.files.get("logs/deployments/42/analyze.log")?.toString("utf8") ?? "";
    expect(log).toContain("분석 시작");
  });

  it("이미 다른 상태 (succeeded 등) 로 넘어갔으면 조기 return — 분석 skip", async () => {
    const pool = makeMockPool("succeeded");
    const { deps, storage } = makeDeps(pool);

    await handleAnalyze(makeJob(), deps);

    // 분석 로그 자체가 안 쌓임
    const log = storage.files.get("logs/deployments/42/analyze.log")?.toString("utf8") ?? "";
    expect(log).toBe("");
    // 어떤 INSERT 도 발생 안 함
    expect(pool.insertedRows).toHaveLength(0);
  });

  it("deployment 가 DB 에 없으면 ANALYZE_DEPLOYMENT_NOT_FOUND throw", async () => {
    const pool = makeMockPool("received");
    // SELECT status 가 빈 rows 반환하도록 override
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT status FROM deployments")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    const { deps } = makeDeps(pool);

    await expect(handleAnalyze(makeJob(), deps)).rejects.toThrow(
      "ANALYZE_DEPLOYMENT_NOT_FOUND",
    );
  });
});

describe("handleAnalyze — 서버리스 배포 형태 (#282)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(stage).mockResolvedValue({
      resolvedPath: "/tmp/staged-src",
      isDirectory: true,
      cleanup: vi.fn(async () => {}),
    });
  });

  function serverlessPool() {
    const pool = makeMockPool();
    const updates: unknown[][] = [];
    const base = pool.query;
    pool.query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT target_profile FROM deployments")) {
        return { rows: [{ target_profile: "aws-lambda-basic" }] };
      }
      if (sql.includes("UPDATE deployments SET target_profile")) updates.push(params ?? []);
      return base(sql, params);
    }) as typeof pool.query;
    return { pool, updates };
  }

  function insertedIrProfile(pool: ReturnType<typeof makeMockPool>) {
    const row = pool.insertedRows.find((inserted) => inserted.table === "ir_versions")!;
    return JSON.parse(row.params[1] as string).deploy.profile;
  }

  it("Lambda 로 띄울 수 있는 HTTP 앱이면 서버리스 프로필을 그대로 IR 에 남긴다", async () => {
    const { pool, updates } = serverlessPool();
    const ir = { services: { web: { type: "http", port: 3000 } }, deploy: { profile: "aws-ecs-basic" } };
    vi.mocked(analyzeWithAI).mockResolvedValue(makeAnalysisResult({ ai: { ir_after: ir, ir_valid_after: true, skipped: false } }) as any);
    const { deps } = makeDeps(pool);

    await handleAnalyze(makeJob(), deps);

    expect(updates).toEqual([]);
    expect(insertedIrProfile(pool)).toBe("aws-lambda-basic");
  });

  it("DB 같은 리소스가 있는 앱은 컨테이너(aws-ecs-basic)로 되돌리고 이유를 로그에 남긴다", async () => {
    const { pool, updates } = serverlessPool();
    const ir = {
      services: { web: { type: "http", port: 3000 } },
      resources: { db: { type: "postgres", local_fallback: "sqlite" } },
      deploy: { profile: "aws-ecs-basic" },
    };
    vi.mocked(analyzeWithAI).mockResolvedValue(makeAnalysisResult({ ai: { ir_after: ir, ir_valid_after: true, skipped: false } }) as any);
    const notifierCalls: unknown[][] = [];
    const { deps } = makeDeps(pool, notifierCalls);

    await handleAnalyze(makeJob(), deps);

    expect(updates).toEqual([["aws-ecs-basic", 42]]);
    expect(insertedIrProfile(pool)).toBe("aws-ecs-basic");
    const lines = notifierCalls
      .filter(([, event]) => event === "log.line")
      .map(([, , payload]) => (payload as { line: string }).line);
    expect(lines.some((line) => line.includes("컨테이너로 배포합니다"))).toBe(true);
  });
});
