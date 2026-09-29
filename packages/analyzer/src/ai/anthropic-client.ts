/**
 * packages/analyzer/src/ai/anthropic-client.ts
 *
 * Anthropic SDK 인스턴스 생성.
 * env 또는 명시적 apiKey에서 SDK 클라이언트를 만든다.
 * dynamic import를 사용해 SDK 미설치 시에도 모듈 로드 가능.
 */

export type ClientOptions = {
  apiKey?: string;
};

/**
 * Anthropic 클라이언트를 생성한다.
 * apiKey 미지정 시 ANTHROPIC_API_KEY 환경변수를 사용한다.
 *
 * @throws SDK가 설치되지 않은 경우 에러.
 */
export async function createClient(opts: ClientOptions = {}): Promise<AnthropicLike> {
  // Dynamic import: SDK 미설치 환경에서 모듈 로드 가능하게 함
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return new Anthropic({
    apiKey: opts.apiKey ?? process.env["ANTHROPIC_API_KEY"],
  }) as unknown as AnthropicLike;
}

/**
 * Anthropic 클라이언트의 최소 인터페이스.
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
  messages: Array<{ role: string; content: string }>;
};

export type AnthropicMessageResponse = {
  content: AnthropicContentBlock[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    [key: string]: unknown;
  };
  stop_reason?: string;
  model?: string;
  id?: string;
  type?: string;
  role?: string;
};

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };
