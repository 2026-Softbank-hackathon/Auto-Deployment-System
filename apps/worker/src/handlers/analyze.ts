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

import { createHash } from "node:crypto";
import { stage } from "@camellia/analyzer/stager";
import { awsLambdaBasic, awsStaticBasic } from "@camellia/profiles";
import {
  analyzeWithAI,
  applyPatch,
  countDiffLines,
  createSqlitePatch,
  createUnifiedDiff,
  zipDirectory,
} from "@camellia/analyzer";
import type {
  AnalysisResult,
  FillOptions,
  SqlitePatch,
  SqlitePatchSkipped,
  TokenUsage,
} from "@camellia/analyzer";
import type { WorkerDeps } from "../deps.js";
import { transitionTo } from "../state-machine.js";
import { createStepLogger } from "../step-log.js";
import { logMessage } from "../log-messages.js";
import { syncTargetProfile, withDeployProfile } from "../profile-sync.js";

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

/**
 * 이번 배포의 target_profile 을 IR 에 맞게 다시 고른다 (#273, 9/30 합의: 사용자는 AWS / 온프레미스만 고르고
 * 프로필은 시스템이 고른다). 같은 연결 종류 · 배포 형태 안에서 profiles 카탈로그 규칙(resolveProfileAfterAnalysis)으로:
 * - AWS + 정적 사이트 → aws-static-basic (서버 없이 S3)
 * - 서버리스(aws-lambda-basic)를 골랐지만 Lambda 로 띄울 수 없는 앱(공개 HTTP 서비스 하나가 아니거나
 *   DB 같은 리소스가 있음)이면 컨테이너 프로필로 되돌리고 이유를 남긴다 (#282)
 */
