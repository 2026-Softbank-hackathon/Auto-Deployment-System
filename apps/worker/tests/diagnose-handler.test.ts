/**
 * apps/worker/tests/diagnose-handler.test.ts
 * handleDiagnose 유닛 테스트 (mock pool + mock Anthropic client).
 */

import { describe, it, expect, vi } from "vitest";
import { handleDiagnose } from "../src/handlers/diagnose.js";
import type { WorkerDeps } from "../src/deps.js";
import type { AnthropicLike } from "@camellia/analyzer";

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;

function makePool(overrides: { existing?: unknown[] } = {}) {
  const query: QueryFn = async (sql) => {
    if (sql.includes("SELECT diagnosis_json FROM deployments WHERE id")) {
      return {
        rows: overrides.existing ?? [{ diagnosis_json: null }],
        rowCount: (overrides.existing ?? [{ diagnosis_json: null }]).length,
      };
    }
    if (sql.includes("SELECT status, target_profile")) {
      return {
        rows: [{ status: "failed", target_profile: "aws-ecs-basic", error: "boom" }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM deployment_steps")) {
      return {
        rows: [{ step_name: "build", status: "failed", message: "docker build error" }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM ir_versions")) {
      return { rows: [{ ir_json: { services: {} } }], rowCount: 1 };
    }
    if (sql.includes("FROM analysis_reports")) {
      return { rows: [{ warnings_json: [] }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return { query: vi.fn(query) } as unknown as WorkerDeps["pool"];
}

function makeClient(text: string): AnthropicLike {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: "text" as const, text }],
        usage: { input_tokens: 100, output_tokens: 50 },
      })),
    },
  };
}

function makeDeps(pool: WorkerDeps["pool"]): WorkerDeps {
  return {
    pool,
    boss: {} as WorkerDeps["boss"],
    storage: {} as WorkerDeps["storage"],
  };
}

describe("handleDiagnose", () => {
  it("이미 진단이 있으면 Claude 호출 없이 skip", async () => {
    const pool = makePool({ existing: [{ diagnosis_json: { summary: "already" } }] });
    const deps = makeDeps(pool);
    const clientFactory = vi.fn(async () => makeClient(""));
    await handleDiagnose({ data: { deployment_id: 1 } }, deps, clientFactory);
    expect(clientFactory).not.toHaveBeenCalled();
    // UPDATE deployments 호출 없어야 함
    const updateCall = (pool.query as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("UPDATE deployments SET diagnosis_json"),
    );
    expect(updateCall).toBeUndefined();
  });

  it("Claude JSON 응답을 파싱해 diagnosis_json 을 저장한다", async () => {
    const pool = makePool();
    const deps = makeDeps(pool);
    const responseJson = JSON.stringify({
      failedStep: "build",
      summary: "docker build 실패",
      patchCandidates: [
        { description: "Node 22 → 18 downgrade", diff: "-FROM node:22\n+FROM node:18" },
      ],
    });
    const client = makeClient(`여기 진단 결과입니다:\n${responseJson}`);
    const clientFactory = vi.fn(async () => client);
    await handleDiagnose({ data: { deployment_id: 1 } }, deps, clientFactory);
    expect(client.messages.create).toHaveBeenCalledOnce();
    const calls = (pool.query as ReturnType<typeof vi.fn>).mock.calls;
    const updateCall = calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("UPDATE deployments SET diagnosis_json"),
    );
    expect(updateCall).toBeDefined();
    const stored = JSON.parse((updateCall![1] as unknown[])[0] as string);
    expect(stored.summary).toContain("docker build");
    expect(stored.patchCandidates).toHaveLength(1);
    // ai_usage INSERT 도 호출됐어야 함
    const usageCall = calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO ai_usage"),
    );
    expect(usageCall).toBeDefined();
  });

  it("Claude SDK 로딩 실패 시 fallback diagnosis 를 저장한다", async () => {
    const pool = makePool();
    const deps = makeDeps(pool);
    const clientFactory = vi.fn(async () => {
      throw new Error("SDK missing");
    });
    await handleDiagnose({ data: { deployment_id: 1 } }, deps, clientFactory);
    const updateCall = (pool.query as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("UPDATE deployments SET diagnosis_json"),
    );
    expect(updateCall).toBeDefined();
    const stored = JSON.parse((updateCall![1] as unknown[])[0] as string);
    expect(stored.summary).toMatch(/SDK/);
    expect(stored.patchCandidates).toEqual([]);
    // ai_usage INSERT 는 없어야 (Claude 호출 없음)
    const usageCall = (pool.query as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO ai_usage"),
    );
    expect(usageCall).toBeUndefined();
  });
});
