/**
 * packages/contracts/tests/contracts.test.ts
 * 계약 스키마 자체의 규칙 — 응답은 strict, 요청은 기존 검증 규칙 그대로, SSE 는 이벤트 이름으로 구분.
 * 실제 API 응답과의 일치는 apps/api/tests/contracts.test.ts 가 확인한다.
 */

import { describe, expect, it } from "vitest";
import {
  CreateEnvironmentBodySchema,
  CreateSecretBodySchema,
  DeleteProjectResponseSchema,
  DEPLOYMENT_EVENT_NAMES,
  DeploymentEventSchema,
  DeploymentSchema,
  EnvironmentSchema,
  ErrorBodySchema,
  ListProjectDeploymentsQuerySchema,
  OptionalProjectIdQuerySchema,
  PatchProjectEnvBodySchema,
  ProjectDeploymentSchema,
  ProjectSchema,
  SecretSchema,
  TARGET_VENDORS,
  TargetVendorSchema,
  UpdateEnvironmentBodySchema,
  type DeploymentEventData,
} from "../src/index.js";

const project = {
  id: "1",
  name: "todo-app",
  createdAt: "2026-09-30T03:00:00.000Z",
  updatedAt: "2026-09-30T03:00:00.000Z",
  live: null,
  latest: null,
  deletion: null,
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
  it("Project.live · latest — 서비스 중인 배포와 최근 배포 요약", () => {
    const withDeployments = {
      ...project,
      live: {
        deploymentId: "7",
        environmentId: "3",
        environmentType: "onprem",
        environmentName: "home-mac",
        publicUrl: "https://service-1.example.com",
        succeededAt: "2026-09-30T03:10:00.000Z",
      },
      latest: {
        deploymentId: "8",
        status: "building",
        environmentType: "aws",
        createdAt: "2026-09-30T03:20:00.000Z",
      },
    };
    expect(ProjectSchema.safeParse(withDeployments).success).toBe(true);
    // 환경이 없는 옛 배포 — 환경 필드 null
    const legacy = {
      ...withDeployments,
      live: { ...withDeployments.live, environmentId: null, environmentType: null, environmentName: null, publicUrl: null },
      latest: { ...withDeployments.latest, environmentType: null },
    };
    expect(ProjectSchema.safeParse(legacy).success).toBe(true);
    expect(ProjectSchema.safeParse({ ...withDeployments, live: { ...withDeployments.live, extra: 1 } }).success).toBe(false);
    expect(ProjectSchema.safeParse({ ...withDeployments, latest: { ...withDeployments.latest, environmentType: "gcp" } }).success).toBe(false);
    const { live: _live, ...noLive } = withDeployments;
    expect(ProjectSchema.safeParse(noLive).success).toBe(false);
  });

  it("ProjectDeployment — 환경 정보와 isLive", () => {
    const item = {
      id: "7",
      status: "succeeded",
      targetProfile: "onprem-docker-basic",
      publicUrl: null,
      sourceVersion: null,
      createdAt: "2026-09-30T03:00:00.000Z",
      succeededAt: "2026-09-30T03:10:00.000Z",
      failedAt: null,
      environmentId: "3",
      environmentType: "onprem",
      environmentName: "home-mac",
      isLive: true,
    };
    expect(ProjectDeploymentSchema.safeParse(item).success).toBe(true);
    expect(
      ProjectDeploymentSchema.safeParse({ ...item, environmentId: null, environmentType: null, environmentName: null, isLive: false }).success,
    ).toBe(true);
    const { isLive: _isLive, ...noIsLive } = item;
    expect(ProjectDeploymentSchema.safeParse(noIsLive).success).toBe(false);
  });

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
      targetEnvironmentId: "10",
      registryEnvironmentId: "10",
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

describe("공용 연결 (#215)", () => {
  const environment = {
    id: "10",
    projectId: null,
    shared: true,
    name: "my-mac",
    type: "onprem",
    isDefault: true,
    onpremConfig: { hostname: "mac.local" },
    agentStatus: null,
    lastSeenAt: null,
    agentOnline: true,
    agentLastSeenAt: "2026-09-30T03:00:00.000Z",
    createdAt: "2026-09-30T03:00:00.000Z",
  };

  it("Environment — 공용 연결은 projectId=null · shared=true, Agent 상태 필드가 있어야 함", () => {
    expect(EnvironmentSchema.safeParse(environment).success).toBe(true);
    expect(EnvironmentSchema.safeParse({ ...environment, projectId: "1", shared: false }).success).toBe(true);
    const { agentOnline: _online, ...missingOnline } = environment;
    expect(EnvironmentSchema.safeParse(missingOnline).success).toBe(false);
    const { shared: _shared, ...missingShared } = environment;
    expect(EnvironmentSchema.safeParse(missingShared).success).toBe(false);
  });

  it("Secret — 공용 시크릿은 projectId=null · shared=true", () => {
    const secret = { name: "aws-key", projectId: null, shared: true, createdAt: "2026-09-30T03:00:00.000Z" };
    expect(SecretSchema.safeParse(secret).success).toBe(true);
    const { shared: _shared, ...missing } = secret;
    expect(SecretSchema.safeParse(missing).success).toBe(false);
  });

  it("요청 — 환경 · 시크릿 생성과 목록 쿼리에서 projectId 생략 가능", () => {
    expect(
      CreateEnvironmentBodySchema.safeParse({
        name: "aws",
        type: "aws",
        awsConfig: { credentialsType: "access_key", region: "ap-northeast-2" },
      }).success,
    ).toBe(true);
    expect(CreateSecretBodySchema.safeParse({ name: "aws-key", value: "v" }).success).toBe(true);
    expect(OptionalProjectIdQuerySchema.parse({})).toEqual({});
    expect(OptionalProjectIdQuerySchema.parse({ projectId: "3" })).toEqual({ projectId: 3 });
    expect(OptionalProjectIdQuerySchema.safeParse({ projectId: "0" }).success).toBe(false);
  });

  it("요청 — PATCH /environments/:id 는 isDefault: true 만 받는다 (#228)", () => {
    expect(UpdateEnvironmentBodySchema.parse({ isDefault: true })).toEqual({ isDefault: true });
    expect(UpdateEnvironmentBodySchema.safeParse({ isDefault: false }).success).toBe(false);
    expect(UpdateEnvironmentBodySchema.safeParse({}).success).toBe(false);
    expect(UpdateEnvironmentBodySchema.safeParse({ isDefault: true, name: "x" }).success).toBe(false);
  });
});

describe("앱 삭제 (#247)", () => {
  const deletion = {
    status: "deleting",
    requestedAt: "2026-10-02T03:00:00.000Z",
    error: null,
    warnings: [],
  };

  it("Project.deletion — 삭제 중 · 실패(이유) · 없음(null), 빠지면 거부", () => {
    expect(ProjectSchema.safeParse({ ...project, deletion }).success).toBe(true);
    expect(
      ProjectSchema.safeParse({
        ...project,
        deletion: { ...deletion, status: "failed", error: "TERRAFORM_DESTROY_FAILED", warnings: ["ONPREM_MANUAL_CLEANUP"] },
      }).success,
    ).toBe(true);
    expect(ProjectSchema.safeParse({ ...project, deletion: { ...deletion, status: "deleted" } }).success).toBe(false);
    expect(ProjectSchema.safeParse({ ...project, deletion: { ...deletion, warnings: ["UNKNOWN"] } }).success).toBe(false);
    expect(ProjectSchema.safeParse({ ...project, deletion: { ...deletion, extra: 1 } }).success).toBe(false);
    const { deletion: _deletion, ...missing } = project;
    expect(ProjectSchema.safeParse(missing).success).toBe(false);
  });

  it("DELETE /projects/:id 202 응답 — projectId + deletion", () => {
    expect(DeleteProjectResponseSchema.safeParse({ projectId: "24", deletion }).success).toBe(true);
    expect(DeleteProjectResponseSchema.safeParse({ projectId: "24", deletion: null }).success).toBe(false);
    expect(DeleteProjectResponseSchema.safeParse({ projectId: "24", deletion, extra: 1 }).success).toBe(false);
  });
});
