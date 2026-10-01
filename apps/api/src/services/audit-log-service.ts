/**
 * apps/api/src/services/audit-log-service.ts
 * LOG-03 감사 로그 서비스.
 *
 * record(entry)  — INSERT INTO audit_logs
 * list(filters)  — SELECT with cursor pagination
 */

import type { Pool } from "@camellia/db";
import type { AuditLog } from "@camellia/contracts";

export interface AuditLogEntry {
  actorType: "session" | "agent" | "system";
  actorId: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  statusCode: number;
  requestId: string;
  metadata: Record<string, unknown> | null;
}

export interface AuditLogListFilters {
  actorType?: string;
  actorId?: string;
  resourceType?: string;
  resourceId?: string;
  actionPrefix?: string;
  limit: number;
  cursor?: string; // cursor = base64(id) of last seen row
}

export interface AuditLogListResult {
  items: AuditLog[];
  nextCursor: string | null;
}

interface AuditLogRow {
  id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  status_code: number;
  request_id: string;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

function rowToDto(row: AuditLogRow): AuditLog {
  return {
    id: String(row.id),
    actorType: row.actor_type as AuditLog["actorType"],
    actorId: row.actor_id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    statusCode: Number(row.status_code),
    requestId: row.request_id,
    metadata: row.metadata,
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : String(row.created_at),
  };
}

export class AuditLogService {
  constructor(private readonly pool: Pool) {}

  /** mutating 요청 1건을 audit_logs 에 INSERT */
  async record(entry: AuditLogEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_logs
         (actor_type, actor_id, action, resource_type, resource_id, status_code, request_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.actorType,
        entry.actorId,
        entry.action,
        entry.resourceType,
        entry.resourceId,
        entry.statusCode,
        entry.requestId,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
      ],
    );
  }

  /** cursor 기반 페이지네이션 조회 */
  async list(filters: AuditLogListFilters): Promise<AuditLogListResult> {
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (filters.actorType) {
      params.push(filters.actorType);
      conditions.push(`actor_type = $${params.length}`);
    }
    if (filters.actorId !== undefined) {
      params.push(filters.actorId);
      conditions.push(`actor_id = $${params.length}`);
    }
    if (filters.resourceType) {
      params.push(filters.resourceType);
      conditions.push(`resource_type = $${params.length}`);
    }
    if (filters.resourceId !== undefined) {
      params.push(filters.resourceId);
      conditions.push(`resource_id = $${params.length}`);
    }
    if (filters.actionPrefix) {
      params.push(`${filters.actionPrefix}%`);
      conditions.push(`action LIKE $${params.length}`);
    }
    if (filters.cursor) {
      const cursorId = Buffer.from(filters.cursor, "base64url").toString("utf8");
      params.push(cursorId);
      conditions.push(`id < $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const fetchLimit = filters.limit + 1; // 1개 더 가져와 nextCursor 판단
    params.push(fetchLimit);

    const sql = `
      SELECT id, actor_type, actor_id, action, resource_type, resource_id,
             status_code, request_id, metadata, created_at
      FROM audit_logs
      ${where}
      ORDER BY id DESC
      LIMIT $${params.length}
    `;

    const res = await this.pool.query<AuditLogRow>(sql, params);
    const rows = res.rows;

    let nextCursor: string | null = null;
    if (rows.length > filters.limit) {
      rows.pop(); // 초과분 제거
      const lastId = String(rows[rows.length - 1]!.id);
      nextCursor = Buffer.from(lastId, "utf8").toString("base64url");
    }

    return {
      items: rows.map(rowToDto),
      nextCursor,
    };
  }
}
