/**
 * packages/analyzer/src/ai/tokens.ts
 *
 * 토큰 사용량 기록 타입 및 유틸.
 * CST-01: AI 호출 사용량 추적.
 *
 * 요금 상수 (USD / 1M tokens) — claude-opus-4-5 기준:
 *   input:            $15.00 / 1M
 *   output:           $75.00 / 1M
 *   cache_creation:   $18.75 / 1M
 *   cache_read:        $1.50 / 1M
 */

export type TokenUsage = {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  estimated_cost_usd: number;
  timestamp: string;
};

/**
 * 요금 상수 (USD per 1M tokens).
 */
export const PRICING = {
  input_per_m: 15.0,
  output_per_m: 75.0,
  cache_creation_per_m: 18.75,
  cache_read_per_m: 1.5,
} as const;

/**
 * 토큰 수와 요금 상수로 USD 비용을 계산한다.
 */
export function estimateCost(params: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}): number {
  const {
    input_tokens,
    output_tokens,
    cache_creation_input_tokens = 0,
    cache_read_input_tokens = 0,
  } = params;

  return (
    (input_tokens * PRICING.input_per_m) / 1_000_000 +
    (output_tokens * PRICING.output_per_m) / 1_000_000 +
    (cache_creation_input_tokens * PRICING.cache_creation_per_m) / 1_000_000 +
    (cache_read_input_tokens * PRICING.cache_read_per_m) / 1_000_000
  );
}

/**
 * Anthropic API 응답 usage 객체에서 TokenUsage를 생성한다.
 */
export function buildTokenUsage(
  model: string,
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  }
): TokenUsage {
  return {
    model,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
    estimated_cost_usd: estimateCost(usage),
    timestamp: new Date().toISOString(),
  };
}
