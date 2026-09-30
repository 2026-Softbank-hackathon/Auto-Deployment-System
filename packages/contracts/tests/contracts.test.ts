/**
 * packages/contracts/tests/contracts.test.ts
 * 계약 스키마 자체의 규칙 — 응답은 strict, 요청은 기존 검증 규칙 그대로, SSE 는 이벤트 이름으로 구분.
 * 실제 API 응답과의 일치는 apps/api/tests/contracts.test.ts 가 확인한다.
 */

import { describe, expect, it } from "vitest";
import {
  DEPLOYMENT_EVENT_NAMES,
  DeploymentEventSchema,
  DeploymentSchema,
  ErrorBodySchema,
  ListProjectDeploymentsQuerySchema,
  PatchProjectEnvBodySchema,
  ProjectSchema,
  TARGET_VENDORS,
  TargetVendorSchema,
  type DeploymentEventData,
} from "../src/index.js";

const project = {
  id: "1",
  name: "todo-app",
  createdAt: "2026-09-30T03:00:00.000Z",
  updatedAt: "2026-09-30T03:00:00.000Z",
};

describe("TARGET_VENDORS", () => {
  it("aws 와 onprem 두 벤더만 포함함", () => {
    expect([...TARGET_VENDORS].sort()).toEqual(["aws", "onprem"]);
  });

  it("TargetVendorSchema — aws/onprem 허용, profile ID 거부", () => {
    expect(TargetVendorSchema.safeParse("aws").success).toBe(true);
    expect(TargetVendorSchema.safeParse("onprem").success).toBe(true);
    expect(TargetVendorSchema.safeParse("aws-ecs-basic").success).toBe(false);
    expect(TargetVendorSchema.safeParse("onprem-docker-basic").success).toBe(false);
    expect(TargetVendorSchema.safeParse("").success).toBe(false);
  });
});

describe("응답 스키마", () => {
  it("선언 안 된 필드 · 빠진 필드를 거부함 (strict)", () => {
    expect(ProjectSchema.safeParse(project).success).toBe(true);
    expect(ProjectSchema.safeParse({ ...project, extra: 1 }).success).toBe(false);
    const { name: _name, ...missing } = project;
    expect(ProjectSchema.safeParse(missing).success).toBe(false);
  });

  it("중첩 객체도 strict — currentStep 은 두 형태 중 하나", () => {
    const base = {
      id: "42",
      projectId: "1",
      status: "analyzing",
      targetProfile: "aws-ecs-basic",
      publicUrl: null,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      succeededAt: null,
      failedAt: null,
      error: null,
      approvalPending: null,
    };
    expect(DeploymentSchema.safeParse({ ...base, currentStep: { name: null, startedAt: null } }).success).toBe(true);
    expect(
      DeploymentSchema.safeParse({
        ...base,
        currentStep: { name: "analyze", startedAt: project.createdAt, finishedAt: null },
      }).success,
    ).toBe(true);
    expect(
      DeploymentSchema.safeParse({ ...base, currentStep: { name: null, startedAt: null, extra: 1 } }).success,
    ).toBe(false);
    expect(DeploymentSchema.safeParse({ ...base, status: "unknown", currentStep: { name: null, startedAt: null } }).success).toBe(false);
  });

  it("에러 바디 — hint 는 선택", () => {
    expect(ErrorBodySchema.safeParse({ error: { code: "NOT_FOUND", message: "없음" }, requestId: "req_1" }).success).toBe(true);
    expect(ErrorBodySchema.safeParse({ error: { code: "NOT_FOUND" }, requestId: "req_1" }).success).toBe(false);
  });
});

describe("요청 스키마 (기존 라우트 검증 규칙)", () => {
  it("배포 이력 쿼리 — limit 기본 20, cursor 는 숫자 문자열 → number", () => {
    expect(ListProjectDeploymentsQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(ListProjectDeploymentsQuerySchema.parse({ cursor: "5", limit: "2" })).toEqual({ cursor: 5, limit: 2 });
    expect(ListProjectDeploymentsQuerySchema.safeParse({ cursor: "abc" }).success).toBe(false);
  });

  it("환경변수 PATCH — 이름 규칙 · null 은 삭제", () => {
    expect(PatchProjectEnvBodySchema.safeParse({ vars: { NODE_ENV: "production", OLD: null } }).success).toBe(true);
    expect(PatchProjectEnvBodySchema.safeParse({ vars: { "1BAD": "x" } }).success).toBe(false);
    expect(PatchProjectEnvBodySchema.safeParse({ vars: {} }).success).toBe(false);
  });
});

describe("SSE 이벤트", () => {
  it("이벤트 이름으로 페이로드 형태를 구분함", () => {
    const logLine: DeploymentEventData<"log.line"> = { step: "build", line: "[t] 시작" };
    expect(DeploymentEventSchema.safeParse({ event: "log.line", data: logLine }).success).toBe(true);
    expect(DeploymentEventSchema.safeParse({ event: "log.line", data: { gate: "target" } }).success).toBe(false);
    expect(DeploymentEventSchema.safeParse({ event: "unknown", data: {} }).success).toBe(false);
  });

  it("state_changed — 워커 형태 { status } 와 API 형태 { deploymentId, from, to, reason? } 둘 다", () => {
    expect(DeploymentEventSchema.safeParse({ event: "state_changed", data: { status: "analyzing" } }).success).toBe(true);
    expect(
      DeploymentEventSchema.safeParse({
        event: "state_changed",
        data: { deploymentId: "42", from: "awaiting_plan_approval", to: "failed", reason: "거절" },
      }).success,
    ).toBe(true);
  });

  it("이벤트 이름 목록", () => {
    expect([...DEPLOYMENT_EVENT_NAMES].sort()).toEqual(
      [
        "analysis.progress",
        "approval_requested",
        "ir_updated",
        "log.line",
        "missing_resources_updated",
        "state_changed",
      ].sort(),
    );
  });
});
