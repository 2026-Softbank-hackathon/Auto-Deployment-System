/**
 * packages/analyzer/tests/ai/tokens.test.ts
 *
 * 토큰 사용량 기록 유틸 단위 테스트 (CST-01).
 */

import { describe, it, expect } from "vitest";
import { estimateCost, buildTokenUsage, PRICING } from "../../src/ai/tokens.js";

describe("estimateCost", () => {
  it("calculates input cost correctly at $15/M", () => {
    const cost = estimateCost({ input_tokens: 1_000_000, output_tokens: 0 });
    expect(cost).toBeCloseTo(15.0, 6);
  });

  it("calculates output cost correctly at $75/M", () => {
    const cost = estimateCost({ input_tokens: 0, output_tokens: 1_000_000 });
    expect(cost).toBeCloseTo(75.0, 6);
  });

  it("calculates cache_read cost correctly at $1.5/M", () => {
    const cost = estimateCost({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(PRICING.cache_read_per_m, 6);
  });

  it("calculates cache_creation cost correctly at $18.75/M", () => {
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
      (100 * 15.0) / 1_000_000 +
      (50 * 75.0) / 1_000_000 +
      (200 * 18.75) / 1_000_000 +
      (300 * 1.5) / 1_000_000;

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
    const usage = buildTokenUsage("claude-opus-4-5", {
      input_tokens: 100,
      output_tokens: 50,
    });

    expect(usage.model).toBe("claude-opus-4-5");
    expect(usage.input_tokens).toBe(100);
    expect(usage.output_tokens).toBe(50);
    expect(usage.estimated_cost_usd).toBeGreaterThan(0);
    expect(typeof usage.timestamp).toBe("string");
    // ISO 8601 format check
    expect(() => new Date(usage.timestamp)).not.toThrow();
  });

  it("includes cache tokens when provided", () => {
    const usage = buildTokenUsage("claude-opus-4-5", {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 300,
    });

    expect(usage.cache_creation_input_tokens).toBe(200);
    expect(usage.cache_read_input_tokens).toBe(300);
  });

  it("estimated_cost_usd reflects cache_read discount", () => {
    const withRead = buildTokenUsage("claude-opus-4-5", {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
    });
    const withInput = buildTokenUsage("claude-opus-4-5", {
      input_tokens: 1_000_000,
      output_tokens: 0,
    });

    // cache_read ($1.5/M) is cheaper than input ($15/M)
    expect(withRead.estimated_cost_usd).toBeLessThan(withInput.estimated_cost_usd);
  });
});

describe("PRICING constants", () => {
  it("has the expected rate values", () => {
    expect(PRICING.input_per_m).toBe(15.0);
    expect(PRICING.output_per_m).toBe(75.0);
    expect(PRICING.cache_creation_per_m).toBe(18.75);
    expect(PRICING.cache_read_per_m).toBe(1.5);
  });
});
