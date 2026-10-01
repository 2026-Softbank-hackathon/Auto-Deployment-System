/**
 * apps/worker/src/handlers/diagnose.ts
 *
 * API-36 AI 실패 진단.
 * job.data = { deployment_id }
 *
 * 처리 흐름:
 * 1. 이미 진단 있으면 skip (idempotent)
 * 2. 실패 배포 · 최신 IR · warnings · 스텝별 로그 tail 수집
 * 3. redact.ts 로 시크릿 마스킹 (D-50)
 * 4. Claude(Sonnet 5.5, 구조화 출력) 호출 → { failedStep, summary, patchCandidates[] }
 * 5. deployments.diagnosis_json 저장 + ai_usage INSERT
 */

import {
  createClient,
  estimateCost,
  redact,
  resolveAiProvider,
  resolveModel,
  type AiProvider,
  type AnthropicLike,
  type AnthropicContentBlock,
} from "@camellia/analyzer";
import type { WorkerDeps } from "../deps.js";

export type DiagnoseJobPayload = {
  deployment_id: number;
};

export type PatchCandidate = {
  description: string;
  diff: string;
};

export type DiagnosisResult = {
  failedStep: string | null;
  summary: string;
  patchCandidates: PatchCandidate[];
  generatedAt: string;
};

/**
 * Sonnet 5.5 는 thinking 을 끌 수 없고(disabled → 400) thinking 토큰이 max_tokens 에 포함된다.
 * 답(요약 + diff 최대 3개)과 생각 여유를 합쳐 스트리밍 없이 안전한 상한(~16K)으로 둔다.
 */
const MAX_TOKENS = 16000;
/**
 * 로그 · IR 을 읽고 원인을 추론해 패치를 제안하는 다단계 추론 → medium.
 * (low 는 단순 추출 · 대화용. 사람이 실패 후 한 번 보는 결과라 지연보다 품질 우선)
 */
const EFFORT = "medium" as const;

/** 구조화 출력 스키마 — 응답이 항상 이 모양의 JSON 이 되도록 강제한다. */
const DIAGNOSIS_SCHEMA = {
  type: "object",
  properties: {
    failedStep: { anyOf: [{ type: "string" }, { type: "null" }] },
    summary: { type: "string" },
    patchCandidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          diff: { type: "string" },
        },
        required: ["description", "diff"],
        additionalProperties: false,
      },
    },
  },
  required: ["failedStep", "summary", "patchCandidates"],
  additionalProperties: false,
};

/**
 * Claude 클라이언트 팩토리 주입 가능 (테스트용).
 */
