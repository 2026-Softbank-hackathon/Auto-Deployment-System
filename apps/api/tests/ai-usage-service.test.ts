/**
 * apps/api/tests/ai-usage-service.test.ts
 * AiUsageService.aggregate 유닛 테스트 (mock pool).
 */

import { describe, it, expect, vi } from "vitest";
import type { Pool } from "@camellia/db";
import { AiUsageService } from "../src/services/ai-usage-service.js";

type Row = Record<string, unknown>;

/** 순차 호출마다 지정된 rows 배열을 반환하는 mock pool. */
function mockPool(responses: Row[][]): Pool {
  let call = 0;
  const query = vi.fn(async () => {
    const rows = responses[call++] ?? [];
    return { rows, rowCount: rows.length };
  });
  return { query } as unknown as Pool;
}

describe("AiUsageService.aggregate", () => {
  it("배포가 없으면 404 를 던진다", async () => {
    const pool = mockPool([[]]);
    const svc = new AiUsageService(pool);
    await expect(svc.aggregate(1)).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    });
  });

  it("사용 기록이 없어도 200 + 전부 0 을 반환한다", async () => {
    const pool = mockPool([[{ "?column?": 1 }], []]);
    const svc = new AiUsageService(pool);
    const r = await svc.aggregate(1);
    expect(r.deploymentId).toBe(1);
    expect(r.totalTokenIn).toBe(0);
    expect(r.totalTokenOut).toBe(0);
    expect(r.totalCostUsd).toBe(0);
    expect(r.breakdown).toEqual([]);
  });

  it("다중 모델 사용 시 합계 · breakdown 을 반환한다", async () => {
    const pool = mockPool([
      [{ "?column?": 1 }],
      [
        {
          model: "claude-opus-4-7",
          token_in: "2000",
          token_out: "1000",
          cost_usd: "0.050000",
        },
        {
          model: "claude-sonnet-4-6",
          token_in: "1000",
          token_out: "500",
          cost_usd: "0.010000",
        },
      ],
    ]);
    const svc = new AiUsageService(pool);
    const r = await svc.aggregate(42);
    expect(r.deploymentId).toBe(42);
    expect(r.totalTokenIn).toBe(3000);
    expect(r.totalTokenOut).toBe(1500);
    expect(r.totalCostUsd).toBeCloseTo(0.06, 5);
    expect(r.breakdown).toHaveLength(2);
    expect(r.breakdown[0]?.model).toBe("claude-opus-4-7");
  });
});
