import { z } from "zod";

// ── projects ──────────────────────────────────────────────────────────────────

export const ProjectSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  description: z.string().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});
export type Project = z.infer<typeof ProjectSchema>;

// ── deployments ───────────────────────────────────────────────────────────────

export const DeploymentStatus = z.enum([
  "received",
  "analyzing",
  "awaiting_target_confirmation",
  "target_confirmed",
  "awaiting_plan_approval",
  "plan_approved",
  "provisioning",
  "building",
  "deploying",
  "verifying",
  "awaiting_patch_approval",
  "patching",
  "succeeded",
  "failed",
  "cancelled",
  "rolled_back",
]);
export type DeploymentStatus = z.infer<typeof DeploymentStatus>;

export const DeploymentSchema = z.object({
  id: z.number().int().positive(),
  project_id: z.number().int().positive(),
  status: DeploymentStatus,
  target_profile: z.string().nullable(),
  target_environment_id: z.number().int().positive().nullable(),
  registry_environment_id: z.number().int().positive().nullable(),
  public_url: z.string().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
  succeeded_at: z.date().nullable(),
  failed_at: z.date().nullable(),
  error: z.string().nullable(),
});
export type Deployment = z.infer<typeof DeploymentSchema>;

// ── source_versions ───────────────────────────────────────────────────────────

export const SourceVersionSchema = z.object({
  id: z.number().int().positive(),
  deployment_id: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  storage_key: z.string().min(1),
  size_bytes: z.number().int().nonnegative(),
  created_at: z.date(),
});
export type SourceVersion = z.infer<typeof SourceVersionSchema>;

export const BuildArtifactSchema = z.object({
  id: z.number().int().positive(),
  deployment_id: z.number().int().positive(),
  repository_uri: z.string().min(1),
  image_tag: z.string().min(1),
  image_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  immutable_ref: z.string().min(1),
  platform: z.string().min(1),
  strategy: z.enum(["dockerfile", "railpack"]),
  created_at: z.date(),
  updated_at: z.date(),
});
export type BuildArtifact = z.infer<typeof BuildArtifactSchema>;

// ── analysis_reports ──────────────────────────────────────────────────────────

export const AnalysisReportSchema = z.object({
  id: z.number().int().positive(),
  deployment_id: z.number().int().positive(),
  source_version_id: z.number().int().positive().nullable(),
  services_json: z.array(z.record(z.unknown())),
  resources_json: z.array(z.record(z.unknown())),
  warnings_json: z.array(z.unknown()),
  unresolved_json: z.array(z.unknown()),
  ir_valid: z.boolean(),
  ir_errors_json: z.array(z.unknown()).nullable(),
  created_at: z.date(),
});
export type AnalysisReport = z.infer<typeof AnalysisReportSchema>;

// ── ir_versions ───────────────────────────────────────────────────────────────

export const IrSource = z.enum(["analyzer", "ai_filled", "user_edited"]);
export type IrSource = z.infer<typeof IrSource>;

export const IrVersionSchema = z.object({
  id: z.number().int().positive(),
  deployment_id: z.number().int().positive(),
  ir_json: z.record(z.unknown()),
  source: IrSource,
  created_at: z.date(),
});
export type IrVersion = z.infer<typeof IrVersionSchema>;

// ── env_locks ─────────────────────────────────────────────────────────────────

export const EnvLockSchema = z.object({
  id: z.number().int().positive(),
  env_key: z.string().min(1),
  deployment_id: z.number().int().positive(),
  lease_expires_at: z.date(),
  created_at: z.date(),
});
export type EnvLock = z.infer<typeof EnvLockSchema>;

// ── approvals ─────────────────────────────────────────────────────────────────

export const ApprovalGate = z.enum(["patch", "target", "plan"]);
export type ApprovalGate = z.infer<typeof ApprovalGate>;

export const ApprovalDecision = z.enum(["approve", "reject"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export const ApprovalSchema = z.object({
  id: z.number().int().positive(),
  deployment_id: z.number().int().positive(),
  gate: ApprovalGate,
  decision: ApprovalDecision.nullable(),
  note: z.string().nullable(),
  created_at: z.date(),
  decided_at: z.date().nullable(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

// ── deployment_steps ──────────────────────────────────────────────────────────

export const StepStatus = z.enum(["running", "succeeded", "failed"]);
export type StepStatus = z.infer<typeof StepStatus>;

export const DeploymentStepSchema = z.object({
  id: z.number().int().positive(),
  deployment_id: z.number().int().positive(),
  step_name: z.string().min(1),
  job_id: z.string().min(1).nullable(),
  status: StepStatus,
  started_at: z.date(),
  finished_at: z.date().nullable(),
  duration_ms: z.number().int().nonnegative().nullable(),
  message: z.string().nullable(),
});
export type DeploymentStep = z.infer<typeof DeploymentStepSchema>;

// ── health_check_attempts ────────────────────────────────────────────────────

export const HealthCheckAttemptSchema = z.object({
  id: z.number().int().positive(),
  deployment_step_id: z.number().int().positive(),
  environment_id: z.string().min(1),
  attempt: z.number().int().min(1),
  checked_at: z.date(),
  status_code: z.number().int().min(100).max(599).nullable(),
  latency_ms: z.number().int().nonnegative().nullable(),
  passed: z.boolean(),
  error_code: z.string().min(1).nullable(),
  error_message: z.string().min(1).nullable(),
});
export type HealthCheckAttempt = z.infer<typeof HealthCheckAttemptSchema>;

// ── ai_usage ──────────────────────────────────────────────────────────────────

export const AiUsageSchema = z.object({
  id: z.number().int().positive(),
  deployment_id: z.number().int().positive().nullable(),
  model: z.string().min(1),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_creation_tokens: z.number().int().nonnegative(),
  cache_read_tokens: z.number().int().nonnegative(),
  estimated_cost_usd: z.number().nonnegative(),
  created_at: z.date(),
});
export type AiUsage = z.infer<typeof AiUsageSchema>;
