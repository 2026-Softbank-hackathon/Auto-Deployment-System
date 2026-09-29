/**
 * apps/api/src/services/project-service.ts
 * projects 테이블 CRUD.
 */

import type { Pool } from "@camellia/db";
import { ApiError } from "../plugins/error-handler.js";

export interface ProjectRow {
  id: number;
  name: string;
  description: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
}

export function projectToDto(row: ProjectRow) {
  return {
    id: String(row.id),
    name: row.name,
    description: row.description ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class ProjectService {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateProjectInput) {
    const { name, description } = input;
    try {
      const res = await this.pool.query<ProjectRow>(
        `INSERT INTO projects (name, description)
         VALUES ($1, $2)
         RETURNING id, name, description, created_at, updated_at`,
        [name, description ?? null]
      );
      const row = res.rows[0];
      if (!row) throw new ApiError(500, "INTERNAL_ERROR", "프로젝트 생성에 실패했습니다.");
      return projectToDto(row);
    } catch (err: unknown) {
      // Postgres unique violation: code 23505
      if (
        err instanceof Error &&
        (err as NodeJS.ErrnoException & { code?: string }).code === "23505"
      ) {
        throw new ApiError(409, "CONFLICT", `이름 "${name}"의 프로젝트가 이미 존재합니다.`, "다른 이름을 사용하세요.");
      }
      throw err;
    }
  }

  async list(opts: { limit: number; cursor?: string }) {
    const { limit, cursor } = opts;
    let rows: ProjectRow[];
    if (cursor) {
      const cursorId = Number(cursor);
      const res = await this.pool.query<ProjectRow>(
        `SELECT id, name, description, created_at, updated_at
         FROM projects
         WHERE id > $1
         ORDER BY id ASC
         LIMIT $2`,
        [cursorId, limit + 1]
      );
      rows = res.rows;
    } else {
      const res = await this.pool.query<ProjectRow>(
        `SELECT id, name, description, created_at, updated_at
         FROM projects
         ORDER BY id ASC
         LIMIT $1`,
        [limit + 1]
      );
      rows = res.rows;
    }

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(projectToDto);
    const nextCursor = hasMore ? String(rows[limit - 1]!.id) : null;

    return { items, nextCursor, total: items.length };
  }

  async get(id: number) {
    const res = await this.pool.query<ProjectRow>(
      `SELECT id, name, description, created_at, updated_at
       FROM projects WHERE id = $1`,
      [id]
    );
    const row = res.rows[0];
    if (!row) {
      throw new ApiError(404, "NOT_FOUND", `프로젝트 ID ${id}를 찾을 수 없습니다.`, "ID를 확인하세요.");
    }
    return projectToDto(row);
  }
}
