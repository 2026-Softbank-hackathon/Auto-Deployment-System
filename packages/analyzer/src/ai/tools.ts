/**
 * packages/analyzer/src/ai/tools.ts
 *
 * IR 빈칸 채우기 응답의 JSON 스키마 (구조화 출력, output_config.format).
 * 예전에는 강제 tool_use(tool_choice any)로 JSON 을 받았지만, Claude Opus 5.5 는
 * 강제 tool_choice 를 400 으로 거절하므로 구조화 출력으로 바꿨다 (D-56).
 * SDK 타입에 직접 의존하지 않음 — 로컬 타입 사용.
 */

/**
 * AI가 채운 단일 필드.
 */
export type FilledField = {
  path: string;
  value: string | number | boolean | string[] | null;
};

/**
 * 응답 JSON 타입.
 */
export type FillUnresolvedInput = {
  fields: FilledField[];
};

/**
 * output_config.format.schema 로 보내는 JSON 스키마.
 * 구조화 출력 규칙: 모든 object 에 additionalProperties: false.
 * value 는 IR 미해결 필드가 가질 수 있는 타입(문자열 · 정수 · 불리언 · 문자열 배열(command) · null)만 허용.
 */
export const FILL_UNRESOLVED_SCHEMA = {
  type: "object",
  properties: {
    fields: {
      type: "array",
      description: "Fields from the unresolved list with their resolved values.",
      items: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Dot-notation path to the IR field, exactly as in the unresolved list (e.g. 'services.api.port', 'deploy.profile').",
          },
          value: {
            description:
              "The resolved value: string, integer, boolean, array of strings (for command), or null if it cannot be inferred.",
            anyOf: [
              { type: "string" },
              { type: "integer" },
              { type: "boolean" },
              { type: "array", items: { type: "string" } },
              { type: "null" },
            ],
          },
        },
        required: ["path", "value"],
        additionalProperties: false,
      },
    },
  },
  required: ["fields"],
  additionalProperties: false,
} as const;

/**
 * 파싱한 응답이 FillUnresolvedInput 모양인지 확인한다.
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
