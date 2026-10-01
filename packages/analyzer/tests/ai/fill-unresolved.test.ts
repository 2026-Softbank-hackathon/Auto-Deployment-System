/**
 * packages/analyzer/tests/ai/fill-unresolved.test.ts
 *
 * fillUnresolved() 단위 테스트.
 * 실제 Claude 호출 없음 — vitest.fn().mockResolvedValue로 mock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AnalysisResult } from "../../src/types.js";
import type { AnthropicLike } from "../../src/ai/anthropic-client.js";
import { fillUnresolved } from "../../src/ai/fill-unresolved.js";
import type { TokenUsage } from "../../src/ai/tokens.js";

// AI_PROVIDER=bedrock 경로 확인용: Bedrock SDK 를 mock 으로 대체한다
const bedrockCreate = vi.fn();
vi.mock("@anthropic-ai/bedrock-sdk", () => ({
  default: class {
    messages = { create: bedrockCreate };
  },
}));

const AI_ENV_KEYS = ["AI_PROVIDER", "ANTHROPIC_API_KEY", "AI_MODEL_ANALYZE", "AWS_REGION"];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of AI_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  bedrockCreate.mockReset();
});

afterEach(() => {
  for (const k of AI_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeAnalysis(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    services: [
      {
        name: "api",
        path: ".",
        type: "http",
        framework: "express",
        language: "node",
        port: 3000,
        command: ["node", "server.js"],
        env_names: ["PORT"],
        detected_from: ["package.json"],
      },
    ],
    resources: [],
    warnings: [],
    unresolved: [
      { path: "deploy.profile", reason: "Default profile applied; orchestrator will override" },
    ],
    ir_draft: {
      $ir_version: "0.1.0",
      metadata: { name: "api", version: "0.0.1" },
      services: {
        api: {
          type: "http",
          expose: "public",
          size: "small",
          health: { path: "/health", expected_status: 200, timeout_seconds: 3 },
          command: ["node", "server.js"],
          port: 3000,
        },
      },
      deploy: { profile: "aws-ecs-basic" },
    },
    ir_valid: false,
    ir_errors: ["deploy.profile: Default profile — needs confirmation"],
    ...overrides,
  };
}

/** 구조화 출력(output_config.format) 응답: JSON 이 text 블록 하나로 온다. */
function makeResponse(
  fields: Array<{ path: string; value: unknown }>,
  extra: Record<string, unknown> = {}
) {
  return {
    content: [
      { type: "thinking", thinking: "" },
      { type: "text", text: JSON.stringify({ fields }) },
    ],
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    stop_reason: "end_turn",
    model: "claude-opus-5-5",
    id: "mock_msg_1",
    type: "message",
    role: "assistant",
    ...extra,
  };
}

function makeMockClient(
  fields: Array<{ path: string; value: unknown }>
): AnthropicLike {
  return {
    messages: { create: vi.fn().mockResolvedValue(makeResponse(fields)) },
  } as unknown as AnthropicLike;
}

