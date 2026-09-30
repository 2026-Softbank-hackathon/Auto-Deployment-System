/**
 * packages/analyzer/tests/ai/fill-unresolved.test.ts
 *
 * fillUnresolved() 단위 테스트.
 * 실제 Anthropic API 호출 없음 — vitest.fn().mockResolvedValue로 mock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AnalysisResult } from "../../src/types.js";
import type { AnthropicLike } from "../../src/ai/anthropic-client.js";
import { fillUnresolved } from "../../src/ai/fill-unresolved.js";
import type { TokenUsage } from "../../src/ai/tokens.js";

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

/**
 * AnthropicLike mock 클라이언트를 생성한다.
 * fields 배열을 tool_use 응답으로 반환한다.
 */
function makeMockClient(
  fields: Array<{ path: string; value: unknown }>
): AnthropicLike {
  const mockCreate = vi.fn().mockResolvedValue({
    content: [
      {
        type: "tool_use",
        id: "mock_tool_use_1",
        name: "fill_unresolved_ir_fields",
        input: { fields },
      },
    ],
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    stop_reason: "tool_use",
    model: "claude-opus-4-5",
    id: "mock_msg_1",
    type: "message",
    role: "assistant",
  });

  return {
    messages: { create: mockCreate },
  } as AnthropicLike;
}

// ---------------------------------------------------------------------------
// Tests: ANTHROPIC_API_KEY absent → skipped
// ---------------------------------------------------------------------------

describe("fillUnresolved – no API key", () => {
  beforeEach(() => {
    delete process.env["ANTHROPIC_API_KEY"];
  });

  afterEach(() => {
    delete process.env["ANTHROPIC_API_KEY"];
  });

  it("returns skipped=true when ANTHROPIC_API_KEY is unset and no client/apiKey provided", async () => {
    const analysis = makeAnalysis();
    const result = await fillUnresolved(analysis, {});
    expect(result.skipped).toBe(true);
    expect(result.skip_reason).toContain("no ANTHROPIC_API_KEY");
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
    expect(usageRecords[0].model).toBe("claude-opus-4-5");
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
    const mockCreate = vi.fn().mockResolvedValue({
      content: [
        {
          type: "tool_use",
          id: "mock_2",
          name: "fill_unresolved_ir_fields",
          input: {
            fields: [
              { path: "deploy.profile", value: "aws-ecs-basic" },
            ],
          },
        },
      ],
      usage: { input_tokens: 50, output_tokens: 20 },
      stop_reason: "tool_use",
      model: "claude-opus-4-5",
      id: "mock_msg_2",
      type: "message",
      role: "assistant",
    });

    const client: AnthropicLike = { messages: { create: mockCreate } };

    const result = await fillUnresolved(analysis, { client, maxRetries: 0 });

    // Services is missing → schema validation must fail
    expect(result.ir_valid_after).toBe(false);
    expect(result.ir_errors_after).toBeDefined();
    expect(result.ir_errors_after!.length).toBeGreaterThan(0);
  });
});
