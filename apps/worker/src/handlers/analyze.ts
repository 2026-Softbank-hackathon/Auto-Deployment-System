/**
 * apps/worker/src/handlers/analyze.ts
 *
 * analyze job 핸들러.
 * job.data = { deployment_id, source_storage_key, sha256 }
 *
 * 처리 흐름:
 * 1. received → analyzing 전이 + NOTIFY
 * 2. storage에서 zip 취득
 * 3. 임시 파일 저장
 * 4. stage(unzip) → 소스 폴더
 * 5. analyzeWithAI 호출
 * 6. analysis_reports INSERT
 * 7. ir_versions INSERT
 * 8. analyzing → awaiting_target_confirmation 전이 + NOTIFY
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { stage } from "@camellia/analyzer/stager";
import { analyzeWithAI } from "@camellia/analyzer";
import type { FillOptions } from "@camellia/analyzer";
import type { WorkerDeps } from "../deps.js";
import { transitionTo } from "../state-machine.js";
import { createStepLogger } from "../step-log.js";

export type AnalyzeJobPayload = {
  deployment_id: number;
  source_storage_key: string;
  sha256: string;
  source_version_id?: number;
};

/** os.tmpdir() 아래에 버퍼를 파일로 쓰고 경로를 반환한다. */
async function writeTmpFile(buf: Buffer, filename: string): Promise<string> {
  const tmpPath = path.join(os.tmpdir(), filename);
  await fs.writeFile(tmpPath, buf);
  return tmpPath;
}

/** ANL-08: 같은 sha256 으로 이미 완료된 다른 배포의 분석 결과가 있으면 반환. */
type CachedAnalysis = {
  source_version_id: number;
  services_json: unknown;
  resources_json: unknown;
  warnings_json: unknown;
  unresolved_json: unknown;
  ir_valid: boolean;
  ir_errors_json: unknown | null;
  ir_json: unknown | null;
};

async function lookupAnalysisCache(
  pool: WorkerDeps["pool"],
  sha256: string,
  currentDeploymentId: number
): Promise<CachedAnalysis | null> {
  const res = await pool.query<CachedAnalysis>(
    `SELECT sv.id AS source_version_id,
            ar.services_json, ar.resources_json, ar.warnings_json,
            ar.unresolved_json, ar.ir_valid, ar.ir_errors_json,
            iv.ir_json
     FROM source_versions sv
     JOIN analysis_reports ar ON ar.source_version_id = sv.id
     LEFT JOIN LATERAL (
       SELECT ir_json FROM ir_versions
       WHERE deployment_id = ar.deployment_id
       ORDER BY id DESC LIMIT 1
     ) iv ON true
     WHERE sv.sha256 = $1 AND sv.deployment_id <> $2
     ORDER BY ar.id DESC
     LIMIT 1`,
    [sha256, currentDeploymentId]
  );
  return res.rows[0] ?? null;
}

