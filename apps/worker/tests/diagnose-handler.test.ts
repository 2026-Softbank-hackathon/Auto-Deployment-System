/**
 * apps/worker/tests/diagnose-handler.test.ts
 * handleDiagnose 유닛 테스트 (mock pool + mock Anthropic client).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleDiagnose } from "../src/handlers/diagnose.js";
import type { WorkerDeps } from "../src/deps.js";
import type { AnthropicLike } from "@camellia/analyzer";

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;

function makePool(overrides: { existing?: unknown[] } = {}) {
  const query: QueryFn = async (sql) => {
    if (sql.includes("SELECT diagnosis_json FROM deployments WHERE id")) {
      return {
        rows: overrides.existing ?? [{ diagnosis_json: null }],
        rowCount: (overrides.existing ?? [{ diagnosis_json: null }]).length,
      };
    }
    if (sql.includes("SELECT status, target_profile")) {
      return {
        rows: [{ status: "failed", target_profile: "aws-ecs-basic", error: "boom" }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM deployment_steps")) {
      return {
        rows: [{ step_name: "build", status: "failed", message: "docker build error" }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM ir_versions")) {
      return { rows: [{ ir_json: { services: {} } }], rowCount: 1 };
    }
    if (sql.includes("FROM analysis_reports")) {
      return { rows: [{ warnings_json: [] }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return { query: vi.fn(query) } as unknown as WorkerDeps["pool"];
}

function makeClient(text: string, extra: Record<string, unknown> = {}): AnthropicLike {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: "text" as const, text }],
        usage: { input_tokens: 100, output_tokens: 50 },
        stop_reason: "end_turn",
        ...extra,
      })),
    },
  };
}

const AI_ENV_KEYS = ["AI_PROVIDER", "ANTHROPIC_API_KEY", "AI_MODEL_DIAGNOSE"];
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of AI_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of AI_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function findCall(pool: WorkerDeps["pool"], needle: string) {
  return (pool.query as ReturnType<typeof vi.fn>).mock.calls.find(
    (c) => typeof c[0] === "string" && c[0].includes(needle),
  );
}

function makeDeps(pool: WorkerDeps["pool"]): WorkerDeps {
  return {
    pool,
    boss: {} as WorkerDeps["boss"],
    storage: {} as WorkerDeps["storage"],
  };
}

type DiagnosisSchemaShape = {
  properties: {
    summary: { required: string[] };
    patchCandidates: { items: { properties: { description: { required: string[] }; diff: { type: string } } } };
  };
};

/** 고정 안내 문구도 한국어 · 일본어를 함께 저장한다 */
function expectBilingual(stored: { summary: string; summaryI18n?: { ko: string; ja: string } }) {
  expect(stored.summaryI18n?.ko).toBe(stored.summary);
  expect(stored.summaryI18n?.ja).toBeTruthy();
  expect(stored.summaryI18n?.ja).not.toMatch(/[가-힣]/);
}

