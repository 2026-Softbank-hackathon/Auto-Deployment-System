/**
 * apps/api/src/services/source-patch-service.ts
 * 코드 수정안 (PAT-02, #277) — 조회와 승인 · 거절 적용.
 *
 * 승인: 수정안을 적용해 저장해 둔 zip 을 이 배포의 새 source_versions 로 넣는다 → 빌드 · 재배포가 그 소스를 쓴다.
 * 거절: 원래 소스 그대로 배포한다. SQLite 에서 옮기려던 DB 리소스를 뺀 IR 을 새 버전으로 남긴다 (AWS 에도 DB 없음).
 */

import type { Pool } from "@camellia/db";
import type { PoolClient } from "pg";
import type { LocalizedText, SourcePatch } from "@camellia/contracts";
import { ApiError } from "../plugins/error-handler.js";

type SourcePatchRow = {
  deployment_id: number | string;
  kind: string;
  status: SourcePatch["status"];
  summary: string;
  notes: string[];
  /** 024 마이그레이션 전에 만든 수정안은 NULL */
  summary_i18n: LocalizedText | null;
  notes_i18n: LocalizedText[] | null;
  diff: string;
  files: SourcePatch["files"];
  generator: string;
  model: string | null;
  created_at: Date;
  decided_at: Date | null;
};

export class SourcePatchService {
  constructor(private readonly pool: Pool) {}

  async get(deploymentId: number): Promise<SourcePatch> {
    const result = await this.pool.query<SourcePatchRow>(
      `SELECT deployment_id, kind, status, summary, notes, summary_i18n, notes_i18n, diff, files, generator, model,
              created_at, decided_at
       FROM source_patches WHERE deployment_id = $1`,
      [deploymentId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new ApiError(404, "NOT_FOUND", `배포 ID ${deploymentId}에는 코드 수정안이 없습니다.`);
    }
    return {
      deploymentId: String(row.deployment_id),
      kind: "sqlite_to_postgres",
      status: row.status,
      summary: row.summary,
      notes: row.notes,
      ...(row.summary_i18n ? { summaryI18n: row.summary_i18n } : {}),
      ...(row.notes_i18n ? { notesI18n: row.notes_i18n } : {}),
      diff: row.diff,
      files: row.files,
      generator: row.generator,
      model: row.model,
      createdAt: row.created_at.toISOString(),
      decidedAt: row.decided_at?.toISOString() ?? null,
    };
  }
}

/** 승인 트랜잭션 안에서 수정안 결정을 적용한다 (approval-service 가 부른다) */
export async function applyPatchDecision(
  client: Pick<PoolClient, "query">,
  deploymentId: number,
  decision: "approve" | "reject",
): Promise<void> {
  const patchRes = await client.query<{
    status: string;
    patched_storage_key: string;
    patched_sha256: string;
    patched_size_bytes: number | string;
  }>(
    `SELECT status, patched_storage_key, patched_sha256, patched_size_bytes
     FROM source_patches WHERE deployment_id = $1 FOR UPDATE`,
    [deploymentId],
  );
  const patch = patchRes.rows[0];
  if (!patch || patch.status !== "pending") {
    throw new ApiError(409, "PATCH_NOT_PENDING", "결정을 기다리는 코드 수정안이 없습니다.");
  }

  await client.query(
    `UPDATE source_patches SET status = $2, decided_at = NOW() WHERE deployment_id = $1`,
    [deploymentId, decision === "approve" ? "approved" : "rejected"],
  );

  if (decision === "approve") {
    await client.query(
      `INSERT INTO source_versions (deployment_id, sha256, storage_key, size_bytes)
       VALUES ($1, $2, $3, $4)`,
      [deploymentId, patch.patched_sha256, patch.patched_storage_key, Number(patch.patched_size_bytes)],
    );
    return;
  }

  const irRes = await client.query<{ ir_json: Record<string, unknown> }>(
    `SELECT ir_json FROM ir_versions WHERE deployment_id = $1 ORDER BY id DESC LIMIT 1`,
    [deploymentId],
  );
  const ir = irRes.rows[0]?.ir_json;
  if (ir) {
    await client.query(
      `INSERT INTO ir_versions (deployment_id, ir_json, source) VALUES ($1, $2, 'user_edited')`,
      [deploymentId, JSON.stringify(withoutSqliteResources(ir))],
    );
  }
}

/** SQLite 에서 옮기려던 리소스(local_fallback = sqlite)를 뺀 IR */
export function withoutSqliteResources(ir: Record<string, unknown>): Record<string, unknown> {
  const resources = ir["resources"];
  if (!resources || typeof resources !== "object") return ir;
  const kept = Object.fromEntries(
    Object.entries(resources as Record<string, { local_fallback?: unknown }>).filter(
      ([, resource]) => resource?.local_fallback !== "sqlite",
    ),
  );
  const { resources: _removed, ...rest } = ir;
  return Object.keys(kept).length > 0 ? { ...rest, resources: kept } : rest;
}
