/**
 * packages/analyzer/src/ai/fill-unresolved.ts
 *
 * 핵심: unresolved 배열 → 구조화 출력(JSON) → 필드 채움 → IR 재검증.
 *
 * 근거: D-47 (AI 빈칸 채우기), D-50 (시크릿 값 미전송), CST-01 (사용량 기록),
 *       D-56 (Bedrock 전환 · Claude Opus 5.5 — 강제 tool_choice 대신 구조화 출력)
 */

import { IrSchema } from "@camellia/ir-schema";
import type { Ir } from "@camellia/ir-schema";
import type { AnalysisResult, UnresolvedField } from "../types.js";
import { createClient, resolveAiProvider, resolveModel } from "./anthropic-client.js";
import type { AiProvider, AnthropicLike } from "./anthropic-client.js";
import { getSystemBlocksWithCache } from "./prompts.js";
import { FILL_UNRESOLVED_SCHEMA, isFillUnresolvedInput } from "./tools.js";
import { buildTokenUsage } from "./tokens.js";
import type { TokenUsage } from "./tokens.js";
import { redactPayload } from "./redact.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FillOptions = {
  /** 주입 가능한 클라이언트 (테스트용). 지정 시 apiKey 무시. */
  client?: AnthropicLike;
  /** 명시적 Claude API 키 (anthropic 제공자 강제). 미지정 시 env(AI_PROVIDER 등)로 결정. */
  apiKey?: string;
  /** 사용할 모델. 기본값: 제공자별 Claude Opus 5.5 (AI_MODEL_ANALYZE 로 덮어쓰기) */
  model?: string;
  /** 실패 시 최대 재시도 횟수. 기본값: 2 */
  maxRetries?: number;
  /** 토큰 사용량 콜백 (CST-01). */
  onUsage?: (u: TokenUsage) => void;
};

export type ResolvedField = {
  path: string;
  value: unknown;
  source: "ai";
};

