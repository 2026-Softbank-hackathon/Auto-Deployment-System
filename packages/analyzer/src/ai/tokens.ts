/**
 * packages/analyzer/src/ai/tokens.ts
 *
 * 토큰 사용량 기록 타입 및 유틸.
 * CST-01: AI 호출 사용량 추적.
 *
 * 요금 상수 (USD / 1M tokens) — Claude API(1P) 공시 단가 기준 **추정치**:
 *   Claude Opus 5.5   input $4 · output $20 · cache write(5m) $5    · cache read $0.20
 *   Claude Sonnet 5.5 input $2 · output $10 · cache write(5m) $2.50 · cache read $0.20
 * Amazon Bedrock(global 추론 프로파일) 단가는 AWS 가 정하며 1P 와 다를 수 있다.
 * 실제 청구액은 AWS Billing 기준이고, ai_usage.estimated_cost_usd 는 비교용 추정이다.
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

export type Pricing = {
  input_per_m: number;
  output_per_m: number;
  cache_creation_per_m: number;
  cache_read_per_m: number;
};

/**
 * 기본 요금 (USD per 1M tokens) — Claude Opus 5.5.
 */
export const PRICING: Pricing = {
  input_per_m: 4.0,
  output_per_m: 20.0,
  cache_creation_per_m: 5.0,
  cache_read_per_m: 0.2,
};

const SONNET_5_5_PRICING: Pricing = {
  input_per_m: 2.0,
  output_per_m: 10.0,
  cache_creation_per_m: 2.5,
  cache_read_per_m: 0.2,
};

/**
 * 모델 ID 로 요금표를 고른다. 1P(`claude-sonnet-5-5`) · Bedrock(`global.anthropic.claude-sonnet-5-5`)
 * 모두 부분 문자열로 맞춘다. 모르는 모델은 기본(Opus 5.5) 요금 — 과소 추정보다 과대 추정이 낫다.
 */
export function pricingFor(model?: string): Pricing {
  if (model?.includes("claude-sonnet-5-5")) return SONNET_5_5_PRICING;
  return PRICING;
}

/**
 * 토큰 수와 요금 상수로 USD 비용을 계산한다.
 */
export function estimateCost(
  params: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  },
  model?: string
): number {
  const {
    input_tokens,
    output_tokens,
    cache_creation_input_tokens = 0,
    cache_read_input_tokens = 0,
  } = params;
  const pricing = pricingFor(model);

  return (
    (input_tokens * pricing.input_per_m) / 1_000_000 +
    (output_tokens * pricing.output_per_m) / 1_000_000 +
    (cache_creation_input_tokens * pricing.cache_creation_per_m) / 1_000_000 +
    (cache_read_input_tokens * pricing.cache_read_per_m) / 1_000_000
  );
}

/**
 * Claude 응답 usage 객체에서 TokenUsage를 생성한다.
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
    estimated_cost_usd: estimateCost(usage, model),
    timestamp: new Date().toISOString(),
  };
}