export async function handleDiagnose(
  job: { data: DiagnoseJobPayload },
  deps: WorkerDeps,
  clientFactory?: () => Promise<AnthropicLike>,
): Promise<void> {
  const { deployment_id } = job.data;
  const { pool, log } = deps;

  log?.info({ deployment_id }, "diagnose job started");

  // 1. 배포 존재 + 진단 유무 확인 (idempotent)
  const existing = await pool.query<{ diagnosis_json: unknown }>(
    `SELECT diagnosis_json FROM deployments WHERE id = $1`,
    [deployment_id],
  );
  if (existing.rows.length === 0) {
    log?.warn({ deployment_id }, "deployment not found; skipping diagnose");
    return;
  }
  if (existing.rows[0]?.diagnosis_json != null) {
    log?.info({ deployment_id }, "diagnosis already exists; skipping");
    return;
  }

  // 2. 컨텍스트 수집
  const context = await gatherContext(pool, deployment_id);

  // 3. Claude 클라이언트 확보 (AI 비활성 · 실패 시 fallback diagnosis 저장 후 종료)
  const ai = resolveAiProvider();
  if (clientFactory === undefined && ai.provider === null) {
    log?.info({ deployment_id, reason: ai.reason }, "AI disabled; storing fallback diagnosis");
    await storeDiagnosis(pool, deployment_id, {
      failedStep: context.failedStep,
      summary: "AI 진단이 꺼져 있어(AI_PROVIDER 미설정) 진단을 건너뜁니다.",
      patchCandidates: [],
      generatedAt: new Date().toISOString(),
    });
    return;
  }
  const provider: AiProvider = ai.provider ?? "anthropic";
  const model = resolveModel("diagnose", provider);
  const factory = clientFactory ?? (() => createClient({ provider }));
  let client: AnthropicLike;
  try {
    client = await factory();
  } catch (e) {
    log?.warn({ err: e, deployment_id }, "Claude SDK unavailable; storing fallback diagnosis");
    await storeDiagnosis(pool, deployment_id, {
      failedStep: context.failedStep,
      summary: "AI 진단 SDK를 사용할 수 없어 진단을 건너뜁니다.",
      patchCandidates: [],
      generatedAt: new Date().toISOString(),
    });
    return;
  }

  // 4. 프롬프트 (시크릿 마스킹)
  const systemPrompt =
    "당신은 CI/CD 배포 실패 원인을 진단하는 AI입니다. 실패한 배포의 상태·로그·IR을 보고 (1) 실패 원인 한국어 3-5문장 요약, (2) 수정 후보 최대 3개 (각각 description + unified diff 형식)를 JSON으로 반환하세요. 형식: { failedStep, summary, patchCandidates: [{ description, diff }] }.";
  const userPrompt = `배포 컨텍스트 (시크릿 마스킹됨):\n${redact(JSON.stringify(context, null, 2))}\n\n위 정보로 진단 JSON 을 반환하세요.`;

  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    // thinking 필드는 보내지 않는다 (Sonnet 5.5 기본 adaptive, disabled 는 400)
    output_config: {
      effort: EFFORT,
      format: { type: "json_schema", schema: DIAGNOSIS_SCHEMA },
    },
    messages: [{ role: "user", content: userPrompt }],
  });

  // 5. 응답 파싱 — refusal 은 content 를 읽기 전에 거른다 (content 가 비었거나 일부만 있음)
  const textBlock =
    response.stop_reason === "refusal"
      ? undefined
      : response.content.find((c: AnthropicContentBlock) => c.type === "text");
  let parsed: Omit<DiagnosisResult, "generatedAt"> = {
    failedStep: context.failedStep,
    summary:
      response.stop_reason === "refusal"
        ? `AI 가 이 진단 요청을 거절했습니다 (category: ${response.stop_details?.category ?? "none"}).`
        : response.stop_reason === "max_tokens"
          ? "AI 응답이 길이 제한(max_tokens)에서 잘려 진단을 만들지 못했습니다."
          : "AI 응답을 파싱할 수 없습니다.",
    patchCandidates: [],
  };
  if (textBlock && textBlock.type === "text" && response.stop_reason !== "max_tokens") {
    const match = textBlock.text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const j = JSON.parse(match[0]) as Partial<DiagnosisResult>;
        parsed = {
          failedStep: j.failedStep ?? context.failedStep,
          summary: typeof j.summary === "string" ? j.summary : "요약 없음",
          patchCandidates: Array.isArray(j.patchCandidates)
            ? j.patchCandidates.slice(0, 3).map((p) => ({
                description: String(p?.description ?? ""),
                diff: String(p?.diff ?? ""),
              }))
            : [],
        };
      } catch {
        parsed = {
          ...parsed,
          summary: textBlock.text.slice(0, 500),
        };
      }
    } else {
      parsed = { ...parsed, summary: textBlock.text.slice(0, 500) };
    }
  }

  await storeDiagnosis(pool, deployment_id, {
    ...parsed,
    generatedAt: new Date().toISOString(),
  });

  // 6. ai_usage INSERT (토큰·비용 — 1P 단가 기준 추정치)
  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  const estimatedCost = estimateCost(
    { input_tokens: inputTokens, output_tokens: outputTokens },
    model,
  );
  await pool.query(
    `INSERT INTO ai_usage(deployment_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, estimated_cost_usd)
     VALUES ($1,$2,$3,$4,0,0,$5)`,
    [deployment_id, model, inputTokens, outputTokens, estimatedCost],
  );

  log?.info(
    { deployment_id, model, stop_reason: response.stop_reason, input_tokens: inputTokens, output_tokens: outputTokens },
    "diagnose job succeeded",
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function gatherContext(
  pool: WorkerDeps["pool"],
  deploymentId: number,
) {
  const dep = await pool.query<{
    status: string;
    target_profile: string | null;
    error: string | null;
  }>(
    `SELECT status, target_profile, error FROM deployments WHERE id = $1`,
    [deploymentId],
  );

  const steps = await pool.query<{
    step_name: string;
    status: string;
    message: string | null;
  }>(
    `SELECT step_name, status, message FROM deployment_steps
     WHERE deployment_id = $1
     ORDER BY id DESC LIMIT 20`,
    [deploymentId],
  );

  const failedStep = steps.rows.find((s) => s.status === "failed")?.step_name ?? null;

  const irRes = await pool.query<{ ir_json: unknown }>(
    `SELECT ir_json FROM ir_versions
     WHERE deployment_id = $1
     ORDER BY id DESC LIMIT 1`,
    [deploymentId],
  );

  const arRes = await pool.query<{ warnings_json: unknown }>(
    `SELECT warnings_json FROM analysis_reports
     WHERE deployment_id = $1
     ORDER BY id DESC LIMIT 1`,
    [deploymentId],
  );

  return {
    deployment: dep.rows[0] ?? null,
    failedStep,
    steps: steps.rows.map((s) => ({
      step: s.step_name,
      status: s.status,
      messageTail: (s.message ?? "").split("\n").slice(-30).join("\n"),
    })),
    ir: irRes.rows[0]?.ir_json ?? null,
    warnings: arRes.rows[0]?.warnings_json ?? [],
  };
}

async function storeDiagnosis(
  pool: WorkerDeps["pool"],
  deploymentId: number,
  diagnosis: DiagnosisResult,
): Promise<void> {
  await pool.query(
    `UPDATE deployments SET diagnosis_json = $1 WHERE id = $2`,
    [JSON.stringify(diagnosis), deploymentId],
  );
}
