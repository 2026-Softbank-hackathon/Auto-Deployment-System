/**
 * packages/analyzer/src/ai/anthropic-client.ts
 *
 * Claude 클라이언트 생성 — AI 제공자 선택은 이 파일 한 곳에서만 한다 (D-56).
 *
 *   AI_PROVIDER=anthropic  Claude API 직접 호출. ANTHROPIC_API_KEY 필요. (현재 운영)
 *   AI_PROVIDER=bedrock    Amazon Bedrock (bedrock-runtime, global 추론 프로파일).
 *                          자격 증명은 AWS 기본 체인(env 키 · AWS_PROFILE 등), 리전 AWS_REGION (기본 ap-northeast-2).
 *                          운영 EC2 인스턴스 역할은 쓰지 않는다 — IMDS hop limit 1 유지, 전용 자격 증명 필요(런북 4.8).
 *   미설정                 ANTHROPIC_API_KEY 가 있으면 anthropic, 없으면 AI 비활성(규칙 분석만).
 *
 * SDK 는 dynamic import — 미설치 환경에서도 모듈 로드 가능, 테스트는 AnthropicLike mock 주입.
 */

export type AiProvider = "bedrock" | "anthropic";

/** 기능별 모델 역할. analyze = IR 빈칸 채우기, diagnose = 배포 실패 진단. */
export type AiRole = "analyze" | "diagnose";

type Env = Record<string, string | undefined>;

export type AiProviderResolution =
  | { provider: AiProvider; reason?: undefined }
  | { provider: null; reason: string };

export const DEFAULT_AWS_REGION = "ap-northeast-2";

/**
 * 역할별 기본 모델 ID.
 * Bedrock 은 서울 리전에서 Opus 5.5 · Sonnet 5.5 를 INFERENCE_PROFILE 로만 제공하므로
 * global 추론 프로파일 ID 를 쓴다 (리전 프로파일 대비 10% 할증 없음).
 */
const MODEL_IDS: Record<AiRole, Record<AiProvider, string>> = {
  analyze: {
    anthropic: "claude-opus-5-5",
    bedrock: "global.anthropic.claude-opus-5-5",
  },
  diagnose: {
    anthropic: "claude-sonnet-5-5",
    bedrock: "global.anthropic.claude-sonnet-5-5",
  },
};

const MODEL_ENV: Record<AiRole, string> = {
  analyze: "AI_MODEL_ANALYZE",
  diagnose: "AI_MODEL_DIAGNOSE",
};

function nonEmpty(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/**
 * env 로 AI 제공자를 고른다. 비활성이면 provider=null + 이유.
 */
export function resolveAiProvider(env: Env = process.env): AiProviderResolution {
  const raw = nonEmpty(env["AI_PROVIDER"])?.toLowerCase();
  const hasKey = nonEmpty(env["ANTHROPIC_API_KEY"]) !== undefined;

  if (raw === undefined) {
    return hasKey
      ? { provider: "anthropic" }
      : { provider: null, reason: "AI disabled: set AI_PROVIDER=bedrock or ANTHROPIC_API_KEY" };
  }
  if (raw === "bedrock") return { provider: "bedrock" };
  if (raw === "anthropic") {
    return hasKey
      ? { provider: "anthropic" }
      : { provider: null, reason: "AI_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set" };
  }
  return { provider: null, reason: `unknown AI_PROVIDER '${raw}' (expected bedrock | anthropic)` };
}

/**
 * 역할 · 제공자에 맞는 모델 ID. AI_MODEL_ANALYZE / AI_MODEL_DIAGNOSE 로 덮어쓸 수 있다.
 */
export function resolveModel(role: AiRole, provider: AiProvider, env: Env = process.env): string {
  return nonEmpty(env[MODEL_ENV[role]]) ?? MODEL_IDS[role][provider];
}

export type ClientOptions = {
  /** 생략 시 env 로 결정 (resolveAiProvider). */
  provider?: AiProvider;
  /** anthropic 전용. 생략 시 ANTHROPIC_API_KEY. */
  apiKey?: string;
  /** 테스트용 env 주입. 기본 process.env. */
  env?: Env;
};

/**
 * Claude 클라이언트를 생성한다.
 *
 * @throws AI 비활성(제공자 없음) 또는 SDK 로드 실패.
 */
export async function createClient(opts: ClientOptions = {}): Promise<AnthropicLike> {
  const env = opts.env ?? process.env;
  let provider = opts.provider;
  if (provider === undefined) {
    const resolved = resolveAiProvider(env);
    if (resolved.provider === null) throw new Error(resolved.reason);
    provider = resolved.provider;
  }

  if (provider === "bedrock") {
    // 자격 증명 인자를 넘기지 않는다 → SDK 가 AWS 기본 체인(env · 프로필 · IMDS)을 쓴다
    const { default: AnthropicBedrock } = await import("@anthropic-ai/bedrock-sdk");
    return new AnthropicBedrock({
      awsRegion: nonEmpty(env["AWS_REGION"]) ?? DEFAULT_AWS_REGION,
    }) as unknown as AnthropicLike;
  }

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return new Anthropic({
    apiKey: opts.apiKey ?? env["ANTHROPIC_API_KEY"],
  }) as unknown as AnthropicLike;
}

/**
 * Claude 클라이언트의 최소 인터페이스.
 * 테스트에서 mock 주입을 위해 사용.
 */
export type AnthropicLike = {
  messages: {
    create: (params: AnthropicCreateParams) => Promise<AnthropicMessageResponse>;
  };
};

export type AnthropicCreateParams = {
  model: string;
  max_tokens: number;
  system?: unknown;
  tools?: unknown[];
  tool_choice?: unknown;
  output_config?: {
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
    format?: { type: "json_schema"; schema: Record<string, unknown> };
  };
  messages: Array<{ role: string; content: string }>;
};

export type AnthropicMessageResponse = {
  content: AnthropicContentBlock[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    [key: string]: unknown;
  };
  stop_reason?: string | null;
  /** stop_reason="refusal" 일 때의 부가 정보(정보용 — 분기는 stop_reason 으로만). */
  stop_details?: { type?: string; category?: string | null; explanation?: string | null } | null;
  model?: string;
  id?: string;
  type?: string;
  role?: string;
};

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string };
