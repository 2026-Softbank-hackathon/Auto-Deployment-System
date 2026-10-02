/**
 * apps/api/tests/environment-service.test.ts
 * 유닛 테스트 (mock pool).
 * - aws access_key 방식 정상
 * - 시크릿 참조 없으면 400
 * - onprem 정상
 * - 이름 중복 409
 * - 진행 중 배포 있으면 delete 409
 * - 기본 연결 삭제 시 승계 · 기본 연결 변경 (#228)
 */

import { describe, it, expect, vi } from "vitest";
import type { Pool } from "@camellia/db";
import { EnvironmentService } from "../src/services/environment-service.js";

function makePool(fn: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount: number } | Promise<{ rows: unknown[]; rowCount: number }>): Pool {
  const query = vi.fn(fn);
  return {
    query,
    connect: vi.fn(async () => ({ query, release: vi.fn() })),
  } as unknown as Pool;
}

describe("EnvironmentService.create (aws access_key)", () => {
  it("secrets 이름 참조가 존재하면 생성 성공 → 응답 DTO 반환", async () => {
    const pool = makePool(async (sql, params) => {
      if (sql.includes("SELECT 1 FROM projects")) return { rows: [{}], rowCount: 1 };
      if (sql.includes("SELECT name FROM secrets")) {
        return { rows: [{ name: "aws-key-1" }, { name: "aws-secret-1" }], rowCount: 2 };
      }
      if (sql.includes("INSERT INTO environments"))
        return { rows: [{ id: 10, is_default: true, created_at: new Date("2026-09-30T09:00:00Z") }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const svc = new EnvironmentService(pool);
    const dto = await svc.create({
      projectId: 1,
      name: "aws-jeong",
      type: "aws",
      awsConfig: {
        credentialsType: "access_key",
        accessKeyIdSecretName: "aws-key-1",
        secretAccessKeySecretName: "aws-secret-1",
        region: "ap-northeast-2",
      },
    });
    expect(dto.id).toBe(10);
    expect(dto.type).toBe("aws");
    expect(dto.isDefault).toBe(true);
    expect(dto.awsConfig?.region).toBe("ap-northeast-2");
    expect(dto.agentStatus).toBeNull();
  });

  it("참조된 secrets 없으면 400 · 어떤 이름이 없는지 알려준다", async () => {
    const pool = makePool(async (sql) => {
      if (sql.includes("SELECT 1 FROM projects")) return { rows: [{}], rowCount: 1 };
      if (sql.includes("SELECT name FROM secrets")) {
        return { rows: [{ name: "aws-key-1" }], rowCount: 1 }; // secret-1 은 없음
      }
      return { rows: [], rowCount: 0 };
    });
    const svc = new EnvironmentService(pool);
    await expect(
      svc.create({
        projectId: 1,
        name: "aws-jeong",
        type: "aws",
        awsConfig: {
          credentialsType: "access_key",
          accessKeyIdSecretName: "aws-key-1",
          secretAccessKeySecretName: "aws-secret-1",
          region: "us-east-1",
        },
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });
  });

  it("access_key 방식에서 시크릿 이름 필드 누락 시 400", async () => {
    const pool = makePool(async () => ({ rows: [{}], rowCount: 1 }));
    const svc = new EnvironmentService(pool);
    await expect(
      svc.create({
        projectId: 1,
        name: "x",
        type: "aws",
        awsConfig: { credentialsType: "access_key", region: "us-east-1" },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("EnvironmentService.create (assume_role)", () => {
  it("roleArn + externalId 있으면 생성", async () => {
    const pool = makePool(async (sql) => {
      if (sql.includes("SELECT 1 FROM projects")) return { rows: [{}], rowCount: 1 };
      if (sql.includes("INSERT INTO environments"))
        return { rows: [{ id: 11, is_default: true, created_at: new Date() }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const svc = new EnvironmentService(pool);
    const dto = await svc.create({
      projectId: 1,
      name: "aws-role",
      type: "aws",
      awsConfig: {
        credentialsType: "assume_role",
        roleArn: "arn:aws:iam::123:role/deploy",
        externalId: "ext-1",
        region: "us-east-1",
      },
    });
    expect(dto.id).toBe(11);
  });
});

describe("EnvironmentService.create (onprem)", () => {
  it("onpremConfig 없으면 400", async () => {
    const pool = makePool(async () => ({ rows: [{}], rowCount: 1 }));
    const svc = new EnvironmentService(pool);
    await expect(
      svc.create({ projectId: 1, name: "op", type: "onprem" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("명시적 default 환경을 만들면 기존 default를 해제한다", async () => {
    const calls: string[] = [];
    const pool = makePool(async (sql) => {
      calls.push(sql.replace(/\s+/g, " ").trim());
      if (sql.includes("SELECT 1 FROM projects")) return { rows: [{}], rowCount: 1 };
      if (sql.includes("SELECT id FROM environments")) {
        return { rows: [{ id: 10 }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO environments")) {
        return { rows: [{ id: 12, is_default: true, created_at: new Date() }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const svc = new EnvironmentService(pool);

    const dto = await svc.create({
      projectId: 1,
      name: "onprem-new",
      type: "onprem",
      isDefault: true,
      onpremConfig: { agentRegistrationToken: "token", hostname: "host" },
    });

    expect(dto.isDefault).toBe(true);
    expect(calls.some((sql) => sql.includes("SET is_default = FALSE"))).toBe(true);
  });

  it("생성 응답에는 agentRegistrationToken이 그대로 포함된다(최초 1회 전달)", async () => {
    const pool = makePool(async (sql) => {
      if (sql.includes("SELECT 1 FROM projects")) return { rows: [{}], rowCount: 1 };
      if (sql.includes("INSERT INTO environments"))
        return { rows: [{ id: 13, is_default: true, created_at: new Date() }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const svc = new EnvironmentService(pool);

    const dto = await svc.create({
      projectId: 1,
      name: "onprem-created",
      type: "onprem",
      onpremConfig: { agentRegistrationToken: "secret-token", hostname: "host" },
    });

    expect(dto.onpremConfig?.agentRegistrationToken).toBe("secret-token");
  });
});

describe("EnvironmentService.list / get — agentRegistrationToken 노출 제거(#61)", () => {
  const row = {
    id: 10,
    project_id: 1,
    name: "onprem-mac",
    type: "onprem" as const,
    is_default: true,
    aws_config: null,
    onprem_config: { agentRegistrationToken: "secret-token", hostname: "mac.local" },
    agent_status: null,
    last_seen_at: null,
    created_at: new Date("2026-09-30T09:00:00Z"),
  };

  it("list() 응답 onpremConfig에 agentRegistrationToken이 없다", async () => {
    const pool = makePool(async () => ({ rows: [row], rowCount: 1 }));
    const svc = new EnvironmentService(pool);

    const [dto] = await svc.list({ projectId: 1 });

    expect(dto?.onpremConfig).toEqual({ hostname: "mac.local" });
    expect(dto?.onpremConfig).not.toHaveProperty("agentRegistrationToken");
  });

  it("get() 응답 onpremConfig에 agentRegistrationToken이 없다", async () => {
    const pool = makePool(async () => ({ rows: [row], rowCount: 1 }));
    const svc = new EnvironmentService(pool);

    const dto = await svc.get(10);

    expect(dto.onpremConfig).toEqual({ hostname: "mac.local" });
    expect(dto.onpremConfig).not.toHaveProperty("agentRegistrationToken");
  });
});

describe("EnvironmentService.delete", () => {
  /** 지울 연결 조회 · DELETE 결과를 정해 두고 실행한 SQL 을 모은다 */
  function deletePool(opts: {
    env?: { project_id: number | null; type: "aws" | "onprem" };
    deleted?: { is_default: boolean };
    deleteError?: Error;
  }) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool = makePool(async (sql, params) => {
      const s = sql.replace(/\s+/g, " ").trim();
      calls.push({ sql: s, params });
      if (s.includes("FROM deployments")) return { rows: [], rowCount: 0 };
      if (s.startsWith("SELECT project_id, type FROM environments")) {
        return opts.env ? { rows: [opts.env], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (s.startsWith("DELETE FROM environments")) {
        if (opts.deleteError) throw opts.deleteError;
        return opts.deleted ? { rows: [opts.deleted], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });
    return { pool, calls };
  }

  it("진행 중 배포 있으면 409", async () => {
    const pool = makePool(async (sql) => {
      if (sql.includes("FROM deployments")) return { rows: [{ 1: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const svc = new EnvironmentService(pool);
    await expect(svc.delete(10)).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" });
  });

  it("기본 연결이 아니면 지우기만 하고 기본 연결은 그대로 둔다", async () => {
    const { pool, calls } = deletePool({
      env: { project_id: 1, type: "aws" },
      deleted: { is_default: false },
    });
    await expect(new EnvironmentService(pool).delete(10)).resolves.toBeUndefined();
    expect(calls.some((c) => c.sql.includes("SET is_default = TRUE"))).toBe(false);
    expect(calls.at(-1)!.sql).toBe("COMMIT");
  });

  it("기본 연결을 지우면 같은 소유 범위 · 종류에서 가장 오래된 연결을 기본으로 올린다 (#228)", async () => {
    const { pool, calls } = deletePool({
      env: { project_id: null, type: "aws" },
      deleted: { is_default: true },
    });
    await new EnvironmentService(pool).delete(10);

    expect(calls.find((c) => c.sql.includes("pg_advisory_xact_lock"))!.params).toEqual(["shared:aws"]);
    const promote = calls.find((c) => c.sql.includes("SET is_default = TRUE"))!;
    expect(promote.sql).toContain("project_id IS NOT DISTINCT FROM $1::bigint AND type = $2");
    expect(promote.sql).toContain("ORDER BY created_at, id LIMIT 1");
    expect(promote.params).toEqual([null, "aws"]);
    // 삭제와 승계는 한 트랜잭션
    const sqls = calls.map((c) => c.sql);
    expect(sqls.indexOf("BEGIN")).toBeLessThan(sqls.findIndex((s) => s.startsWith("DELETE")));
    expect(sqls.indexOf("COMMIT")).toBeGreaterThan(sqls.indexOf(promote.sql));
  });

  it("환경 없으면 404", async () => {
    const { pool, calls } = deletePool({});
    await expect(new EnvironmentService(pool).delete(999)).rejects.toMatchObject({ statusCode: 404 });
    expect(calls.at(-1)!.sql).toBe("ROLLBACK");
  });

  it("배포 기록이 참조 중이면(FK RESTRICT) 500 대신 409 (#215)", async () => {
    const { pool, calls } = deletePool({
      env: { project_id: 1, type: "aws" },
      deleteError: Object.assign(new Error("violates foreign key constraint"), { code: "23503" }),
    });
    await expect(new EnvironmentService(pool).delete(10)).rejects.toMatchObject({
      statusCode: 409,
      code: "CONFLICT",
      message: expect.stringContaining("배포한 기록"),
    });
    expect(calls.at(-1)!.sql).toBe("ROLLBACK");
  });
});

describe("EnvironmentService.setDefault (#228)", () => {
  it("같은 소유 범위 · 종류의 기존 기본을 먼저 풀고 이 연결을 기본으로 한 뒤 조회 결과를 돌려준다", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool = makePool(async (sql, params) => {
      const s = sql.replace(/\s+/g, " ").trim();
      calls.push({ sql: s, params });
      if (s.startsWith("SELECT project_id, type FROM environments")) {
        return { rows: [{ project_id: 5, type: "onprem" }], rowCount: 1 };
      }
      if (s.includes("LEFT JOIN agents")) {
        return {
          rows: [
            {
              id: 11,
              project_id: 5,
              name: "mac",
              type: "onprem",
              is_default: true,
              aws_config: null,
              onprem_config: { agentRegistrationToken: "t", hostname: "h" },
              agent_status: null,
              last_seen_at: null,
              created_at: new Date("2026-10-01T00:00:00Z"),
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const dto = await new EnvironmentService(pool).setDefault(11);

    expect(dto).toMatchObject({ id: 11, isDefault: true, onpremConfig: { hostname: "h" } });
    expect(calls.find((c) => c.sql.includes("pg_advisory_xact_lock"))!.params).toEqual(["5:onprem"]);
    const sqls = calls.map((c) => c.sql);
    const unset = sqls.findIndex((s) => s.includes("SET is_default = FALSE"));
    const set = sqls.findIndex((s) => s.includes("SET is_default = TRUE"));
    expect(unset).toBeGreaterThan(-1);
    expect(set).toBeGreaterThan(unset);
    expect(calls[unset]!.params).toEqual([5, "onprem", 11]);
    expect(calls[set]!.params).toEqual([11]);
    expect(sqls.indexOf("COMMIT")).toBeGreaterThan(set);
  });

  it("환경 없으면 404", async () => {
    const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
    await expect(new EnvironmentService(pool).setDefault(999)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("EnvironmentService 공용 연결 (#215)", () => {
  it("projectId 없이 만들면 프로젝트 확인 없이 project_id NULL 로 저장하고 공용 범위에서 기본값을 정한다", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool = makePool(async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      if (sql.includes("SELECT name FROM secrets")) {
        return { rows: [{ name: "k" }, { name: "s" }], rowCount: 2 };
      }
      if (sql.includes("INSERT INTO environments")) {
        return { rows: [{ id: 20, is_default: true, created_at: new Date() }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const svc = new EnvironmentService(pool);

    const dto = await svc.create({
      name: "aws-shared",
      type: "aws",
      awsConfig: {
        credentialsType: "access_key",
        accessKeyIdSecretName: "k",
        secretAccessKeySecretName: "s",
        region: "ap-northeast-2",
      },
    });

    expect(dto).toMatchObject({ projectId: null, shared: true, isDefault: true, agentOnline: false });
    expect(calls.some((c) => c.sql.includes("FROM projects"))).toBe(false);
    const secretCheck = calls.find((c) => c.sql.includes("FROM secrets"))!;
    expect(secretCheck.sql).toContain("project_id IS NOT DISTINCT FROM $1::bigint");
    expect(secretCheck.params[0]).toBeNull();
    expect(calls.find((c) => c.sql.includes("pg_advisory_xact_lock"))!.params).toEqual(["shared:aws"]);
    expect(calls.find((c) => c.sql.includes("INSERT INTO environments"))!.params[0]).toBeNull();
  });

  it("list() 에 projectId 가 없으면 공용 연결만 읽는다", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool = makePool(async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    });
    await new EnvironmentService(pool).list({});
    expect(calls[0]!.sql).toContain("LEFT JOIN agents");
    expect(calls[0]!.params).toEqual([null]);
  });
});
