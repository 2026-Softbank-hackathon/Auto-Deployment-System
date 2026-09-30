/**
 * packages/analyzer/src/ai/fill-unresolved.ts
 *
 * 핵심: unresolved 배열 → tool_use 결과 → 필드 채움 → IR 재검증.
 *
 * 근거: D-47 (AI 빈칸 채우기), D-50 (시크릿 값 미전송), CST-01 (사용량 기록)
 */

import { IrSchema } from "@camellia/ir-schema";
import type { Ir } from "@camellia/ir-schema";
import type { AnalysisResult, UnresolvedField } from "../types.js";
import { createClient } from "./anthropic-client.js";
import type { AnthropicLike } from "./anthropic-client.js";
import { getSystemBlocksWithCache } from "./prompts.js";
import { FILL_UNRESOLVED_TOOL, isFillUnresolvedInput } from "./tools.js";
import { buildTokenUsage } from "./tokens.js";
import type { TokenUsage } from "./tokens.js";
import { redactPayload } from "./redact.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FillOptions = {
  /** 주입 가능한 클라이언트 (테스트용). 지정 시 apiKey 무시. */
  client?: AnthropicLike;
  /** 명시적 API 키. 미지정 시 env ANTHROPIC_API_KEY 사용. */
  apiKey?: string;
  /** 사용할 모델. 기본값: "claude-opus-4-5" */
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
  /** API key 없음 등으로 AI 단계를 건너뛴 경우 true */
  skipped?: boolean;
  /** skip 이유 */
  skip_reason?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "claude-opus-4-5";
const DEFAULT_MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 500;

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * AnalysisResult의 unresolved 필드를 AI로 채운다.
 *
 * API key가 없으면 skipped=true로 즉시 반환한다.
 */
export async function fillUnresolved(
  analysis: AnalysisResult,
  opts: FillOptions = {}
): Promise<AiFillResult> {
  const ir_before = analysis.ir_draft;

  // API key 없으면 skip
  const hasKey =
    opts.client !== undefined ||
    opts.apiKey !== undefined ||
    (process.env["ANTHROPIC_API_KEY"] !== undefined &&
      process.env["ANTHROPIC_API_KEY"] !== "");

  if (!hasKey) {
    return {
      ir_before,
      ir_after: ir_before,
      ir_valid_after: analysis.ir_valid,
      ir_errors_after: analysis.ir_errors,
      resolved: [],
      still_unresolved: analysis.unresolved,
      usage: [],
      skipped: true,
      skip_reason: "no ANTHROPIC_API_KEY",
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
      client = await createClient({ apiKey: opts.apiKey });
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
        skip_reason: `Failed to load @anthropic-ai/sdk: ${String(err)}`,
      };
    }
  }

  const model = opts.model ?? DEFAULT_MODEL;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const usageList: TokenUsage[] = [];

  // Deep clone ir_draft to avoid mutation
  let irDraft: Partial<Ir> = JSON.parse(JSON.stringify(ir_before));
  const resolved: ResolvedField[] = [];
  let lastError: unknown = null;

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
        max_tokens: 1024,
        system: getSystemBlocksWithCache(),
        tools: [FILL_UNRESOLVED_TOOL],
        tool_choice: { type: "any" },
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

      // Extract tool_use blocks
      const toolUseBlock = response.content.find(
        (block): block is Extract<typeof block, { type: "tool_use" }> =>
          block.type === "tool_use"
      );

      if (!toolUseBlock || !isFillUnresolvedInput(toolUseBlock.input)) {
        // No tool use returned — treat as empty fill, exit loop
        break;
      }

      const fields = toolUseBlock.input.fields;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
