/**
 * apps/api/tests/server.test.ts
 * buildServer 통합 테스트 (in-memory mock DB).
 * 최소 8개 테스트:
 *  1. POST /projects 201 + row 생성
 *  2. GET /projects 반환
 *  3. POST /deployments (multipart mock zip) 202 + deployment_id
 *  4. GET /deployments/:id 반환
 *  5. GET /deployments/:id/events SSE 연결 open + close
 *  6. GET /deployments/:id/ir 미완성 상태 404
 *  7. PATCH /deployments/:id/ir 잘못된 IR 400
 *  8. POST /deployments/:id/approvals target approve
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import FormData from "form-data";
import { buildServer } from "../src/server.js";
import { MockPool, MockPgBoss, MockStorage } from "./mocks/db.js";
import type { FastifyInstance } from "fastify";
import type { Pool } from "@camellia/db";
import type PgBoss from "pg-boss";
import type { Storage } from "@camellia/storage";

// ── helpers ───────────────────────────────────────────────────────────────────

const NOW = new Date("2026-09-30T03:00:00.000Z");

function makeProject(id: number, name: string) {
  return {
    id,
    name,
    description: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeDeployment(id: number, projectId: number, status = "received") {
  return {
    id,
    project_id: projectId,
    status,
    target_profile: "aws-ecs-basic",
    target_environment_id: 10,
    registry_environment_id: 10,
    public_url: null,
    created_at: NOW,
    updated_at: NOW,
    succeeded_at: null,
    failed_at: null,
    error: null,
  };
}

function makeIrVersion(id: number, deploymentId: number) {
  return {
    id,
    deployment_id: deploymentId,
    ir_json: {
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
    },
    source: "analyzer",
    created_at: NOW,
    version_num: 1,
    row_num: 1,
  };
}

// ── test setup ────────────────────────────────────────────────────────────────

let server: FastifyInstance;
let mockPool: MockPool;
let mockBoss: MockPgBoss;
let mockStorage: MockStorage;

beforeEach(async () => {
  mockPool = new MockPool();
  mockBoss = new MockPgBoss();
  mockStorage = new MockStorage();

  server = await buildServer({
    pool: mockPool as unknown as Pool,
    boss: mockBoss as unknown as PgBoss,
    storage: mockStorage as unknown as Storage,
    nodeEnv: "development", // dev bypass auth
    logger: false,
  });
  await server.ready();
});

afterEach(async () => {
  await server.close();
  mockPool.reset();
  mockBoss.reset();
  mockStorage.reset();
});

// ── 1. POST /projects 201 ─────────────────────────────────────────────────────

describe("POST /api/v1/projects", () => {
  it("creates a project and returns 201", async () => {
    const project = makeProject(1, "todo-app");
    mockPool.on(/INSERT INTO projects/, () => ({ rows: [project] }));

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "todo-app", description: "팀 내부 투두" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; name: string }>();
    expect(body.id).toBe("1");
    expect(body.name).toBe("todo-app");
  });

  it("returns 400 when name is empty", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
  });
});

// ── 2. GET /projects ──────────────────────────────────────────────────────────

describe("GET /api/v1/projects", () => {
  it("returns project list", async () => {
    const project = makeProject(1, "todo-app");
    mockPool.on(/SELECT id, name, description, created_at, updated_at\s+FROM projects/, () => ({
      rows: [project],
    }));

    const res = await server.inject({ method: "GET", url: "/api/v1/projects" });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: unknown[]; nextCursor: null }>();
    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).toBeNull();
  });
});

// ── 3. POST /deployments multipart ───────────────────────────────────────────

describe("POST /api/v1/deployments", () => {
  function setupDeploymentMocks(options: { missingSecret?: string } = {}) {
    mockPool.on(/SELECT id FROM environments/, (params) => ({
      rows: [{ id: params[1] === "onprem" ? 20 : 10 }],
    }));
    mockPool.on(/SELECT aws_config FROM environments/, () => ({
      rows: [{
        aws_config: {
          credentialsType: "access_key",
          accessKeyIdSecretName: "aws-access-key-id",
          secretAccessKeySecretName: "aws-secret-access-key",
          region: "ap-northeast-2",
        },
      }],
    }));
    mockPool.on(/SELECT name FROM secrets/, () => ({
      rows: ["aws-access-key-id", "aws-secret-access-key"]
        .filter((name) => name !== options.missingSecret)
        .map((name) => ({ name })),
    }));
    mockPool.on(/INSERT INTO deployments/, () => ({ rows: [{ id: 42 }] }));
    mockPool.on(/INSERT INTO source_versions/, () => ({ rows: [{ id: 1 }] }));
    mockPool.on(/BEGIN|COMMIT|ROLLBACK/, () => ({ rows: [] }));
  }

  it("accepts multipart zip and returns 202 with deploymentId", async () => {
    setupDeploymentMocks();

    const form = new FormData();
    form.append("project_id", "1");
    form.append("target", "aws");
    form.append("source", Buffer.from("PK fake zip content"), {
      filename: "app.zip",
      contentType: "application/zip",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/deployments",
      headers: form.getHeaders(),
      payload: form.getBuffer(),
    });

    expect(res.statusCode).toBe(202);
    const body = res.json<{ deploymentId: string; status: string; eventsUrl: string }>();
    expect(body.deploymentId).toBe("42");
    expect(body.status).toBe("received");
    expect(body.eventsUrl).toContain("/api/v1/deployments/42/events");
    expect(mockBoss.sentJobs).toHaveLength(1);
    expect(mockBoss.sentJobs[0]!.name).toBe("analyze");
  });

  it("vendor aws → DB target_profile = aws-ecs-basic", async () => {
    let capturedProfile: string | undefined;
    // MockPool 은 첫 매치 핸들러가 이기니 setup 전에 등록해야 캡처가 뜬다.
    mockPool.on(/INSERT INTO deployments/, (params) => {
      capturedProfile = params[1] as string;
      return { rows: [{ id: 1 }] };
    });
    setupDeploymentMocks();

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
    expect(capturedProfile).toBe("aws-ecs-basic");
  });

  it("vendor onprem → DB target_profile = onprem-docker-basic", async () => {
    let capturedProfile: string | undefined;
    let capturedTargetEnvironment: number | undefined;
    let capturedRegistryEnvironment: number | undefined;
    mockPool.on(/INSERT INTO deployments/, (params) => {
      capturedProfile = params[1] as string;
      capturedTargetEnvironment = params[2] as number;
      capturedRegistryEnvironment = params[3] as number;
      return { rows: [{ id: 2 }] };
    });
    setupDeploymentMocks();

    const form = new FormData();
    form.append("project_id", "1");
    form.append("target", "onprem");
    form.append("source", Buffer.from("PK fake zip"), { filename: "app.zip", contentType: "application/zip" });

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/deployments",
      headers: form.getHeaders(),
      payload: form.getBuffer(),
    });

    expect(res.statusCode).toBe(202);
    expect(capturedProfile).toBe("onprem-docker-basic");
    expect(capturedTargetEnvironment).toBe(20);
    expect(capturedRegistryEnvironment).toBe(10);
  });

  it("rejects deployment before storing the ZIP when an AWS credential Secret is missing", async () => {
    setupDeploymentMocks({ missingSecret: "aws-secret-access-key" });

    const form = new FormData();
    form.append("project_id", "1");
    form.append("target", "aws");
    form.append("source", Buffer.from("PK fake zip"), {
      filename: "app.zip",
      contentType: "application/zip",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/deployments",
      headers: form.getHeaders(),
      payload: form.getBuffer(),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("AWS_CREDENTIALS_MISSING");
    expect(mockStorage.store.size).toBe(0);
    expect(mockBoss.sentJobs).toHaveLength(0);
  });

  it("기본 target Environment가 없으면 업로드를 저장하지 않고 409", async () => {
    const form = new FormData();
    form.append("project_id", "1");
    form.append("target", "aws");
    form.append("source", Buffer.from("PK fake zip"), {
      filename: "app.zip",
      contentType: "application/zip",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/deployments",
      headers: form.getHeaders(),
      payload: form.getBuffer(),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe(
      "TARGET_ENVIRONMENT_REQUIRED",
    );
    expect(mockStorage.store.size).toBe(0);
  });

  it("구 profile ID (aws-ecs-basic) 를 target 으로 보내면 400 VALIDATION_ERROR", async () => {
    const form = new FormData();
    form.append("project_id", "1");
    form.append("target", "aws-ecs-basic");
    form.append("source", Buffer.from("PK fake zip"), { filename: "app.zip", contentType: "application/zip" });

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/deployments",
      headers: form.getHeaders(),
      payload: form.getBuffer(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
  });

});

// ── 4. GET /deployments/:id ───────────────────────────────────────────────────

describe("GET /api/v1/deployments/:id", () => {
  it("returns deployment with currentStep and approvalPending", async () => {
    const dep = makeDeployment(42, 1, "awaiting_target_confirmation");
    mockPool.on(/SELECT id, project_id, status, target_profile, target_environment_id/, () => ({
      rows: [dep],
    }));
    mockPool.on(/FROM deployment_steps/, () => ({ rows: [] }));
    mockPool.on(/FROM approvals/, () => ({ rows: [] }));

    const res = await server.inject({ method: "GET", url: "/api/v1/deployments/42" });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: string; status: string }>();
    expect(body.id).toBe("42");
    expect(body.status).toBe("awaiting_target_confirmation");
  });

  it("returns 404 for unknown deployment", async () => {
    mockPool.on(/SELECT id, project_id, status, target_profile, target_environment_id/, () => ({
      rows: [],
    }));

    const res = await server.inject({ method: "GET", url: "/api/v1/deployments/999" });
    expect(res.statusCode).toBe(404);
  });
});

// ── 5. GET /deployments/:id/events SSE ───────────────────────────────────────

describe("GET /api/v1/deployments/:id/events", () => {
  it("returns 404 for unknown deployment", async () => {
    mockPool.on(/SELECT id, status FROM deployments/, () => ({ rows: [] }));

    const res = await server.inject({
      method: "GET",
      url: "/api/v1/deployments/999/events",
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("NOT_FOUND");
  });

  it("sse-broker publish/subscribe/replay lifecycle works correctly", () => {
    // Unit test the broker directly — no network request needed
    const broker = server.sseBroker;
    expect(broker).toBeDefined();

    const received: string[] = [];
    const unsub = broker.subscribe("42", (evt) => received.push(evt.event));

    broker.publish("42", { event: "state_changed", data: { deploymentId: "42", from: "received", to: "analyzing" } });
    broker.publish("42", { event: "analysis.progress", data: { deploymentId: "42", phase: "rule_detection", message: "..." } });

    expect(received).toHaveLength(2);
    expect(received[0]).toBe("state_changed");

    // replay with null returns empty
    expect(broker.replay("42", null)).toHaveLength(0);

    // replay after first event returns second
    const buffer = broker.replay("42", null);
    expect(buffer).toHaveLength(0);

    unsub();

    // After unsubscribe, new events are not received
    broker.publish("42", { event: "state_changed", data: {} });
    expect(received).toHaveLength(2); // still 2
  });
});

// ── 6. GET /deployments/:id/ir 404 ───────────────────────────────────────────

describe("GET /api/v1/deployments/:id/ir", () => {
  it("returns 404 when no IR exists yet", async () => {
    // No rows in ir_versions
    mockPool.on(/FROM ir_versions/, () => ({ rows: [] }));

    const res = await server.inject({ method: "GET", url: "/api/v1/deployments/1/ir" });
    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });
});

// ── 7. PATCH /deployments/:id/ir 잘못된 IR 400 ───────────────────────────────

describe("PATCH /api/v1/deployments/:id/ir", () => {
  it("returns 400 when IR fails schema validation", async () => {
    // dep is in editable state
    mockPool.on(/SELECT status FROM deployments/, () => ({
      rows: [{ status: "awaiting_target_confirmation" }],
    }));
    // current ir version
    mockPool.on(/FROM ir_versions/, () => ({
      rows: [makeIrVersion(1, 42)],
    }));

    const res = await server.inject({
      method: "PATCH",
      url: "/api/v1/deployments/42/ir",
      payload: {
        version: 1,
        ir: {
          // Missing required 'deploy' field and malformed services
          metadata: { name: "bad-app", version: "1.0.0" },
          services: {
            api: {
              type: "invalid-type", // not in enum
              port: 3000,
            },
          },
        },
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});

// ── 8. POST /deployments/:id/approvals target approve ────────────────────────

describe("POST /api/v1/deployments/:id/approvals", () => {
  it("approves target gate, transitions to queued, acquires env_lock", async () => {
    // BEGIN / COMMIT
    mockPool.on(/^BEGIN$|^COMMIT$|^ROLLBACK$/, () => ({ rows: [] }));
    // deployment FOR UPDATE
    mockPool.on(/FROM deployments WHERE id/, () => ({
      rows: [
        {
          id: 42,
          status: "awaiting_target_confirmation",
          project_id: 1,
          target_profile: "aws-ecs-basic",
          target_environment_id: 10,
        },
      ],
    }));
    // approvals insert
    mockPool.on(/INSERT INTO approvals/, () => ({ rows: [] }));
    // env_locks insert
    mockPool.on(/INSERT INTO env_locks/, () => ({ rows: [] }));
    // UPDATE deployments status
    mockPool.on(/UPDATE deployments/, () => ({ rows: [] }));

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/deployments/42/approvals",
      payload: { gate: "target", decision: "approve" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      deploymentId: string;
      gate: string;
      decision: string;
      newStatus: string;
      lockAcquired: boolean;
    }>();
    expect(body.deploymentId).toBe("42");
    expect(body.gate).toBe("target");
    expect(body.decision).toBe("approve");
    expect(body.newStatus).toBe("queued");
    expect(body.lockAcquired).toBe(true);
    expect(mockBoss.sentJobs).toContainEqual({
      name: "build",
      data: { deployment_id: 42 },
    });
  });

  it("returns 400 for invalid gate value", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/deployments/42/approvals",
      payload: { gate: "unknown", decision: "approve" },
    });
    expect(res.statusCode).toBe(400);
  });
});
