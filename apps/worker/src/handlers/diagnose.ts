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
 * 4. Claude 호출 → { failedStep, summary, patchCandidates[] }
 * 5. deployments.diagnosis_json 저장 + ai_usage INSERT
 */

import { createClient, redact, type AnthropicLike, type AnthropicContentBlock } from "@camellia/analyzer";
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

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 2000;

/**
 * Anthropic SDK 클라이언트 팩토리 주입 가능 (테스트용).
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

  // 3. Claude SDK 확보 (실패 시 fallback diagnosis 저장 후 종료)
  const factory =
    clientFactory ??
    (() => createClient({ apiKey: process.env["ANTHROPIC_API_KEY"] }));
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
    "당신은 CI/CD 배포 실패 원인을 진단하는 AI입니다. 실패한 배포의 상태·로그·IR을 보고 (1) 실패 원인 한국어 3-5문장 요약, (2) 수정 후보 최대 3개 (각각 description + unified diff 형식)를 JSON으로 반환하세요. 반드시 JSON 만: { failedStep, summary, patchCandidates: [{ description, diff }] }.";
  const userPrompt = `배포 컨텍스트 (시크릿 마스킹됨):\n${redact(JSON.stringify(context, null, 2))}\n\n위 정보로 진단 JSON 을 반환하세요.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  // 5. 응답 파싱 (JSON 블록 추출)
  const textBlock = response.content.find(
    (c: AnthropicContentBlock) => c.type === "text",
  );
  let parsed: Omit<DiagnosisResult, "generatedAt"> = {
    failedStep: context.failedStep,
    summary: "AI 응답을 파싱할 수 없습니다.",
    patchCandidates: [],
  };
  if (textBlock && textBlock.type === "text") {
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

  // 6. ai_usage INSERT (토큰·비용)
  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  const estimatedCost = estimateCost(inputTokens, outputTokens);
  await pool.query(
    `INSERT INTO ai_usage(deployment_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, estimated_cost_usd)
     VALUES ($1,$2,$3,$4,0,0,$5)`,
    [deployment_id, MODEL, inputTokens, outputTokens, estimatedCost],
  );

  log?.info(
    { deployment_id, input_tokens: inputTokens, output_tokens: outputTokens },
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

/** claude-sonnet-4-6 대략 요금 (per M tokens). */
function estimateCost(inputTokens: number, outputTokens: number): number {
  const inputRate = 3.0;
  const outputRate = 15.0;
  return (inputTokens / 1_000_000) * inputRate + (outputTokens / 1_000_000) * outputRate;
}