describe("handleDiagnose", () => {
  it("이미 진단이 있으면 Claude 호출 없이 skip", async () => {
    const pool = makePool({ existing: [{ diagnosis_json: { summary: "already" } }] });
    const deps = makeDeps(pool);
    const clientFactory = vi.fn(async () => makeClient(""));
    await handleDiagnose({ data: { deployment_id: 1 } }, deps, clientFactory);
    expect(clientFactory).not.toHaveBeenCalled();
    // UPDATE deployments 호출 없어야 함
    const updateCall = (pool.query as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("UPDATE deployments SET diagnosis_json"),
    );
    expect(updateCall).toBeUndefined();
  });

  it("Claude JSON 응답을 파싱해 diagnosis_json 을 저장한다", async () => {
    const pool = makePool();
    const deps = makeDeps(pool);
    const responseJson = JSON.stringify({
      failedStep: "build",
      summary: { ko: "docker build 실패", ja: "docker build に失敗しました" },
      patchCandidates: [
        {
          description: { ko: "Node 22 → 18 로 낮추기", ja: "Node 22 → 18 に下げる" },
          diff: "-FROM node:22\n+FROM node:18",
        },
      ],
    });
    const client = makeClient(`여기 진단 결과입니다:\n${responseJson}`);
    const clientFactory = vi.fn(async () => client);
    await handleDiagnose({ data: { deployment_id: 1 } }, deps, clientFactory);
    expect(client.messages.create).toHaveBeenCalledOnce();
    const calls = (pool.query as ReturnType<typeof vi.fn>).mock.calls;
    const updateCall = calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("UPDATE deployments SET diagnosis_json"),
    );
    expect(updateCall).toBeDefined();
    const stored = JSON.parse((updateCall![1] as unknown[])[0] as string);
    // summary · description 은 한국어(예전 화면 호환), *I18n 에 한국어 · 일본어 (#147)
    expect(stored.summary).toBe("docker build 실패");
    expect(stored.summaryI18n).toEqual({ ko: "docker build 실패", ja: "docker build に失敗しました" });
    expect(stored.patchCandidates).toEqual([
      {
        description: "Node 22 → 18 로 낮추기",
        descriptionI18n: { ko: "Node 22 → 18 로 낮추기", ja: "Node 22 → 18 に下げる" },
        diff: "-FROM node:22\n+FROM node:18",
      },
    ]);
    // ai_usage INSERT 도 호출됐어야 함
    const usageCall = calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO ai_usage"),
    );
    expect(usageCall).toBeDefined();
  });

  it("Claude SDK 로딩 실패 시 fallback diagnosis 를 저장한다", async () => {
    const pool = makePool();
    const deps = makeDeps(pool);
    const clientFactory = vi.fn(async () => {
      throw new Error("SDK missing");
    });
    await handleDiagnose({ data: { deployment_id: 1 } }, deps, clientFactory);
    const updateCall = (pool.query as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("UPDATE deployments SET diagnosis_json"),
    );
    expect(updateCall).toBeDefined();
    const stored = JSON.parse((updateCall![1] as unknown[])[0] as string);
    expect(stored.summary).toMatch(/SDK/);
    expectBilingual(stored);
    expect(stored.patchCandidates).toEqual([]);
    // ai_usage INSERT 는 없어야 (Claude 호출 없음)
    const usageCall = (pool.query as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO ai_usage"),
    );
    expect(usageCall).toBeUndefined();
  });

  it("Sonnet 5.5 · effort medium · 구조화 출력 · 넉넉한 max_tokens 로 호출한다 (thinking 비활성 X)", async () => {
    const pool = makePool();
    const client = makeClient(JSON.stringify({ failedStep: "build", summary: "s", patchCandidates: [] }));
    await handleDiagnose({ data: { deployment_id: 1 } }, makeDeps(pool), async () => client);

    const params = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(params["model"]).toBe("claude-sonnet-5-5");
    expect(params["max_tokens"]).toBeGreaterThanOrEqual(16000);
    expect(params["thinking"]).toBeUndefined();
    expect(params["tool_choice"]).toBeUndefined();
    const oc = params["output_config"] as { effort?: string; format?: { type: string; schema: DiagnosisSchemaShape } };
    expect(oc.effort).toBe("medium");
    expect(oc.format?.type).toBe("json_schema");
    // 설명은 한 번의 호출로 한국어 · 일본어를 함께 받는다 (#147)
    const schema = oc.format!.schema;
    expect(schema.properties.summary.required).toEqual(["ko", "ja"]);
    expect(schema.properties.patchCandidates.items.properties.description.required).toEqual(["ko", "ja"]);
    expect(schema.properties.patchCandidates.items.properties.diff.type).toBe("string");

    // ai_usage 에 실제 모델 ID 와 Sonnet 5.5 요금 추정치
    const usageCall = findCall(pool, "INSERT INTO ai_usage");
    const usageParams = usageCall![1] as unknown[];
    expect(usageParams[1]).toBe("claude-sonnet-5-5");
    expect(usageParams[4]).toBeCloseTo((100 * 2 + 50 * 10) / 1_000_000, 10);
  });

  it("AI_PROVIDER=bedrock 이면 Bedrock 모델 ID(global 추론 프로파일)를 쓴다", async () => {
    process.env["AI_PROVIDER"] = "bedrock";
    const pool = makePool();
    const client = makeClient(JSON.stringify({ failedStep: "build", summary: "s", patchCandidates: [] }));
    await handleDiagnose({ data: { deployment_id: 1 } }, makeDeps(pool), async () => client);
    const params = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(params["model"]).toBe("global.anthropic.claude-sonnet-5-5");
  });

  it("refusal 이면 내용을 쓰지 않고 거절 안내 diagnosis + 사용량 기록", async () => {
    const pool = makePool();
    const client = makeClient("", {
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: null },
      content: [],
    });
    await handleDiagnose({ data: { deployment_id: 1 } }, makeDeps(pool), async () => client);

    const stored = JSON.parse((findCall(pool, "UPDATE deployments SET diagnosis_json")![1] as unknown[])[0] as string);
    expect(stored.summary).toMatch(/거절/);
    expectBilingual(stored);
    expect(stored.failedStep).toBe("build");
    expect(stored.patchCandidates).toEqual([]);
    expect(findCall(pool, "INSERT INTO ai_usage")).toBeDefined();
  });

  it("factory 없이 AI 비활성(env 없음)이면 Claude 호출 없이 fallback diagnosis", async () => {
    const pool = makePool();
    await handleDiagnose({ data: { deployment_id: 1 } }, makeDeps(pool));
    const stored = JSON.parse((findCall(pool, "UPDATE deployments SET diagnosis_json")![1] as unknown[])[0] as string);
    expect(stored.summary).toMatch(/AI/);
    expectBilingual(stored);
    expect(stored.patchCandidates).toEqual([]);
    expect(findCall(pool, "INSERT INTO ai_usage")).toBeUndefined();
  });
});
