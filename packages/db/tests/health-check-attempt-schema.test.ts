import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as databaseSchemas from "../src/schema.js";

function getHealthCheckAttemptSchema(): z.ZodType {
  const schema = Reflect.get(databaseSchemas, "HealthCheckAttemptSchema");
  expect(schema).toBeDefined();
  return schema as z.ZodType;
}

function validAttempt() {
  return {
    id: 1,
    deployment_step_id: 10,
    environment_id: "env-aws-1",
    phase: "target",
    attempt: 1,
    checked_at: new Date("2026-09-30T03:20:00.000Z"),
    status_code: 200,
    latency_ms: 45,
    passed: true,
    error_code: null,
    error_message: null,
  };
}

describe("HealthCheckAttemptSchema", () => {
  it("성공한 헬스체크 시도 row를 파싱함", () => {
    const result = getHealthCheckAttemptSchema().safeParse(validAttempt());
    expect(result.success).toBe(true);
  });

  it("응답을 받지 못한 실패 시도에서 status와 latency null을 허용함", () => {
    const result = getHealthCheckAttemptSchema().safeParse({
      ...validAttempt(),
      status_code: null,
      latency_ms: null,
      passed: false,
      error_code: "TIMEOUT",
      error_message: "health check timed out",
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ["0 이하 시도 번호", { attempt: 0 }],
    ["HTTP 범위를 벗어난 상태 코드", { status_code: 600 }],
    ["음수 지연 시간", { latency_ms: -1 }],
    ["빈 환경 ID", { environment_id: "" }],
    ["알 수 없는 검증 phase", { phase: "unknown" }],
  ])("%s를 거부함", (_name, invalidValues) => {
    const result = getHealthCheckAttemptSchema().safeParse({
      ...validAttempt(),
      ...invalidValues,
    });
    expect(result.success).toBe(false);
  });
});
