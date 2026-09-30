/**
 * apps/api/tests/contracts.test.ts
 * API 응답이 @camellia/contracts 스키마와 정확히 맞는지 확인한다 (프론트 타입 안전성).
 * 실제 라우트를 server.inject 로 호출하고, 응답 바디를 계약 스키마로 parse 한다.
 * 계약의 응답 객체 스키마는 strict 라 필드가 빠지거나 더 있으면 실패한다.
 *
 * DB mock row 는 실제 pg 드라이버처럼 BIGINT 컬럼을 문자열로 돌려주는 경우도 넣었다
 * (환경 · 시크릿 · IR version). 계약은 지금 API 가 실제로 보내는 형태를 그대로 표현한다.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import FormData from "form-data";
import type { FastifyInstance } from "fastify";
import type { Pool } from "@camellia/db";
import type PgBoss from "pg-boss";
import type { Storage } from "@camellia/storage";
import type { ZodTypeAny } from "zod";
import {
  AiUsageSchema,
  AnalysisReportSchema,
  CreateDeploymentResponseSchema,
  DeploymentEventSchema,
  DeploymentHealthSchema,
  DeploymentSchema,
  DiagnosisSchema,
  EnvironmentListSchema,
  EnvironmentSchema,
  EnvVarListSchema,
  ErrorBodySchema,
  IrVersionSchema,
  ProjectDeploymentListSchema,
  ProjectListSchema,
  ProjectSchema,
  SecretListSchema,
  SecretSchema,
  SubmitApprovalResponseSchema,
  SubmitMissingResourcesResponseSchema,
} from "@camellia/contracts";
import { buildServer } from "../src/server.js";
import { MockPgBoss, MockPool, MockStorage } from "./mocks/db.js";

const NOW = new Date("2026-09-30T03:00:00.000Z");

const IR = {
  $ir_version: "0.1.0",
  metadata: { name: "test-app", version: "1.0.0" },
  services: {
    api: {
      type: "http",
      port: 3000,
      expose: "public",
      size: "small",
      health: { path: "/health", expected_status: 200, timeout_seconds: 3 },
    },
  },
  deploy: { profile: "aws-ecs-basic" },
};

let server: FastifyInstance;
let pool: MockPool;
let storage: MockStorage;

beforeEach(async () => {
  pool = new MockPool();
  storage = new MockStorage();
  server = await buildServer({
    pool: pool as unknown as Pool,
    boss: new MockPgBoss() as unknown as PgBoss,
    storage: storage as unknown as Storage,
    nodeEnv: "development",
    logger: false,
    enablePgListener: false,
  });
  await server.ready();
});

afterEach(async () => {
  await server.close();
  pool.reset();
  storage.reset();
});

/** 스키마 parse 결과를 이슈 경로와 함께 보여 주는 단언 */
function expectContract(schema: ZodTypeAny, body: unknown) {
  const result = schema.safeParse(body);
  const issues = result.success
    ? ""
    : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  expect(issues, "계약 불일치").toBe("");
}

async function call(method: string, url: string, payload?: unknown) {
  return server.inject({ method: method as "GET", url, payload: payload as object });
}

function projectRow(id: number, description: string | null = null) {
  return { id, name: `app-${id}`, description, created_at: NOW, updated_at: NOW };
}

function deploymentRow(status = "awaiting_target_confirmation") {
  return {
    id: 42,
    project_id: 1,
    status,
    target_profile: "aws-ecs-basic",
    public_url: null,
    created_at: NOW,
    updated_at: NOW,
    succeeded_at: null,
    failed_at: null,
    error: null,
  };
}

// ── projects ──────────────────────────────────────────────────────────────────

describe("projects 응답 계약", () => {
  it("POST /projects 201 — 설명 있음 · 없음(필드 생략)", async () => {
    pool.on(/INSERT INTO projects/, (params) => ({
      rows: [projectRow(1, (params[1] as string | null) ?? null)],
    }));

    const withDesc = await call("POST", "/api/v1/projects", { name: "app-1", description: "설명" });
    expect(withDesc.statusCode).toBe(201);
    expectContract(ProjectSchema, withDesc.json());

    const noDesc = await call("POST", "/api/v1/projects", { name: "app-1" });
    expect(noDesc.json()).not.toHaveProperty("description");
    expectContract(ProjectSchema, noDesc.json());
  });

  it("GET /projects — 목록 · nextCursor · total", async () => {
    pool.on(/FROM projects/, () => ({ rows: [projectRow(1), projectRow(2, "b")] }));

    const res = await call("GET", "/api/v1/projects?limit=1");

    expect(res.statusCode).toBe(200);
    expect(res.json().nextCursor).toBe("1");
    expectContract(ProjectListSchema, res.json());
  });

  it("GET /projects/:id", async () => {
    pool.on(/FROM projects WHERE id/, () => ({ rows: [projectRow(1, "설명")] }));

    const res = await call("GET", "/api/v1/projects/1");

    expect(res.statusCode).toBe(200);
    expectContract(ProjectSchema, res.json());
  });

  it("GET /projects/:id/deployments — sourceVersion 있음 · null", async () => {
    pool.on(/FROM projects WHERE id/, () => ({ rows: [{ id: 1 }] }));
    pool.on(/FROM deployments d/, () => ({
      rows: [
        {
          id: 2,
          status: "failed",
          target_profile: "onprem-docker-basic",
          public_url: null,
          created_at: NOW,
          succeeded_at: null,
          failed_at: NOW,
          source_version_id: null,
          source_sha256: null,
        },
        {
          id: 1,
          status: "succeeded",
          target_profile: "aws-ecs-basic",
          public_url: "https://app.example.com",
          created_at: NOW,
          succeeded_at: NOW,
          failed_at: null,
          source_version_id: 10,
          source_sha256: "abc",
        },
      ],
    }));

    const res = await call("GET", "/api/v1/projects/1/deployments");

    expect(res.statusCode).toBe(200);
    expectContract(ProjectDeploymentListSchema, res.json());
  });

  it("GET · PATCH /projects/:id/env", async () => {
    pool.on(/FROM projects WHERE id/, () => ({ rows: [{}] }));
    pool.on(/FROM env_vars/, () => ({
      rows: [{ name: "NODE_ENV", value: "production", updated_at: NOW }],
    }));

    const get = await call("GET", "/api/v1/projects/1/env");
    expect(get.statusCode).toBe(200);
    expectContract(EnvVarListSchema, get.json());

    const patch = await call("PATCH", "/api/v1/projects/1/env", { vars: { NODE_ENV: "production" } });
    expect(patch.statusCode).toBe(200);
    expectContract(EnvVarListSchema, patch.json());
  });
});

// ── deployments ───────────────────────────────────────────────────────────────

describe("deployments 응답 계약", () => {
  it("POST /deployments 202 (multipart)", async () => {
    pool.on(/INSERT INTO deployments/, () => ({ rows: [{ id: 42 }] }));
    pool.on(/INSERT INTO source_versions/, () => ({ rows: [{ id: 1 }] }));

    const form = new FormData();
    form.append("project_id", "1");
    form.append("target", "aws");
    form.append("source", Buffer.from("PK fake zip"), { filename: "app.zip", contentType: "application/zip" });

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/deployments",
      headers: form.getHeaders(),
      payload: form.getBuffer(),
    });

    expect(res.statusCode).toBe(202);
    expectContract(CreateDeploymentResponseSchema, res.json());
  });

  it("GET /deployments/:id — 실행 중 단계 · 대기 승인 있음", async () => {
    pool.on(/SELECT id, project_id, status, target_profile, public_url/, () => ({
      rows: [deploymentRow()],
    }));
    pool.on(/FROM deployment_steps/, () => ({
      rows: [{ step_name: "analyze", status: "running", started_at: NOW, finished_at: null }],
    }));
    pool.on(/FROM approvals/, () => ({ rows: [{ gate: "target", decision: null, created_at: NOW }] }));

    const res = await call("GET", "/api/v1/deployments/42");

    expect(res.statusCode).toBe(200);
    expect(res.json().currentStep.name).toBe("analyze");
    expectContract(DeploymentSchema, res.json());
  });

  it("GET /deployments/:id — 실행 중 단계 · 대기 승인 없음", async () => {
    pool.on(/SELECT id, project_id, status, target_profile, public_url/, () => ({
      rows: [{ ...deploymentRow("succeeded"), public_url: "https://app.example.com", succeeded_at: NOW }],
    }));

    const res = await call("GET", "/api/v1/deployments/42");

    expect(res.json().currentStep).toEqual({ name: null, startedAt: null });
    expect(res.json().approvalPending).toBeNull();
    expectContract(DeploymentSchema, res.json());
  });

  it("GET /deployments/:id/ir — version 숫자 · 문자열(실제 pg BIGINT)", async () => {
    const row = { id: 1, deployment_id: 42, ir_json: IR, source: "analyzer", created_at: NOW };
    pool.on(/FROM ir_versions/, () => ({ rows: [{ ...row, version_num: 1 }] }));

    const res = await call("GET", "/api/v1/deployments/42/ir");
    expect(res.statusCode).toBe(200);
    expectContract(IrVersionSchema, res.json());

    pool.reset();
    pool.on(/FROM ir_versions/, () => ({ rows: [{ ...row, version_num: "1" }] }));
    const asString = await call("GET", "/api/v1/deployments/42/ir");
    expect(asString.json().version).toBe("1");
    expectContract(IrVersionSchema, asString.json());
  });

  it("PATCH /deployments/:id/ir + SSE ir_updated", async () => {
    const events = collectEvents("42");
    pool.on(/SELECT status FROM deployments/, () => ({ rows: [{ status: "awaiting_target_confirmation" }] }));
    pool.on(/INSERT INTO ir_versions/, () => ({
      rows: [{ id: 2, deployment_id: 42, ir_json: IR, source: "user_edited", created_at: NOW }],
    }));
    pool.on(/FROM ir_versions/, () => ({ rows: [{ id: 1, ir_json: IR, row_num: 1 }] }));

    const res = await call("PATCH", "/api/v1/deployments/42/ir", {
      version: 1,
      ir: { metadata: { name: "renamed" } },
    });

    expect(res.statusCode).toBe(200);
    expectContract(IrVersionSchema, res.json());
    expectEvents(events, ["ir_updated"]);
  });

  it("POST /deployments/:id/missing-resources + SSE missing_resources_updated", async () => {
    const events = collectEvents("42");
    pool.on(/SELECT status FROM deployments/, () => ({ rows: [{ status: "awaiting_target_confirmation" }] }));
    pool.on(/FROM ir_versions/, () => ({ rows: [{ id: 1, ir_json: IR }] }));

    const res = await call("POST", "/api/v1/deployments/42/missing-resources", {
      decisions: [{ resource: "cache", action: "exclude" }],
    });

    expect(res.statusCode).toBe(200);
    expectContract(SubmitMissingResourcesResponseSchema, res.json());
    expectEvents(events, ["missing_resources_updated"]);
  });

  it("POST /deployments/:id/approvals — target 승인 · plan 승인(lockAcquired 생략) · 거절 + SSE state_changed", async () => {
    const events = collectEvents("42");
    let status = "awaiting_target_confirmation";
    pool.on(/FROM deployments WHERE id/, () => ({
      rows: [{ id: 42, status, project_id: 1, target_profile: "aws-ecs-basic" }],
    }));
    pool.on(/FROM projects WHERE id/, () => ({ rows: [{ name: "app-1" }] }));

    const target = await call("POST", "/api/v1/deployments/42/approvals", { gate: "target", decision: "approve" });
    expect(target.statusCode).toBe(200);
    expect(target.json().lockAcquired).toBe(true);
    expectContract(SubmitApprovalResponseSchema, target.json());

    status = "awaiting_plan_approval";
    const plan = await call("POST", "/api/v1/deployments/42/approvals", { gate: "plan", decision: "approve" });
    expect(plan.json()).not.toHaveProperty("lockAcquired");
    expectContract(SubmitApprovalResponseSchema, plan.json());

    const reject = await call("POST", "/api/v1/deployments/42/approvals", {
      gate: "plan",
      decision: "reject",
      note: "비용 초과",
    });
    expect(reject.json().newStatus).toBe("failed");
    expectContract(SubmitApprovalResponseSchema, reject.json());

    expectEvents(events, ["state_changed", "state_changed", "state_changed"]);
  });

  it("GET /deployments/:id/analysis-report", async () => {
    pool.on(/FROM analysis_reports/, () => ({
      rows: [
        {
          services_json: [{ name: "api", language: "node" }],
          resources_json: [{ type: "postgres" }],
          warnings_json: [],
          unresolved_json: [],
          ir_valid: true,
          ir_errors_json: null,
          created_at: NOW,
        },
      ],
    }));

    const res = await call("GET", "/api/v1/deployments/42/analysis-report");

    expect(res.statusCode).toBe(200);
    expectContract(AnalysisReportSchema, res.json());
  });

  it("GET /deployments/:id/logs — 200 text/plain · 없으면 204 빈 바디", async () => {
    pool.on(/SELECT 1 FROM deployments/, () => ({ rows: [{}] }));
    await storage.put("logs/deployments/42/build.log", Buffer.from("[t] a\n[t] b\n"));

    const ok = await call("GET", "/api/v1/deployments/42/logs?step=build");
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toContain("text/plain");
    expect(ok.body).toBe("[t] a\n[t] b");

    const none = await call("GET", "/api/v1/deployments/42/logs?step=verify");
    expect(none.statusCode).toBe(204);
    expect(none.body).toBe("");
  });

  it("GET /deployments/:id/health — 선택 필드 있음 · 없음", async () => {
    pool.on(/FROM deployments/, () => ({ rows: [{ id: 42, status: "verifying", public_url: "https://example.com" }] }));
    pool.on(/FROM deployment_steps/, () => ({ rows: [{ id: 10, status: "running", message: null }] }));
    pool.on(/FROM health_check_attempts/, () => ({
      rows: [
        { attempt: 1, checked_at: NOW, status_code: null, latency_ms: 3000, passed: false, error_code: "TIMEOUT", error_message: null },
        { attempt: 2, checked_at: NOW, status_code: 200, latency_ms: 40, passed: true, error_code: null, error_message: null },
      ],
    }));

    const res = await call("GET", "/api/v1/deployments/42/health");

    expect(res.statusCode).toBe(200);
    expectContract(DeploymentHealthSchema, res.json());
  });

  it("GET /deployments/:id/diagnosis", async () => {
    pool.on(/SELECT diagnosis_json FROM deployments/, () => ({
      rows: [
        {
          diagnosis_json: {
            failedStep: "build",
            summary: "의존성 설치 실패",
            patchCandidates: [{ description: "lockfile 추가", diff: "--- a\n+++ b" }],
            generatedAt: NOW.toISOString(),
          },
        },
      ],
    }));

    const res = await call("GET", "/api/v1/deployments/42/diagnosis");

    expect(res.statusCode).toBe(200);
    expectContract(DiagnosisSchema, res.json());
  });

  it("GET /deployments/:id/ai-usage", async () => {
    pool.on(/SELECT 1 FROM deployments/, () => ({ rows: [{}] }));
    pool.on(/FROM ai_usage/, () => ({
      rows: [{ model: "claude-sonnet", token_in: "1200", token_out: "300", cost_usd: "0.0081" }],
    }));

    const res = await call("GET", "/api/v1/deployments/42/ai-usage");

    expect(res.statusCode).toBe(200);
    expectContract(AiUsageSchema, res.json());
  });
});

