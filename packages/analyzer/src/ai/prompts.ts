/**
 * packages/analyzer/src/ai/prompts.ts
 *
 * system prompt 및 few-shot 캐시 대상 상수.
 * cache_control: { type: "ephemeral" } 로 캐싱한다 (D-52).
 */

export type SystemBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
};

/**
 * system 메시지 블록 (캐시 가능).
 * IR 필드 채우기 전용 프롬프트.
 */
export const SYSTEM_PROMPT_BLOCKS: SystemBlock[] = [
  {
    type: "text",
    text: `You are analyzing a web app source tree to produce an IR (Intermediate Representation) draft.

Your task is to fill only the unresolved fields in the IR draft. Rules:
- Never invent secret values (passwords, API keys, tokens).
- When unsure, leave the field null rather than guessing.
- Only fill fields that appear in the "unresolved" list.
- Provide concrete values where they can be reasonably inferred from the service structure.
- For deploy.profile, "aws-ecs-basic" is the standard default unless context suggests otherwise.
- For service type, infer from framework: express/fastapi/flask/django/next = "http", queue consumers = "worker".
- For commands, infer from language: Node.js = ["node", "<main file>"], Python = ["python", "-m", "<module>"].
- Port defaults: Node.js HTTP = 3000, Python HTTP = 8000, unless overridden.

Always call the fill_unresolved_ir_fields tool with your answer.`,
  },
];

/**
 * system 메시지 블록을 캐시 제어와 함께 반환한다.
 * 마지막 블록에만 cache_control을 붙인다 (Anthropic API 규칙).
 */
export function getSystemBlocksWithCache(): SystemBlock[] {
  const blocks = [...SYSTEM_PROMPT_BLOCKS];
  const last = blocks[blocks.length - 1]!;
  return [
    ...blocks.slice(0, -1),
    {
      ...last,
      cache_control: { type: "ephemeral" } as const,
    },
  ];
}