export async function handleAnalyze(
  job: { data: AnalyzeJobPayload },
  deps: WorkerDeps
): Promise<void> {
  const { deployment_id, source_storage_key, sha256, source_version_id } = job.data;
  const { pool, storage, notifier, log } = deps;

  log?.info({ deployment_id, source_storage_key }, "analyze job started");
  const stepLog = createStepLogger(deps, deployment_id, "analyze");

  // 1. 상태 전이: received → analyzing
  await transitionTo(pool, deployment_id, "analyzing");
  await notifier?.notify(deployment_id, "state_changed", { status: "analyzing" });
  await stepLog.line("분석 시작");

  // 2. ANL-08 캐시 조회: 같은 sha256 을 가진 기존 배포의 분석 결과 재사용
  const cached = await lookupAnalysisCache(pool, sha256, deployment_id);
  if (cached) {
    log?.info(
      { deployment_id, cached_source_version: cached.source_version_id },
      "analyze cache hit — skipping analyzer + AI"
    );
    await stepLog.line(`이전 분석 결과 재사용 (source_version ${cached.source_version_id})`);
    await notifier?.notify(deployment_id, "analysis.progress", {
      step: "cache_hit",
      cached_source_version_id: cached.source_version_id,
    });

    // analysis_reports 복사 (source_version_id 는 이번 배포 것)
    await pool.query(
      `INSERT INTO analysis_reports(deployment_id, source_version_id, services_json, resources_json, warnings_json, unresolved_json, ir_valid, ir_errors_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        deployment_id,
        source_version_id ?? null,
        JSON.stringify(cached.services_json),
        JSON.stringify(cached.resources_json),
        JSON.stringify(cached.warnings_json),
        JSON.stringify(cached.unresolved_json),
        cached.ir_valid,
        cached.ir_errors_json != null ? JSON.stringify(cached.ir_errors_json) : null,
      ]
    );

    // ir_versions 복사 — 이번 배포의 target_profile 로 deploy.profile 덮어쓰기
    let irJson = cached.ir_json as Record<string, unknown> | null;
    if (irJson) {
      const targetProfileRes = await pool.query<{ target_profile: string | null }>(
        "SELECT target_profile FROM deployments WHERE id = $1",
        [deployment_id]
      );
      const targetProfile = targetProfileRes.rows[0]?.target_profile;
      if (targetProfile) {
        const deploy = (irJson["deploy"] ?? {}) as Record<string, unknown>;
        irJson = { ...irJson, deploy: { ...deploy, profile: targetProfile } };
      }
      await pool.query(
        `INSERT INTO ir_versions(deployment_id, ir_json, source) VALUES ($1,$2,$3)`,
        [deployment_id, JSON.stringify(irJson), "analyzer_cache"]
      );
    }

    // analyzing → awaiting_target_confirmation
    await transitionTo(pool, deployment_id, "awaiting_target_confirmation");
    await notifier?.notify(deployment_id, "analysis.progress", {
      step: "complete",
      ir_valid: cached.ir_valid,
      from_cache: true,
    });
    await notifier?.notify(deployment_id, "state_changed", {
      status: "awaiting_target_confirmation",
    });
    await notifier?.notify(deployment_id, "approval_requested", { gate: "target" });
    await stepLog.line("대상 확인 대기");

    log?.info({ deployment_id }, "analyze job succeeded (cache hit)");
    return;
  }

  // 3. 소스 zip 취득
  const zipBuffer = await storage.get(source_storage_key);

  // 3. 임시 파일에 저장 (stage는 파일 경로를 필요로 한다)
  const tmpZip = await writeTmpFile(zipBuffer, `${sha256}.zip`);

  // 4. stage(unzip) → 소스 폴더 경로
  const staged = await stage(tmpZip, { mode: "unzip" });
  try {
    await stepLog.line("소스 압축 해제 완료");
    await notifier?.notify(deployment_id, "analysis.progress", {
      step: "detecting",
    });

    // 5. analyze + AI fill
    const opts: FillOptions = {
      apiKey: process.env["ANTHROPIC_API_KEY"],
      onUsage: async (u) => {
        await pool.query(
          `INSERT INTO ai_usage(deployment_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, estimated_cost_usd)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            deployment_id,
            u.model,
            u.input_tokens,
            u.output_tokens,
            u.cache_creation_input_tokens ?? 0,
            u.cache_read_input_tokens ?? 0,
            u.estimated_cost_usd,
          ]
        );
      },
    };
    const analysis = await analyzeWithAI(staged.resolvedPath, opts);

    log?.info(
      { deployment_id, ir_valid: analysis.ai?.ir_valid_after ?? analysis.ir_valid },
      "analysis complete"
    );
    const irValid = analysis.ai?.ir_valid_after ?? analysis.ir_valid;
    await stepLog.line(
      `분석 완료 — 서비스 ${analysis.services.length}개, 경고 ${analysis.warnings.length}개, IR ${irValid ? "유효" : "검증 실패"}`
    );

    // 6. analysis_reports INSERT
    await pool.query(
      `INSERT INTO analysis_reports(deployment_id, services_json, resources_json, warnings_json, unresolved_json, ir_valid, ir_errors_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        deployment_id,
        JSON.stringify(analysis.services),
        JSON.stringify(analysis.resources),
        JSON.stringify(analysis.warnings),
        JSON.stringify(analysis.ai?.still_unresolved ?? analysis.unresolved),
        analysis.ai?.ir_valid_after ?? analysis.ir_valid,
        analysis.ai?.ir_errors_after != null
          ? JSON.stringify(analysis.ai.ir_errors_after)
          : null,
      ]
    );

    // 7. ir_versions INSERT
    // target_profile을 IR deploy.profile에 반영 (분석기 기본값 "aws-ecs-basic" 덮어쓰기)
    const irJson = analysis.ai?.ir_after ?? analysis.ir_draft;
    const targetProfileRes = await pool.query<{ target_profile: string | null }>(
      "SELECT target_profile FROM deployments WHERE id = $1",
      [deployment_id]
    );
    const targetProfile = targetProfileRes.rows[0]?.target_profile;
    if (targetProfile && irJson && typeof irJson === "object" && irJson !== null) {
      const ir = irJson as Record<string, unknown>;
      const deploy = (ir["deploy"] ?? {}) as Record<string, unknown>;
      ir["deploy"] = { ...deploy, profile: targetProfile };
    }
    const source =
      analysis.ai != null && !analysis.ai.skipped ? "ai_filled" : "analyzer";

    await pool.query(
      `INSERT INTO ir_versions(deployment_id, ir_json, source) VALUES ($1,$2,$3)`,
      [deployment_id, JSON.stringify(irJson), source]
    );

    // 8. 상태 전이: analyzing → awaiting_target_confirmation
    await transitionTo(pool, deployment_id, "awaiting_target_confirmation");
    await notifier?.notify(deployment_id, "analysis.progress", {
      step: "complete",
      ir_valid: analysis.ai?.ir_valid_after ?? analysis.ir_valid,
    });
    await notifier?.notify(deployment_id, "state_changed", {
      status: "awaiting_target_confirmation",
    });
    await notifier?.notify(deployment_id, "approval_requested", {
      gate: "target",
    });
    await stepLog.line("대상 확인 대기");

    log?.info({ deployment_id }, "analyze job succeeded");
  } catch (err) {
    await stepLog.line(`분석 실패: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  } finally {
    await staged.cleanup?.();
    await fs.rm(tmpZip, { force: true }).catch(() => {});
  }
}
