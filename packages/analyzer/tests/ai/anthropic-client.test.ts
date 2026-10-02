/**
 * packages/analyzer/tests/ai/anthropic-client.test.ts
 *
 * AI 제공자 선택 · 모델 ID 해석 · 클라이언트 생성 단위 테스트.
 * SDK 는 vi.mock 으로 대체 — 실제 네트워크 호출 없음.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const anthropicCtor = vi.fn();
const bedrockCtor = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: vi.fn() };
    constructor(opts: unknown) {
      anthropicCtor(opts);
    }
  },
}));

vi.mock("@anthropic-ai/bedrock-sdk", () => ({
  default: class {
    messages = { create: vi.fn() };
    constructor(opts: unknown) {
      bedrockCtor(opts);
    }
  },
}));

import {
  createClient,
  resolveAiProvider,
  resolveModel,
} from "../../src/ai/anthropic-client.js";

beforeEach(() => {
  anthropicCtor.mockClear();
  bedrockCtor.mockClear();
});

describe("resolveAiProvider", () => {
  it("AI_PROVIDER=bedrock → bedrock (API 키 불필요)", () => {
    expect(resolveAiProvider({ AI_PROVIDER: "bedrock" })).toEqual({ provider: "bedrock" });
  });

  it("AI_PROVIDER=anthropic + 키 → anthropic", () => {
    expect(
      resolveAiProvider({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-test" })
    ).toEqual({ provider: "anthropic" });
  });

  it("AI_PROVIDER=anthropic 인데 키가 없으면 비활성 + 이유", () => {
    const r = resolveAiProvider({ AI_PROVIDER: "anthropic" });
    expect(r.provider).toBeNull();
    expect(r.reason).toContain("ANTHROPIC_API_KEY");
  });

  it("AI_PROVIDER 미설정 + ANTHROPIC_API_KEY 있으면 anthropic (기존 동작 유지)", () => {
    expect(resolveAiProvider({ ANTHROPIC_API_KEY: "sk-test" })).toEqual({ provider: "anthropic" });
  });

  it("AI_PROVIDER 미설정 + 키 없음(빈 문자열 포함) → 비활성", () => {
    for (const env of [{}, { ANTHROPIC_API_KEY: "" }, { AI_PROVIDER: "" }]) {
      const r = resolveAiProvider(env);
      expect(r.provider).toBeNull();
      expect(r.reason).toMatch(/AI_PROVIDER/);
    }
  });

  it("알 수 없는 AI_PROVIDER 값 → 비활성 + 값 표시", () => {
    const r = resolveAiProvider({ AI_PROVIDER: "openai", ANTHROPIC_API_KEY: "sk-test" });
    expect(r.provider).toBeNull();
    expect(r.reason).toContain("openai");
  });

  it("대소문자 · 공백은 무시한다", () => {
    expect(resolveAiProvider({ AI_PROVIDER: " Bedrock " })).toEqual({ provider: "bedrock" });
  });
});

describe("resolveModel", () => {
  it("analyze → Opus 5.5, diagnose → Sonnet 5.5 (1P ID, 날짜 접미사 없음)", () => {
    expect(resolveModel("analyze", "anthropic", {})).toBe("claude-opus-5-5");
    expect(resolveModel("diagnose", "anthropic", {})).toBe("claude-sonnet-5-5");
  });

  it("bedrock 은 global 추론 프로파일 ID", () => {
    expect(resolveModel("analyze", "bedrock", {})).toBe("global.anthropic.claude-opus-5-5");
    expect(resolveModel("diagnose", "bedrock", {})).toBe("global.anthropic.claude-sonnet-5-5");
  });

  it("AI_MODEL_ANALYZE / AI_MODEL_DIAGNOSE 로 덮어쓴다", () => {
    const env = { AI_MODEL_ANALYZE: "x-analyze", AI_MODEL_DIAGNOSE: "x-diagnose" };
    expect(resolveModel("analyze", "bedrock", env)).toBe("x-analyze");
    expect(resolveModel("diagnose", "anthropic", env)).toBe("x-diagnose");
  });

  it("빈 문자열 override 는 무시한다", () => {
    expect(resolveModel("analyze", "anthropic", { AI_MODEL_ANALYZE: "" })).toBe("claude-opus-5-5");
  });

  it("patch(코드 수정안)는 AI_MODEL_PATCH → AI_MODEL_ANALYZE → Opus 5.5 순서", () => {
    expect(resolveModel("patch", "anthropic", {})).toBe("claude-opus-5-5");
    expect(resolveModel("patch", "bedrock", {})).toBe("global.anthropic.claude-opus-5-5");
    expect(resolveModel("patch", "anthropic", { AI_MODEL_ANALYZE: "x-analyze" })).toBe("x-analyze");
    expect(resolveModel("patch", "anthropic", { AI_MODEL_ANALYZE: "x-analyze", AI_MODEL_PATCH: "x-patch" })).toBe("x-patch");
  });
});

describe("createClient", () => {
  it("bedrock: AnthropicBedrock 을 AWS_REGION 으로 만든다 (키 인자 없이 기본 자격 증명 체인)", async () => {
    await createClient({ provider: "bedrock", env: { AWS_REGION: "us-west-2" } });
    expect(bedrockCtor).toHaveBeenCalledWith({ awsRegion: "us-west-2" });
    expect(anthropicCtor).not.toHaveBeenCalled();
  });

  it("bedrock: AWS_REGION 이 없으면 ap-northeast-2", async () => {
    await createClient({ provider: "bedrock", env: {} });
    expect(bedrockCtor).toHaveBeenCalledWith({ awsRegion: "ap-northeast-2" });
  });

  it("anthropic: API 키로 Anthropic 클라이언트", async () => {
    await createClient({ provider: "anthropic", env: { ANTHROPIC_API_KEY: "sk-env" } });
    expect(anthropicCtor).toHaveBeenCalledWith({ apiKey: "sk-env" });
    expect(bedrockCtor).not.toHaveBeenCalled();
  });

  it("anthropic: 명시적 apiKey 가 env 보다 우선", async () => {
    await createClient({ provider: "anthropic", apiKey: "sk-arg", env: { ANTHROPIC_API_KEY: "sk-env" } });
    expect(anthropicCtor).toHaveBeenCalledWith({ apiKey: "sk-arg" });
  });

  it("provider 생략 시 env 로 결정한다", async () => {
    await createClient({ env: { AI_PROVIDER: "bedrock" } });
    expect(bedrockCtor).toHaveBeenCalledOnce();
  });

  it("비활성이면 이유를 담아 throw", async () => {
    await expect(createClient({ env: {} })).rejects.toThrow(/AI_PROVIDER/);
  });
});
