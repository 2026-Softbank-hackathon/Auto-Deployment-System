/**
 * packages/analyzer/tests/ai/tokens.test.ts
 *
 * 토큰 사용량 기록 유틸 단위 테스트 (CST-01).
 */

import { describe, it, expect } from "vitest";
import { estimateCost, buildTokenUsage, PRICING, pricingFor } from "../../src/ai/tokens.js";

describe("estimateCost", () => {
  it("calculates input cost correctly at $4/M (Opus 5.5 기본)", () => {
    const cost = estimateCost({ input_tokens: 1_000_000, output_tokens: 0 });
    expect(cost).toBeCloseTo(4.0, 6);
  });

  it("calculates output cost correctly at $20/M", () => {
    const cost = estimateCost({ input_tokens: 0, output_tokens: 1_000_000 });
    expect(cost).toBeCloseTo(20.0, 6);
  });

  it("calculates cache_read cost correctly at $0.20/M", () => {
    const cost = estimateCost({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(PRICING.cache_read_per_m, 6);
  });

  it("calculates cache_creation cost correctly at $5/M", () => {
    const cost = estimateCost({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(PRICING.cache_creation_per_m, 6);
  });

  it("combines all token types correctly", () => {
    const cost = estimateCost({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 300,
    });

    const expected =
      (100 * 4.0) / 1_000_000 +
      (50 * 20.0) / 1_000_000 +
      (200 * 5.0) / 1_000_000 +
      (300 * 0.2) / 1_000_000;

    expect(cost).toBeCloseTo(expected, 10);
  });

  it("returns 0 for all-zero tokens", () => {
    const cost = estimateCost({ input_tokens: 0, output_tokens: 0 });
    expect(cost).toBe(0);
  });

  it("handles missing optional cache tokens (defaults to 0)", () => {
    const withCache = estimateCost({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    const withoutCache = estimateCost({
      input_tokens: 100,
      output_tokens: 50,
    });
    expect(withCache).toBeCloseTo(withoutCache, 10);
  });
});

describe("buildTokenUsage", () => {
  it("builds a TokenUsage with all required fields", () => {
    const usage = buildTokenUsage("claude-opus-5-5", {
      input_tokens: 100,
      output_tokens: 50,
    });

    expect(usage.model).toBe("claude-opus-5-5");
    expect(usage.input_tokens).toBe(100);
    expect(usage.output_tokens).toBe(50);
    expect(usage.estimated_cost_usd).toBeGreaterThan(0);
    expect(typeof usage.timestamp).toBe("string");
    // ISO 8601 format check
    expect(() => new Date(usage.timestamp)).not.toThrow();
  });

  it("includes cache tokens when provided", () => {
    const usage = buildTokenUsage("claude-opus-5-5", {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 300,
    });

    expect(usage.cache_creation_input_tokens).toBe(200);
    expect(usage.cache_read_input_tokens).toBe(300);
  });

  it("estimated_cost_usd reflects cache_read discount", () => {
    const withRead = buildTokenUsage("claude-opus-5-5", {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
    });
    const withInput = buildTokenUsage("claude-opus-5-5", {
      input_tokens: 1_000_000,
      output_tokens: 0,
    });

    // cache_read ($0.20/M) is cheaper than input ($4/M)
    expect(withRead.estimated_cost_usd).toBeLessThan(withInput.estimated_cost_usd);
  });
});

describe("PRICING constants", () => {
  it("기본(PRICING)은 Claude Opus 5.5 1P 요금", () => {
    expect(PRICING.input_per_m).toBe(4.0);
    expect(PRICING.output_per_m).toBe(20.0);
    expect(PRICING.cache_creation_per_m).toBe(5.0);
    expect(PRICING.cache_read_per_m).toBe(0.2);
  });

  it("pricingFor: 모델 ID(1P · Bedrock 접두사 모두)로 요금을 고른다", () => {
    expect(pricingFor("claude-sonnet-5-5")).toEqual({
      input_per_m: 2.0,
      output_per_m: 10.0,
      cache_creation_per_m: 2.5,
      cache_read_per_m: 0.2,
    });
    expect(pricingFor("global.anthropic.claude-sonnet-5-5")).toEqual(pricingFor("claude-sonnet-5-5"));
    expect(pricingFor("global.anthropic.claude-opus-5-5")).toEqual(PRICING);
    expect(pricingFor("unknown-model")).toEqual(PRICING);
  });

  it("buildTokenUsage 는 모델별 요금으로 계산한다", () => {
    const sonnet = buildTokenUsage("global.anthropic.claude-sonnet-5-5", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(sonnet.estimated_cost_usd).toBeCloseTo(12.0, 6);
  });
});
