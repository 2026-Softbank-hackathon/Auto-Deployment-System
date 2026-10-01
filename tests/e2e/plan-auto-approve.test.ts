/**
 * tests/e2e/plan-auto-approve.test.ts
 *
 * Plan 자동 승인 트랜잭션의 실 Postgres 검증.
 *
 * autoApprovePlanInline(pool, deploymentId) 가:
 *   - planning → provisioning 로 상태를 전이
 *   - approvals 테이블에 (gate='plan', decision='approve', note contains 'auto-approved') 레코드 생성
 *   - planning 아닌 상태에서는 AUTO_APPROVE_STATE_INVALID throw
 *   - 동시 호출 시 FOR UPDATE 로 하나만 성공하고 다른 하나는 거절
 *
 * mock 통과만으로는 트랜잭션 격리·FOR UPDATE·UNIQUE 제약을 믿을 수 없어 실 Postgres 로 검증한다.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Pool } from "@camellia/db";
import { autoApprovePlanInline } from "../../apps/worker/src/handlers/build.js";
import { E2E_DATABASE_URL } from "./lib/harness.js";

describe("Plan 자동 승인 (실 Postgres)", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool(E2E_DATABASE_URL);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function createPlanningDeployment(): Promise<number> {
    const projectName = `plan-auto-approve-${Date.now()}-${Math.floor(
      Math.random() * 1_000_000,
    )}`;
    const project = await pool.query<{ id: string }>(
      "INSERT INTO projects (name) VALUES ($1) RETURNING id",
      [projectName],
    );
    const projectId = project.rows[0]!.id;
    const deployment = await pool.query<{ id: string }>(
      "INSERT INTO deployments (project_id, status) VALUES ($1, 'planning') RETURNING id",
      [projectId],
    );
    return Number(deployment.rows[0]!.id);
  }

  it("planning → provisioning 전이 + approvals 에 auto-approve 레코드", async () => {
    const deploymentId = await createPlanningDeployment();

    await autoApprovePlanInline(pool, deploymentId);

    const dep = await pool.query<{ status: string }>(
      "SELECT status FROM deployments WHERE id = $1",
      [deploymentId],
    );
    expect(dep.rows[0]?.status).toBe("provisioning");

    const approval = await pool.query<{
      gate: string;
      decision: string;
      note: string | null;
    }>(
      "SELECT gate, decision, note FROM approvals WHERE deployment_id = $1",
      [deploymentId],
    );
    expect(approval.rows.length).toBe(1);
    expect(approval.rows[0]?.gate).toBe("plan");
    expect(approval.rows[0]?.decision).toBe("approve");
    expect(approval.rows[0]?.note ?? "").toContain("auto-approved");
  });

  it("planning 아닌 상태에서 호출 시 AUTO_APPROVE_STATE_INVALID throw", async () => {
    const deploymentId = await createPlanningDeployment();
    await autoApprovePlanInline(pool, deploymentId); // 1차: planning → provisioning

    await expect(autoApprovePlanInline(pool, deploymentId)).rejects.toThrow(
      "AUTO_APPROVE_STATE_INVALID",
    );
  });

  it("동시 호출 시 FOR UPDATE 로 하나만 성공, 다른 하나는 AUTO_APPROVE_STATE_INVALID", async () => {
    const deploymentId = await createPlanningDeployment();

    const results = await Promise.allSettled([
      autoApprovePlanInline(pool, deploymentId),
      autoApprovePlanInline(pool, deploymentId),
    ]);
    const successes = results.filter((r) => r.status === "fulfilled");
    const failures = results.filter((r) => r.status === "rejected");
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    expect(
      (failures[0] as PromiseRejectedResult).reason?.message ?? "",
    ).toContain("AUTO_APPROVE_STATE_INVALID");

    const approvals = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM approvals WHERE deployment_id = $1",
      [deploymentId],
    );
    expect(approvals.rows[0]?.count).toBe("1");
  });
});
