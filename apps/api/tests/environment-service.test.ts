/**
 * apps/api/tests/environment-service.test.ts
 * 유닛 테스트 (mock pool).
 * - aws access_key 방식 정상
 * - 시크릿 참조 없으면 400
 * - onprem 정상
 * - 이름 중복 409
 * - 진행 중 배포 있으면 delete 409
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
  it("진행 중 배포 있으면 409", async () => {
    const pool = makePool(async (sql) => {
      if (sql.includes("FROM deployments")) return { rows: [{ 1: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const svc = new EnvironmentService(pool);
    await expect(svc.delete(10)).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" });
  });

  it("진행 중 없고 row 삭제되면 성공", async () => {
    const pool = makePool(async (sql) => {
      if (sql.includes("FROM deployments")) return { rows: [], rowCount: 0 };
      if (sql.startsWith("DELETE FROM environments")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const svc = new EnvironmentService(pool);
    await expect(svc.delete(10)).resolves.toBeUndefined();
  });

  it("환경 없으면 404", async () => {
    const pool = makePool(async (sql) => {
      if (sql.includes("FROM deployments")) return { rows: [], rowCount: 0 };
      if (sql.startsWith("DELETE FROM environments")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const svc = new EnvironmentService(pool);
    await expect(svc.delete(999)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("배포 기록이 참조 중이면(FK RESTRICT) 500 대신 409 (#215)", async () => {
    const pool = makePool(async (sql) => {
      if (sql.includes("FROM deployments")) return { rows: [], rowCount: 0 };
      if (sql.startsWith("DELETE FROM environments")) {
        throw Object.assign(new Error("violates foreign key constraint"), { code: "23503" });
      }
      return { rows: [], rowCount: 0 };
    });
    const svc = new EnvironmentService(pool);
    await expect(svc.delete(10)).rejects.toMatchObject({
      statusCode: 409,
      code: "CONFLICT",
      message: expect.stringContaining("배포한 기록"),
    });
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