function lastParams(client: AnthropicLike): Record<string, unknown> {
  const create = client.messages.create as ReturnType<typeof vi.fn>;
  return create.mock.calls.at(-1)![0] as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests: AI 비활성 → skipped
// ---------------------------------------------------------------------------

describe("fillUnresolved – AI 비활성", () => {
  it("AI_PROVIDER · ANTHROPIC_API_KEY 모두 없으면 skipped=true + 이유", async () => {
    const analysis = makeAnalysis();
    const result = await fillUnresolved(analysis, {});
    expect(result.skipped).toBe(true);
    expect(result.skip_reason).toMatch(/AI_PROVIDER/);
  });

  it("ir_after equals ir_before when skipped", async () => {
    const analysis = makeAnalysis();
    const result = await fillUnresolved(analysis, {});
    expect(result.ir_after).toEqual(result.ir_before);
  });

  it("still_unresolved equals original unresolved when skipped", async () => {
    const analysis = makeAnalysis();
    const result = await fillUnresolved(analysis, {});
    expect(result.still_unresolved).toEqual(analysis.unresolved);
  });
});

// ---------------------------------------------------------------------------
// Tests: 요청 형태 (Opus 5.5 마이그레이션)
// ---------------------------------------------------------------------------

describe("fillUnresolved – 요청 형태", () => {
  it("강제 tool_choice 없이 구조화 출력 + effort 명시 + 넉넉한 max_tokens", async () => {
    const client = makeMockClient([{ path: "deploy.profile", value: "aws-ecs-basic" }]);
    await fillUnresolved(makeAnalysis(), { client });

    const params = lastParams(client);
    expect(params["model"]).toBe("claude-opus-5-5");
    expect(params["tool_choice"]).toBeUndefined();
    expect(params["tools"]).toBeUndefined();
    expect(params["thinking"]).toBeUndefined();
    expect(params["max_tokens"]).toBeGreaterThanOrEqual(16000);
    const outputConfig = params["output_config"] as {
      effort?: string;
      format?: { type: string; schema: Record<string, unknown> };
    };
    expect(outputConfig.effort).toBe("low");
    expect(outputConfig.format?.type).toBe("json_schema");
    expect(outputConfig.format?.schema["additionalProperties"]).toBe(false);
  });

  it("AI_PROVIDER=bedrock 이면 키 없이 Bedrock 클라이언트 + global 추론 프로파일 ID", async () => {
    process.env["AI_PROVIDER"] = "bedrock";
    bedrockCreate.mockResolvedValue(
      makeResponse([{ path: "deploy.profile", value: "aws-ecs-basic" }])
    );

    const result = await fillUnresolved(makeAnalysis(), {});

    expect(result.skipped).toBeUndefined();
    expect(bedrockCreate).toHaveBeenCalledOnce();
    expect(bedrockCreate.mock.calls[0]![0].model).toBe("global.anthropic.claude-opus-5-5");
    expect(result.usage[0]?.model).toBe("global.anthropic.claude-opus-5-5");
  });

  it("AI_MODEL_ANALYZE 로 모델을 바꿀 수 있다", async () => {
    process.env["AI_MODEL_ANALYZE"] = "claude-opus-5";
    const client = makeMockClient([{ path: "deploy.profile", value: "aws-ecs-basic" }]);
    await fillUnresolved(makeAnalysis(), { client });
    expect(lastParams(client)["model"]).toBe("claude-opus-5");
  });
});

// ---------------------------------------------------------------------------
// Tests: mock client → fields applied to ir_draft
// ---------------------------------------------------------------------------

describe("fillUnresolved – mock client", () => {
  it("applies returned fields to ir_draft", async () => {
    const analysis = makeAnalysis();
    const client = makeMockClient([
      { path: "deploy.profile", value: "aws-ecs-basic" },
    ]);

    const result = await fillUnresolved(analysis, { client });

    expect(result.skipped).toBeUndefined();
    const resolvedPaths = result.resolved.map((r) => r.path);
    expect(resolvedPaths).toContain("deploy.profile");
    expect(result.ir_after).toBeDefined();
  });

  it("배열 값(command)도 채운다", async () => {
    const analysis = makeAnalysis({
      unresolved: [{ path: "services.api.command", reason: "no command found" }],
    });
    const client = makeMockClient([
      { path: "services.api.command", value: ["node", "index.js"] },
    ]);

    const result = await fillUnresolved(analysis, { client });

    const services = result.ir_after.services as Record<string, { command?: string[] }>;
    expect(services["api"]?.command).toEqual(["node", "index.js"]);
    expect(result.still_unresolved).toEqual([]);
  });

  it("resolved entries have source='ai'", async () => {
    const analysis = makeAnalysis();
    const client = makeMockClient([
      { path: "deploy.profile", value: "aws-ecs-basic" },
    ]);

    const result = await fillUnresolved(analysis, { client });

    for (const r of result.resolved) {
      expect(r.source).toBe("ai");
    }
  });

  it("calls onUsage callback with token usage", async () => {
    const analysis = makeAnalysis();
    const client = makeMockClient([
      { path: "deploy.profile", value: "aws-ecs-basic" },
    ]);
    const usageRecords: TokenUsage[] = [];

    await fillUnresolved(analysis, {
      client,
      onUsage: (u) => usageRecords.push(u),
    });

    expect(usageRecords.length).toBeGreaterThan(0);
    expect(usageRecords[0].input_tokens).toBe(100);
    expect(usageRecords[0].output_tokens).toBe(50);
    expect(usageRecords[0].model).toBe("claude-opus-5-5");
    expect(usageRecords[0].estimated_cost_usd).toBeGreaterThan(0);
  });

  it("usage array in result contains all call usage records", async () => {
    const analysis = makeAnalysis();
    const client = makeMockClient([
      { path: "deploy.profile", value: "aws-ecs-basic" },
    ]);

    const result = await fillUnresolved(analysis, { client });

    expect(result.usage.length).toBeGreaterThan(0);
    expect(result.usage[0].input_tokens).toBe(100);
  });

  it("JSON 이 아닌 응답은 빈 채우기로 처리한다", async () => {
    const create = vi.fn().mockResolvedValue({
      ...makeResponse([]),
      content: [{ type: "text", text: "not json" }],
    });
    const client = { messages: { create } } as unknown as AnthropicLike;

    const result = await fillUnresolved(makeAnalysis(), { client, maxRetries: 0 });

    expect(result.resolved).toEqual([]);
    expect(result.still_unresolved).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: stop_reason 처리 (refusal · max_tokens)
// ---------------------------------------------------------------------------

describe("fillUnresolved – stop_reason", () => {
  it("refusal 이면 내용을 읽지 않고 재시도 없이 skipped + 카테고리 기록", async () => {
    const create = vi.fn().mockResolvedValue(
      makeResponse([{ path: "deploy.profile", value: "aws-ecs-basic" }], {
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "cyber", explanation: null },
      })
    );
    const client = { messages: { create } } as unknown as AnthropicLike;
    const usage: TokenUsage[] = [];

    const result = await fillUnresolved(makeAnalysis(), {
      client,
      maxRetries: 2,
      onUsage: (u) => usage.push(u),
    });

    expect(create).toHaveBeenCalledOnce();
    expect(result.skipped).toBe(true);
    expect(result.skip_reason).toContain("refusal");
    expect(result.skip_reason).toContain("cyber");
    expect(result.resolved).toEqual([]);
    expect(result.ir_after).toEqual(result.ir_before);
    expect(usage).toHaveLength(1); // 거절도 사용량은 기록
  });

  it("max_tokens 로 잘리면 재시도 없이 skipped", async () => {
    const create = vi.fn().mockResolvedValue({
      ...makeResponse([]),
      content: [{ type: "text", text: '{"fields":[{"path":"deploy.pro' }],
      stop_reason: "max_tokens",
    });
    const client = { messages: { create } } as unknown as AnthropicLike;

    const result = await fillUnresolved(makeAnalysis(), { client, maxRetries: 2 });

    expect(create).toHaveBeenCalledOnce();
    expect(result.skipped).toBe(true);
    expect(result.skip_reason).toContain("max_tokens");
    expect(result.resolved).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: invalid path returned by AI → ignored, still_unresolved
// ---------------------------------------------------------------------------

describe("fillUnresolved – invalid paths from AI", () => {
  it("ignores fields with nonsensical nested paths and keeps them in still_unresolved", async () => {
    const analysis = makeAnalysis({
      unresolved: [
        { path: "deploy.profile", reason: "needs override" },
        { path: "services.api.command", reason: "no command found" },
      ],
    });

    // AI returns one valid path and one that cannot be set (path through non-object)
    const client = makeMockClient([
      { path: "deploy.profile", value: "aws-ecs-basic" },
      // "services.api.port.extra" cannot traverse through number port
      { path: "services.api.port.extra", value: 9999 },
    ]);

    const result = await fillUnresolved(analysis, { client });

    // deploy.profile should be resolved
    expect(result.resolved.some((r) => r.path === "deploy.profile")).toBe(true);
    // services.api.command was not in AI response → still unresolved
    expect(result.still_unresolved.some((u) => u.path === "services.api.command")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: IrSchema validation failure after fill → ir_valid_after=false
// ---------------------------------------------------------------------------

describe("fillUnresolved – schema validation after fill", () => {
  it("ir_valid_after=false when AI fills invalid value and retries exhausted", async () => {
    const analysis = makeAnalysis({
      // Make it so the IR is missing required fields after fill
      unresolved: [{ path: "deploy.profile", reason: "needs override" }],
      ir_draft: {
        // Intentionally malformed: missing required services
        $ir_version: "0.1.0",
        metadata: { name: "app", version: "0.0.1" },
        deploy: { profile: "aws-ecs-basic" },
      },
      ir_valid: false,
    });

    // AI returns a fill but IR still missing services → will fail validation
    const client = makeMockClient([{ path: "deploy.profile", value: "aws-ecs-basic" }]);

    const result = await fillUnresolved(analysis, { client, maxRetries: 0 });

    // Services is missing → schema validation must fail
    expect(result.ir_valid_after).toBe(false);
    expect(result.ir_errors_after).toBeDefined();
    expect(result.ir_errors_after!.length).toBeGreaterThan(0);
  });
});