// ── secrets · environments ────────────────────────────────────────────────────

describe("secrets 응답 계약", () => {
  it("POST 201 · GET 목록(project_id 문자열 — 실제 pg BIGINT) · DELETE 204", async () => {
    pool.on(/SELECT 1 FROM projects/, () => ({ rows: [{}] }));
    pool.on(/INSERT INTO secrets/, () => ({ rows: [{ created_at: NOW }] }));
    pool.on(/FROM secrets/, () => ({ rows: [{ name: "aws-key", project_id: "1", created_at: NOW }] }));

    const created = await call("POST", "/api/v1/secrets", { projectId: 1, name: "aws-key", value: "v" });
    expect(created.statusCode).toBe(201);
    expectContract(SecretSchema, created.json());

    const list = await call("GET", "/api/v1/secrets?projectId=1");
    expect(list.statusCode).toBe(200);
    expectContract(SecretListSchema, list.json());

    const del = await call("DELETE", "/api/v1/secrets/aws-key?projectId=1");
    expect(del.statusCode).toBe(204);
    expect(del.body).toBe("");
  });
});

describe("environments 응답 계약", () => {
  const envRow = {
    id: "10",
    project_id: "1",
    name: "onprem-mac",
    type: "onprem",
    aws_config: null,
    onprem_config: { agentRegistrationToken: "tok", hostname: "mac.local" },
    agent_status: null,
    last_seen_at: null,
    created_at: NOW,
  };

  it("POST 201 (onprem) · GET 목록 · GET 단건 · DELETE 204", async () => {
    pool.on(/SELECT 1 FROM projects/, () => ({ rows: [{}] }));
    pool.on(/INSERT INTO environments/, () => ({ rows: [{ id: "10", created_at: NOW }] }));
    pool.on(/FROM environments/, () => ({ rows: [envRow] }));

    const created = await call("POST", "/api/v1/environments", {
      projectId: 1,
      name: "onprem-mac",
      type: "onprem",
      onpremConfig: { agentRegistrationToken: "tok", hostname: "mac.local" },
    });
    expect(created.statusCode).toBe(201);
    expectContract(EnvironmentSchema, created.json());

    const list = await call("GET", "/api/v1/environments?projectId=1");
    expect(list.statusCode).toBe(200);
    expectContract(EnvironmentListSchema, list.json());

    const one = await call("GET", "/api/v1/environments/10");
    expect(one.statusCode).toBe(200);
    expectContract(EnvironmentSchema, one.json());

    const del = await call("DELETE", "/api/v1/environments/10");
    expect(del.statusCode).toBe(204);
    expect(del.body).toBe("");
  });

  it("GET 단건 (aws, lastSeenAt 있음)", async () => {
    pool.on(/FROM environments/, () => ({
      rows: [
        {
          ...envRow,
          type: "aws",
          onprem_config: null,
          aws_config: { credentialsType: "assume_role", roleArn: "arn:aws:iam::1:role/x", externalId: "e", region: "ap-northeast-2" },
          agent_status: "online",
          last_seen_at: NOW,
        },
      ],
    }));

    const res = await call("GET", "/api/v1/environments/10");

    expectContract(EnvironmentSchema, res.json());
  });
});

