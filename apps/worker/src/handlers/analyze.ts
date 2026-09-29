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

export async function handleAnalyze(
  job: { data: AnalyzeJobPayload },
  deps: WorkerDeps
): Promise<void> {
  const { deployment_id, source_storage_key, sha256 } = job.data;
  const { pool, storage, notifier, log } = deps;

  log?.info({ deployment_id, source_storage_key }, "analyze job started");

  // 1. 상태 전이: received → analyzing
  await transitionTo(pool, deployment_id, "analyzing");
  await notifier?.notify(deployment_id, "state_changed", { status: "analyzing" });

  // 2. 소스 zip 취득
  const zipBuffer = await storage.get(source_storage_key);

  // 3. 임시 파일에 저장 (stage는 파일 경로를 필요로 한다)
  const tmpZip = await writeTmpFile(zipBuffer, `${sha256}.zip`);

  // 4. stage(unzip) → 소스 폴더 경로
  const staged = await stage(tmpZip, { mode: "unzip" });
  try {
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
    const irJson = analysis.ai?.ir_after ?? analysis.ir_draft;
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

    log?.info({ deployment_id }, "analyze job succeeded");
  } finally {
    await staged.cleanup?.();
    await fs.rm(tmpZip, { force: true }).catch(() => {});
  }
}