async function settleTargetProfile(
  pool: WorkerDeps["pool"],
  deploymentId: number,
  ir: unknown,
  stepLog: ReturnType<typeof createStepLogger>,
): Promise<string | null> {
  const result = await pool.query<{ target_profile: string | null }>(
    "SELECT target_profile FROM deployments WHERE id = $1",
    [deploymentId]
  );
  const current = result.rows[0]?.target_profile ?? null;
  const { profile, changed } = await syncTargetProfile(pool, deploymentId, current, ir);
  if (!changed || !profile) return profile;
  if (profile === awsStaticBasic.id) {
    await stepLog.line(logMessage("analyze.staticProfile"));
  } else if (current === awsLambdaBasic.id) {
    await stepLog.line(logMessage("analyze.lambdaFallback"));
  } else {
    await stepLog.line(logMessage("analyze.profileSet", { profile }));
  }
  return profile;
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
       -- SQLite 앱은 수정안(#277)을 다시 만들어 승인받아야 하므로 캐시를 쓰지 않는다
       AND NOT (ar.resources_json @> '[{"local_fallback": "sqlite"}]'::jsonb)
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

  // 1. 상태 전이: received → analyzing (재진입 처리 — pg-boss retry 등).
  //    - received  : 정상 전이 + SSE 알림
  //    - analyzing : 재진입 (worker crash·job retry) — 로그만, 분석 계속 (idempotent)
  //    - 그 외     : 이미 다른 상태로 진행됨 → 조기 return (skip)
  const currentRes = await pool.query<{ status: string }>(
    "SELECT status FROM deployments WHERE id = $1",
    [deployment_id],
  );
  const currentStatus = currentRes.rows[0]?.status;
  if (currentStatus === undefined) {
    throw new Error("ANALYZE_DEPLOYMENT_NOT_FOUND");
  }
  if (currentStatus === "received") {
    await transitionTo(pool, deployment_id, "analyzing");
    await notifier?.notify(deployment_id, "state_changed", {
      status: "analyzing",
    });
  } else if (currentStatus === "analyzing") {
    log?.info(
      { deployment_id, status: currentStatus },
      "analyze reentry — already analyzing, continuing",
    );
  } else {
    log?.warn(
      { deployment_id, status: currentStatus },
      "analyze skip — deployment already past analyzing",
    );
    return;
  }
  await stepLog.line(logMessage("analyze.start"));

  // 2. ANL-08 캐시 조회: 같은 sha256 을 가진 기존 배포의 분석 결과 재사용
  const cached = await lookupAnalysisCache(pool, sha256, deployment_id);
  if (cached) {
    log?.info(
      { deployment_id, cached_source_version: cached.source_version_id },
      "analyze cache hit — skipping analyzer + AI"
    );
    await stepLog.line(logMessage("analyze.cacheReuse", { sourceVersionId: cached.source_version_id }));
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

    // ir_versions 복사 — IR 로 이번 배포의 프로필을 다시 골라(#273) deploy.profile 덮어쓰기
    let irJson = cached.ir_json as Record<string, unknown> | null;
    if (irJson) {
      const profile = await settleTargetProfile(pool, deployment_id, irJson, stepLog);
      if (profile) irJson = withDeployProfile(irJson, profile);
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
    await stepLog.line(logMessage("analyze.awaitTarget"));

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
    await stepLog.line(logMessage("analyze.unzipped"));
    await notifier?.notify(deployment_id, "analysis.progress", {
      step: "detecting",
    });

    // 5. analyze + AI fill (제공자 · 모델은 env 로 결정: AI_PROVIDER · ANTHROPIC_API_KEY)
    const opts: FillOptions = {
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
      logMessage(irValid ? "analyze.doneValid" : "analyze.doneInvalid", {
        services: analysis.services.length,
        warnings: analysis.warnings.length,
      })
    );

    // PAT-02 (#277): SQLite 앱이면 PostgreSQL 겸용 수정안을 만든다. 못 만들면 DB 전환 없이 SQLite 그대로 배포
    const irDraft = (analysis.ai?.ir_after ?? analysis.ir_draft) as Record<string, unknown>;
    const sqlitePatch = await prepareSqlitePatch(
      deps,
      staged.resolvedPath,
      analysis,
      (usage) => opts.onUsage?.(usage),
      stepLog,
    );
    if (sqlitePatch?.status === "skipped") {
      analysis.warnings.push({
        code: "PAT-02-SKIPPED",
        message: `DB 전환 수정안을 만들지 못해 SQLite 그대로 배포합니다 (${sqlitePatch.reason})`,
      });
      removeSqliteResources(irDraft);
    }

    // 6. analysis_reports INSERT (source_version_id 포함 — ANL-08 캐시 조회가 이 값으로 JOIN 한다)
    await pool.query(
      `INSERT INTO analysis_reports(deployment_id, source_version_id, services_json, resources_json, warnings_json, unresolved_json, ir_valid, ir_errors_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        deployment_id,
        source_version_id ?? null,
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
    // IR 로 프로필을 다시 골라(#273 · #282) IR deploy.profile 에 반영 (분석기 기본값 "aws-ecs-basic" 덮어쓰기)
    let irJson: unknown = analysis.ai?.ir_after ?? analysis.ir_draft;
    if (irJson && typeof irJson === "object") {
      const profile = await settleTargetProfile(pool, deployment_id, irJson, stepLog);
      if (profile) irJson = withDeployProfile(irJson as Record<string, unknown>, profile);
    }
    const source =
      analysis.ai != null && !analysis.ai.skipped ? "ai_filled" : "analyzer";

    await pool.query(
      `INSERT INTO ir_versions(deployment_id, ir_json, source) VALUES ($1,$2,$3)`,
      [deployment_id, JSON.stringify(irJson), source]
    );

    // 8. 수정안이 있으면 사용자 승인(diff)을 기다린다 — 원클릭에서 사용자가 하는 유일한 확인
    if (sqlitePatch?.status === "ready") {
      await saveSourcePatch(pool, deployment_id, sqlitePatch);
      await transitionTo(pool, deployment_id, "awaiting_patch_approval");
      await notifier?.notify(deployment_id, "analysis.progress", {
        step: "complete",
        ir_valid: irValid,
      });
      await notifier?.notify(deployment_id, "state_changed", { status: "awaiting_patch_approval" });
      await notifier?.notify(deployment_id, "approval_requested", { gate: "patch" });
      await stepLog.line(logMessage("analyze.awaitPatch"));
      log?.info({ deployment_id }, "analyze job succeeded (awaiting patch approval)");
      return;
    }

    // 상태 전이: analyzing → awaiting_target_confirmation
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
    await stepLog.line(logMessage("analyze.awaitTarget"));

    log?.info({ deployment_id }, "analyze job succeeded");
  } catch (err) {
    await stepLog.line(logMessage("analyze.failed", { error: err instanceof Error ? err.message : String(err) }));
    throw err;
  } finally {
    await staged.cleanup?.();
    await fs.rm(tmpZip, { force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// SQLite → PostgreSQL 수정안 (PAT-02 · MIG-03, #277)
// ---------------------------------------------------------------------------

type PreparedPatch = SqlitePatch & { storageKey: string; sha256: string; sizeBytes: number };

/**
 * 분석 결과에 SQLite 에서 옮길 DB 가 있으면 수정안을 만든다. 없으면 null.
 * 수정안을 적용한 소스는 바로 zip 으로 저장해 둔다 — 승인하면 이 zip 이 이 배포의 새 소스 버전이 된다.
 */
async function prepareSqlitePatch(
  deps: WorkerDeps,
  sourceRoot: string,
  analysis: AnalysisResult,
  onUsage: (usage: TokenUsage) => unknown,
  stepLog: ReturnType<typeof createStepLogger>,
): Promise<PreparedPatch | SqlitePatchSkipped | null> {
  const resource = analysis.resources.find((candidate) => candidate.local_fallback === "sqlite");
  if (!resource) return null;
  const service = analysis.services[0];
  if (analysis.services.length !== 1 || !service) {
    return { status: "skipped", reason: "MULTI_SERVICE: 서비스가 여러 개인 앱은 아직 자동 수정안을 만들지 않습니다" };
  }

  await stepLog.line(logMessage("analyze.patchStart"));
  const serviceDir = path.resolve(sourceRoot, service.path);
  const patch = await createSqlitePatch(serviceDir, resource, { onUsage: async (usage) => { await onUsage(usage); } });
  if (patch.status === "skipped") {
    const [code = "", ...detail] = patch.reason.split(": ");
    await stepLog.line(logMessage("analyze.patchSkipped", { code, detail: detail.join(": ") }));
    return patch;
  }

  await applyPatch(serviceDir, patch.files);
  const zip = await zipDirectory(sourceRoot);
  const sha256 = createHash("sha256").update(zip).digest("hex");
  const storageKey = `sources/${sha256}.zip`;
  await deps.storage.put(storageKey, zip);
  await stepLog.line(
    logMessage("analyze.patchReady", {
      count: patch.files.length,
      files: patch.files.map((file) => file.path).join(", "),
    }),
  );
  return { ...patch, storageKey, sha256, sizeBytes: zip.length };
}

async function saveSourcePatch(
  pool: WorkerDeps["pool"],
  deploymentId: number,
  patch: PreparedPatch,
): Promise<void> {
  const files = patch.files.map((file) => {
    const counts = file.generated
      ? { additions: 0, deletions: 0 }
      : countDiffLines(createUnifiedDiff(file.path, file.before, file.after));
    return {
      path: file.path,
      change: file.before === null ? "added" : "modified",
      ...counts,
      generated: file.generated === true,
    };
  });
  await pool.query(
    `INSERT INTO source_patches
       (deployment_id, kind, status, summary, notes, diff, files, generator, model,
        patched_storage_key, patched_sha256, patched_size_bytes, summary_i18n, notes_i18n)
     VALUES ($1, 'sqlite_to_postgres', 'pending', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (deployment_id) DO UPDATE SET
       status = 'pending', summary = EXCLUDED.summary, notes = EXCLUDED.notes, diff = EXCLUDED.diff,
       summary_i18n = EXCLUDED.summary_i18n, notes_i18n = EXCLUDED.notes_i18n,
       files = EXCLUDED.files, generator = EXCLUDED.generator, model = EXCLUDED.model,
       patched_storage_key = EXCLUDED.patched_storage_key, patched_sha256 = EXCLUDED.patched_sha256,
       patched_size_bytes = EXCLUDED.patched_size_bytes, created_at = NOW(), decided_at = NULL`,
    [
      deploymentId,
      // summary · notes 는 한국어 (예전 화면 호환), 두 언어 값은 *_i18n (#147)
      patch.summary.ko,
      JSON.stringify(patch.notes.map((note) => note.ko)),
      patch.diff,
      JSON.stringify(files),
      patch.generator,
      patch.model,
      patch.storageKey,
      patch.sha256,
      patch.sizeBytes,
      JSON.stringify(patch.summary),
      JSON.stringify(patch.notes),
    ],
  );
}

/** 수정안 없이 배포할 때 — SQLite 에서 옮기려던 리소스를 IR 에서 뺀다 (AWS 에도 DB 를 만들지 않음) */
function removeSqliteResources(ir: Record<string, unknown>): void {
  const resources = ir["resources"];
  if (!resources || typeof resources !== "object") return;
  const kept = Object.fromEntries(
    Object.entries(resources as Record<string, { local_fallback?: string }>).filter(
      ([, resource]) => resource?.local_fallback !== "sqlite",
    ),
  );
  if (Object.keys(kept).length > 0) ir["resources"] = kept;
  else delete ir["resources"];
}