export type AiFillResult = {
  /** 규칙 기반 분석 결과 IR */
  ir_before: Partial<Ir>;
  /** AI 채운 후 IR */
  ir_after: Partial<Ir>;
  /** AI 채운 후 IrSchema 검증 성공 여부 */
  ir_valid_after: boolean;
  /** AI 채운 후 검증 실패 시 에러 목록 */
  ir_errors_after?: string[];
  /** AI가 실제 채운 필드 목록 */
  resolved: ResolvedField[];
  /** AI도 채우지 못한 필드 */
  still_unresolved: UnresolvedField[];
  /** 이 세션의 AI 호출 사용량 목록 (CST-01) */
  usage: TokenUsage[];
  /** AI 비활성 · 호출 실패 · 거절 등으로 AI 결과를 쓰지 못한 경우 true */
  skipped?: boolean;
  /** skip 이유 */
  skip_reason?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RETRIES = 2;
/**
 * Opus 5.5 는 thinking 을 끌 수 없고 thinking 토큰도 max_tokens 에 포함된다.
 * 답 자체는 수백 토큰이지만 생각할 여유를 두고, 스트리밍 없이 안전한 상한(~16K)으로 둔다.
 */
const MAX_TOKENS = 16000;
/**
 * 몇 개 필드를 규칙 기반 힌트로 채우는 짧은 추출 작업 → low.
 * (Opus 5.5 기본값은 medium. low 가 지연 · 비용이 가장 작고, 결과는 IrSchema 로 다시 검증한다)
 */
const EFFORT = "low" as const;
const BACKOFF_BASE_MS = 500;

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * AnalysisResult의 unresolved 필드를 AI로 채운다.
 *
 * AI 제공자가 없으면(AI_PROVIDER · ANTHROPIC_API_KEY 모두 미설정) skipped=true로 즉시 반환한다.
 */
export async function fillUnresolved(
  analysis: AnalysisResult,
  opts: FillOptions = {}
): Promise<AiFillResult> {
  const ir_before = analysis.ir_draft;

  // 제공자 결정: 주입 client > 명시 apiKey(anthropic) > env
  const envProvider = resolveAiProvider();
  const provider: AiProvider | null =
    opts.apiKey !== undefined ? "anthropic" : envProvider.provider;

  if (opts.client === undefined && provider === null) {
    return {
      ir_before,
      ir_after: ir_before,
      ir_valid_after: analysis.ir_valid,
      ir_errors_after: analysis.ir_errors,
      resolved: [],
      still_unresolved: analysis.unresolved,
      usage: [],
      skipped: true,
      skip_reason: envProvider.reason ?? "AI disabled",
    };
  }

  // unresolved가 없으면 skip
  if (analysis.unresolved.length === 0) {
    return {
      ir_before,
      ir_after: ir_before,
      ir_valid_after: analysis.ir_valid,
      ir_errors_after: analysis.ir_errors,
      resolved: [],
      still_unresolved: [],
      usage: [],
    };
  }

  // Client 획득: 주입된 client 우선, 없으면 동적 생성
  let client: AnthropicLike;
  if (opts.client !== undefined) {
    client = opts.client;
  } else {
    try {
      client = await createClient({ provider: provider ?? undefined, apiKey: opts.apiKey });
    } catch (err) {
      return {
        ir_before,
        ir_after: ir_before,
        ir_valid_after: analysis.ir_valid,
        ir_errors_after: analysis.ir_errors,
        resolved: [],
        still_unresolved: analysis.unresolved,
        usage: [],
        skipped: true,
        skip_reason: `Failed to create Claude client: ${String(err)}`,
      };
    }
  }

  const model = opts.model ?? resolveModel("analyze", provider ?? "anthropic");
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const usageList: TokenUsage[] = [];

  // Deep clone ir_draft to avoid mutation
  let irDraft: Partial<Ir> = JSON.parse(JSON.stringify(ir_before));
  const resolved: ResolvedField[] = [];
  let lastError: unknown = null;
  // refusal · max_tokens 로 멈춘 경우 이유 (같은 요청 재시도는 의미가 없어 루프를 끝낸다)
  let stopNote: string | null = null;

  // Build user payload: redacted service/resource info for the prompt
  const userPayload = {
    services: analysis.services.map((s) => ({
      name: s.name,
      type: s.type,
      framework: s.framework,
      language: s.language,
      port: s.port,
      command: s.command,
      env_names: s.env_names,
      detected_from: s.detected_from,
    })),
    resources: analysis.resources,
    warnings: analysis.warnings,
    unresolved: analysis.unresolved,
    source_summary: {
      service_count: analysis.services.length,
      resource_count: analysis.resources.length,
    },
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const backoffMs = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
      await sleep(backoffMs);
    }

    try {
      const response = await client.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        system: getSystemBlocksWithCache(),
        // 강제 tool_choice(any/tool)는 Opus 5.5 에서 400 → JSON 만 필요하므로 구조화 출력
        output_config: {
          effort: EFFORT,
          format: { type: "json_schema", schema: FILL_UNRESOLVED_SCHEMA },
        },
        messages: [
          {
            role: "user",
            content: redactPayload(userPayload),
          },
        ],
      });

      // Record token usage
      const usageEntry = buildTokenUsage(model, {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_creation_input_tokens:
          (response.usage as Record<string, unknown>)[
            "cache_creation_input_tokens"
          ] as number | undefined,
        cache_read_input_tokens:
          (response.usage as Record<string, unknown>)[
            "cache_read_input_tokens"
          ] as number | undefined,
      });
      usageList.push(usageEntry);
      opts.onUsage?.(usageEntry);

      // stop_reason 을 content 보다 먼저 본다: refusal 은 content 가 비었거나 일부만 있고,
      // max_tokens 는 JSON 이 중간에 잘린다. 둘 다 같은 요청 재시도로는 나아지지 않는다.
      if (response.stop_reason === "refusal") {
        stopNote = `model stopped with refusal (category: ${response.stop_details?.category ?? "none"})`;
        break;
      }
      if (response.stop_reason === "max_tokens") {
        stopNote = `model stopped with max_tokens (${MAX_TOKENS}) before finishing the JSON`;
        break;
      }

      // 구조화 출력: JSON 은 text 블록에 온다 (앞에 thinking 블록이 올 수 있어 type 으로 찾는다)
      const textBlock = response.content.find(
        (block): block is Extract<typeof block, { type: "text" }> => block.type === "text"
      );
      const parsed = textBlock ? parseJson(textBlock.text) : undefined;

      if (!isFillUnresolvedInput(parsed)) {
        // 기대한 JSON 이 아님 — 빈 채우기로 보고 종료
        break;
      }

      const fields = parsed.fields;

      // Apply fields to ir draft
      const newResolved: ResolvedField[] = [];
      for (const field of fields) {
        if (field.value === null) continue;
        const applied = setByPath(
          irDraft as Record<string, unknown>,
          field.path,
          field.value
        );
        if (applied) {
          newResolved.push({ path: field.path, value: field.value, source: "ai" });
        }
      }
      resolved.push(...newResolved);

      // Re-validate IR
      const parseResult = IrSchema.safeParse(irDraft);
      if (parseResult.success) {
        irDraft = parseResult.data as unknown as Partial<Ir>;
        // All good — break out of retry loop
        break;
      }

      // Validation failed — retry if attempts remain
      lastError = parseResult.error;
      if (attempt === maxRetries) {
        const ir_errors_after = parseResult.error.errors.map(
          (e) => `${e.path.join(".")}: ${e.message}`
        );
        const stillUnresolved = computeStillUnresolved(
          analysis.unresolved,
          resolved
        );
        return {
          ir_before,
          ir_after: irDraft,
          ir_valid_after: false,
          ir_errors_after,
          resolved,
          still_unresolved: stillUnresolved,
          usage: usageList,
        };
      }
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries) {
        const stillUnresolved = computeStillUnresolved(
          analysis.unresolved,
          resolved
        );
        return {
          ir_before,
          ir_after: irDraft,
          ir_valid_after: false,
          ir_errors_after: [String(err)],
          resolved,
          still_unresolved: stillUnresolved,
          usage: usageList,
          skipped: true,
          skip_reason: `API error after ${maxRetries + 1} attempts: ${String(err)}`,
        };
      }
    }
  }

  if (stopNote !== null && resolved.length === 0) {
    return {
      ir_before,
      ir_after: ir_before,
      ir_valid_after: analysis.ir_valid,
      ir_errors_after: analysis.ir_errors,
      resolved: [],
      still_unresolved: analysis.unresolved,
      usage: usageList,
      skipped: true,
      skip_reason: stopNote,
    };
  }

  // Validate final state
  const finalParseResult = IrSchema.safeParse(irDraft);
  const stillUnresolved = computeStillUnresolved(analysis.unresolved, resolved);

  if (finalParseResult.success) {
    return {
      ir_before,
      ir_after: finalParseResult.data as unknown as Partial<Ir>,
      ir_valid_after: true,
      resolved,
      still_unresolved: stillUnresolved,
      usage: usageList,
    };
  }

  const ir_errors_after = finalParseResult.error.errors.map(
    (e) => `${e.path.join(".")}: ${e.message}`
  );

  void lastError;

  return {
    ir_before,
    ir_after: irDraft,
    ir_valid_after: false,
    ir_errors_after,
    resolved,
    still_unresolved: stillUnresolved,
    usage: usageList,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * dot-notation パスでオブジェクトに値をセットする.
 * 中間オブジェクトが存在しない場合は作成する.
 * パスが無効な場合は false を返す.
 */
function setByPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown
): boolean {
  const parts = path.split(".");
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (part === undefined) return false;
    if (current[part] === undefined || current[part] === null) {
      current[part] = {};
    }
    if (typeof current[part] !== "object" || Array.isArray(current[part])) {
      return false;
    }
    current = current[part] as Record<string, unknown>;
  }

  const lastPart = parts[parts.length - 1];
  if (lastPart === undefined) return false;
  current[lastPart] = value;
  return true;
}

/**
 * 아직 채우지 못한 필드를 계산한다.
 */
function computeStillUnresolved(
  unresolved: UnresolvedField[],
  resolved: ResolvedField[]
): UnresolvedField[] {
  const resolvedPaths = new Set(resolved.map((r) => r.path));
  return unresolved.filter((u) => !resolvedPaths.has(u.path));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
