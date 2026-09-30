/**
 * packages/analyzer/src/ai/tools.ts
 *
 * Anthropic tool_use 스키마 정의.
 * fill_unresolved_ir_fields: 미해결 IR 필드를 채우는 도구.
 * SDK 타입에 직접 의존하지 않음 — 로컬 타입 사용.
 */

/**
 * AI가 채운 단일 필드.
 */
export type FilledField = {
  path: string;
  value: string | number | boolean | object | null;
};

/**
 * fill_unresolved_ir_fields 도구 입력 타입.
 */
export type FillUnresolvedInput = {
  fields: FilledField[];
};

/**
 * Anthropic tool 정의 (SDK Tool 타입과 호환되는 형태).
 */
export const FILL_UNRESOLVED_TOOL = {
  name: "fill_unresolved_ir_fields",
  description:
    "Fill unresolved fields in the IR draft. Provide only fields from the unresolved list. " +
    "Use dot-notation paths (e.g. 'services.api.port'). Never include secret values.",
  input_schema: {
    type: "object" as const,
    properties: {
      fields: {
        type: "array",
        description: "List of fields to fill with their resolved values.",
        items: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                "Dot-notation path to the IR field (e.g. 'services.api.port', 'deploy.profile').",
            },
            value: {
              description:
                "The resolved value. Can be string, number, boolean, object, or null if unresolvable.",
            },
          },
          required: ["path", "value"],
        },
      },
    },
    required: ["fields"],
  },
} as const;

/**
 * tool_use 결과 블록에서 FillUnresolvedInput을 추출한다.
 * 타입 가드.
 */
export function isFillUnresolvedInput(input: unknown): input is FillUnresolvedInput {
  if (typeof input !== "object" || input === null) return false;
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj["fields"])) return false;
  return obj["fields"].every(
    (f) =>
      typeof f === "object" &&
      f !== null &&
      typeof (f as Record<string, unknown>)["path"] === "string"
  );
}