// ── errors ────────────────────────────────────────────────────────────────────

describe("에러 바디 계약", () => {
  it("400 VALIDATION_ERROR · 404 NOT_FOUND (hint 있음 · 없음)", async () => {
    const invalid = await call("POST", "/api/v1/projects", { name: "" });
    expect(invalid.statusCode).toBe(400);
    expectContract(ErrorBodySchema, invalid.json());

    const notFound = await call("GET", "/api/v1/projects/99");
    expect(notFound.statusCode).toBe(404);
    expectContract(ErrorBodySchema, notFound.json());

    const noHint = await call("GET", "/api/v1/deployments/99/diagnosis");
    expect(noHint.statusCode).toBe(404);
    expect(noHint.json().error).not.toHaveProperty("hint");
    expectContract(ErrorBodySchema, noHint.json());
  });
});

// ── SSE ───────────────────────────────────────────────────────────────────────

/** 라우트가 sseBroker 로 발행하는 이벤트를 모은다 (GET /events 로 그대로 나가는 { event, data }). */
function collectEvents(deploymentId: string) {
  const events: Array<{ event: string; data: unknown }> = [];
  server.sseBroker.subscribe(deploymentId, (e) => events.push({ event: e.event, data: e.data }));
  return events;
}

function expectEvents(events: Array<{ event: string; data: unknown }>, names: string[]) {
  expect(events.map((e) => e.event)).toEqual(names);
  for (const e of events) {
    // 와이어에서는 data 가 JSON 문자열 — undefined 필드가 빠진 모습으로 검증
    expectContract(DeploymentEventSchema, { event: e.event, data: JSON.parse(JSON.stringify(e.data)) });
  }
}
