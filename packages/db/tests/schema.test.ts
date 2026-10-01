import { describe, it, expect } from "vitest";
import {
  ProjectSchema,
  DeploymentSchema,
  DeploymentStatus,
  SourceVersionSchema,
  AnalysisReportSchema,
  IrVersionSchema,
  IrSource,
  EnvLockSchema,
  ApprovalSchema,
  ApprovalGate,
  DeploymentStepSchema,
  StepStatus,
  AiUsageSchema,
} from "../src/schema.js";

const now = new Date();

// ── success cases ─────────────────────────────────────────────────────────────

describe("ProjectSchema - success", () => {
  it("parses a minimal project", () => {
    const result = ProjectSchema.safeParse({
      id: 1,
      name: "my-project",
      description: null,
      created_at: now,
      updated_at: now,
    });
    expect(result.success).toBe(true);
  });

  it("parses a project with description", () => {
    const result = ProjectSchema.safeParse({
      id: 42,
      name: "camellia",
      description: "auto deploy system",
      created_at: now,
      updated_at: now,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.description).toBe("auto deploy system");
  });
});

describe("DeploymentSchema - success", () => {
  it("parses a received deployment", () => {
    const result = DeploymentSchema.safeParse({
      id: 1,
      project_id: 1,
      status: "received",
      target_profile: null,
      target_environment_id: null,
      registry_environment_id: null,
      public_url: null,
      created_at: now,
      updated_at: now,
      succeeded_at: null,
      failed_at: null,
      error: null,
    });
    expect(result.success).toBe(true);
  });

  it("parses a succeeded deployment", () => {
    const result = DeploymentSchema.safeParse({
      id: 2,
      project_id: 1,
      status: "succeeded",
      target_profile: "aws-ecs-basic",
      target_environment_id: 10,
      registry_environment_id: 10,
      public_url: "https://example.com",
      created_at: now,
      updated_at: now,
      succeeded_at: now,
      failed_at: null,
      error: null,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.public_url).toBe("https://example.com");
  });

  it("parses a failed deployment", () => {
    const result = DeploymentSchema.safeParse({
      id: 3,
      project_id: 1,
      status: "failed",
      target_profile: "aws-ecs-basic",
      target_environment_id: 20,
      registry_environment_id: 10,
      public_url: null,
      created_at: now,
      updated_at: now,
      succeeded_at: null,
      failed_at: now,
      error: "provision timeout",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.error).toBe("provision timeout");
  });
});

describe("SourceVersionSchema - success", () => {
  it("parses a valid source version", () => {
    const result = SourceVersionSchema.safeParse({
      id: 1,
      deployment_id: 1,
      sha256: "a".repeat(64),
      storage_key: "uploads/abc123.tar.gz",
      size_bytes: 1024000,
      created_at: now,
    });
    expect(result.success).toBe(true);
  });
});

describe("AnalysisReportSchema - success", () => {
  it("parses a valid analysis report", () => {
    const result = AnalysisReportSchema.safeParse({
      id: 1,
      deployment_id: 1,
      source_version_id: 1,
      services_json: [{ name: "api", image: "node:20" }],
      resources_json: [{ type: "rds", engine: "postgres" }],
      warnings_json: [],
      unresolved_json: [],
      ir_valid: true,
      ir_errors_json: null,
      created_at: now,
    });
    expect(result.success).toBe(true);
  });

  it("parses an invalid IR report with errors", () => {
    const result = AnalysisReportSchema.safeParse({
      id: 2,
      deployment_id: 1,
      source_version_id: null,
      services_json: [],
      resources_json: [],
      warnings_json: ["missing Dockerfile"],
      unresolved_json: ["redis"],
      ir_valid: false,
      ir_errors_json: [{ field: "services", message: "empty" }],
      created_at: now,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.ir_valid).toBe(false);
  });
});

describe("IrVersionSchema - success", () => {
  it("parses an analyzer IR version", () => {
    const result = IrVersionSchema.safeParse({
      id: 1,
      deployment_id: 1,
      ir_json: { version: "1.0", services: [] },
      source: "analyzer",
      created_at: now,
    });
    expect(result.success).toBe(true);
  });
});

describe("EnvLockSchema - success", () => {
  it("parses a valid env lock", () => {
    const future = new Date(Date.now() + 60_000);
    const result = EnvLockSchema.safeParse({
      id: 1,
      env_key: "aws-ecs-basic:my-project",
      deployment_id: 1,
      lease_expires_at: future,
      created_at: now,
    });
    expect(result.success).toBe(true);
  });
});

describe("ApprovalSchema - success", () => {
  it("parses a pending approval", () => {
    const result = ApprovalSchema.safeParse({
      id: 1,
      deployment_id: 1,
      gate: "target",
      decision: null,
      note: null,
      created_at: now,
      decided_at: null,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.decision).toBeNull();
  });

  it("parses an approved plan gate", () => {
    const result = ApprovalSchema.safeParse({
      id: 2,
      deployment_id: 1,
      gate: "plan",
      decision: "approve",
      note: "looks good",
      created_at: now,
      decided_at: now,
    });
    expect(result.success).toBe(true);
  });
});

describe("DeploymentStepSchema - success", () => {
  it("parses a running step", () => {
    const result = DeploymentStepSchema.safeParse({
      id: 1,
      deployment_id: 1,
      step_name: "analyze",
      job_id: null,
      status: "running",
      started_at: now,
      finished_at: null,
      duration_ms: null,
      message: null,
    });
    expect(result.success).toBe(true);
  });

  it("parses a succeeded step with duration", () => {
    const result = DeploymentStepSchema.safeParse({
      id: 2,
      deployment_id: 1,
      step_name: "build",
      job_id: null,
      status: "succeeded",
      started_at: now,
      finished_at: now,
      duration_ms: 4200,
      message: "image pushed",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.duration_ms).toBe(4200);
  });
});

describe("AiUsageSchema - success", () => {
  it("parses a valid ai_usage row", () => {
    const result = AiUsageSchema.safeParse({
      id: 1,
      deployment_id: 1,
      model: "claude-3-5-sonnet-20241022",
      input_tokens: 5000,
      output_tokens: 1200,
      cache_creation_tokens: 400,
      cache_read_tokens: 3000,
      estimated_cost_usd: 0.002145,
      created_at: now,
    });
    expect(result.success).toBe(true);
  });

  it("parses ai_usage with null deployment_id", () => {
    const result = AiUsageSchema.safeParse({
      id: 2,
      deployment_id: null,
      model: "claude-3-haiku-20240307",
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      estimated_cost_usd: 0.000015,
      created_at: now,
    });
    expect(result.success).toBe(true);
  });
});

// ── failure cases ─────────────────────────────────────────────────────────────

describe("DeploymentStatus - failure", () => {
  it("rejects an unknown status string", () => {
    const result = DeploymentStatus.safeParse("unknown_status");
    expect(result.success).toBe(false);
  });

  it("rejects empty string status", () => {
    const result = DeploymentStatus.safeParse("");
    expect(result.success).toBe(false);
  });
});

describe("DeploymentSchema - failure", () => {
  it("rejects missing project_id", () => {
    const result = DeploymentSchema.safeParse({
      id: 1,
      status: "received",
      target_profile: null,
      public_url: null,
      created_at: now,
      updated_at: now,
      succeeded_at: null,
      failed_at: null,
      error: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid status", () => {
    const result = DeploymentSchema.safeParse({
      id: 1,
      project_id: 1,
      status: "not_a_real_status",
      target_profile: null,
      public_url: null,
      created_at: now,
      updated_at: now,
      succeeded_at: null,
      failed_at: null,
      error: null,
    });
    expect(result.success).toBe(false);
  });
});

describe("SourceVersionSchema - failure", () => {
  it("rejects sha256 that is too short", () => {
    const result = SourceVersionSchema.safeParse({
      id: 1,
      deployment_id: 1,
      sha256: "abc123",
      storage_key: "uploads/abc.tar.gz",
      size_bytes: 1024,
      created_at: now,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative size_bytes", () => {
    const result = SourceVersionSchema.safeParse({
      id: 1,
      deployment_id: 1,
      sha256: "a".repeat(64),
      storage_key: "uploads/abc.tar.gz",
      size_bytes: -1,
      created_at: now,
    });
    expect(result.success).toBe(false);
  });
});

describe("IrSource - failure", () => {
  it("rejects unknown source value", () => {
    const result = IrSource.safeParse("gpt_filled");
    expect(result.success).toBe(false);
  });
});

describe("ApprovalGate - failure", () => {
  it("rejects unknown gate value", () => {
    const result = ApprovalGate.safeParse("manual");
    expect(result.success).toBe(false);
  });
});

describe("StepStatus - failure", () => {
  it("rejects unknown step status", () => {
    const result = StepStatus.safeParse("pending");
    expect(result.success).toBe(false);
  });
});

describe("ProjectSchema - failure", () => {
  it("rejects empty project name", () => {
    const result = ProjectSchema.safeParse({
      id: 1,
      name: "",
      description: null,
      created_at: now,
      updated_at: now,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer id", () => {
    const result = ProjectSchema.safeParse({
      id: 1.5,
      name: "ok",
      description: null,
      created_at: now,
      updated_at: now,
    });
    expect(result.success).toBe(false);
  });
});
