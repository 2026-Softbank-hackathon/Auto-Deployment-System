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
});
