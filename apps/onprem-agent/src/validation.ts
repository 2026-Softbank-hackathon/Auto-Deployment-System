import type {
  EcrCredential,
  OnpremAgentJob,
} from "./contracts.js";
import { AgentError } from "./errors.js";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ECR_HOST_PATTERN =
  /^(?<account>\d{12})\.dkr\.ecr\.(?<region>[a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/;

function invalid(message: string): never {
  throw new AgentError("invalid_job", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  value: unknown,
  field: string,
  pattern?: RegExp,
): string {
  if (typeof value !== "string" || value.length === 0) {
    return invalid(`${field} 값이 올바르지 않습니다.`);
  }
  if (pattern && !pattern.test(value)) {
    return invalid(`${field} 형식이 올바르지 않습니다.`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    return invalid(`${field} 값이 올바르지 않습니다.`);
  }
  return Number(value);
}

function validatePlan(plan: unknown): void {
  if (!isRecord(plan)) invalid("plan이 객체가 아닙니다.");
  if (plan.schemaVersion !== "0.1.0") invalid("지원하지 않는 plan 버전입니다.");
  if (plan.target !== "onprem") invalid("On-Prem plan이 아닙니다.");

  if (!isRecord(plan.profile)) invalid("plan.profile이 올바르지 않습니다.");
  requireString(plan.profile.id, "plan.profile.id", IDENTIFIER_PATTERN);
  requireString(plan.profile.version, "plan.profile.version");

  if (!isRecord(plan.application)) {
    invalid("plan.application이 올바르지 않습니다.");
  }
  requireString(plan.application.name, "plan.application.name");
  requireString(plan.application.version, "plan.application.version");

  if (!isRecord(plan.service)) invalid("plan.service가 올바르지 않습니다.");
  requireString(plan.service.name, "plan.service.name");
  if (plan.service.type !== "http") {
    invalid("P0 On-Prem Agent는 HTTP service만 지원합니다.");
  }
  const port = requirePositiveInteger(
    plan.service.containerPort,
    "plan.service.containerPort",
  );
  if (port > 65_535) invalid("container port 범위가 올바르지 않습니다.");
  if (!Array.isArray(plan.service.environmentNames)) {
    invalid("plan.service.environmentNames가 올바르지 않습니다.");
  }
  for (const name of plan.service.environmentNames) {
    requireString(name, "environment name", ENVIRONMENT_KEY_PATTERN);
  }
  if (!Array.isArray(plan.service.secretNames)) {
    invalid("plan.service.secretNames가 올바르지 않습니다.");
  }
  if (plan.service.secretNames.length > 0) {
    invalid("P0 On-Prem Agent는 application secret 전달을 지원하지 않습니다.");
  }

  if (!isRecord(plan.health)) invalid("plan.health가 올바르지 않습니다.");
  const healthPath = requireString(plan.health.path, "plan.health.path");
  if (
    !/^\/[A-Za-z0-9._~/%-]*$/.test(healthPath) ||
    healthPath.startsWith("//")
  ) {
    invalid("health path는 단일 /로 시작해야 합니다.");
  }
  const expectedStatus = requirePositiveInteger(
    plan.health.expectedStatus,
    "plan.health.expectedStatus",
  );
  if (expectedStatus < 100 || expectedStatus > 599) {
    invalid("health expected status 범위가 올바르지 않습니다.");
  }
  if (
    typeof plan.health.timeoutSeconds !== "number" ||
    !Number.isFinite(plan.health.timeoutSeconds) ||
    plan.health.timeoutSeconds <= 0
  ) {
    invalid("health timeout 값이 올바르지 않습니다.");
  }

  if (!isRecord(plan.ingress)) invalid("plan.ingress가 올바르지 않습니다.");
  if (
    plan.ingress.enabled !== true ||
    plan.ingress.exposure !== "public" ||
    plan.ingress.type !== "cloudflare-tunnel"
  ) {
    invalid("공개 Cloudflare Tunnel ingress plan이 필요합니다.");
  }

  if (!isRecord(plan.runtime)) invalid("plan.runtime이 올바르지 않습니다.");
  if (plan.runtime.type !== "docker-compose") {
    invalid("Docker Compose runtime plan이 아닙니다.");
  }
  if (
    typeof plan.runtime.cpus !== "number" ||
    !Number.isFinite(plan.runtime.cpus) ||
    plan.runtime.cpus <= 0
  ) {
    invalid("runtime cpus 값이 올바르지 않습니다.");
  }
  requirePositiveInteger(plan.runtime.memoryMiB, "plan.runtime.memoryMiB");
  requirePositiveInteger(plan.runtime.replicas, "plan.runtime.replicas");

  if (!isRecord(plan.provisioning)) {
    invalid("plan.provisioning이 올바르지 않습니다.");
  }
  if (plan.provisioning.engine !== "docker-compose") {
    invalid("Docker Compose provisioning plan이 아닙니다.");
  }
  requireString(plan.provisioning.projectName, "plan.provisioning.projectName");
}

function registryFromRepository(repositoryUri: string): string {
  const slash = repositoryUri.indexOf("/");
  if (slash < 1 || slash === repositoryUri.length - 1) {
    invalid("image.repositoryUri 형식이 올바르지 않습니다.");
  }
  if (
    repositoryUri.includes("@") ||
    repositoryUri.includes(":", slash) ||
    repositoryUri.includes(":", 0)
  ) {
    invalid("image.repositoryUri에는 tag 또는 digest를 포함할 수 없습니다.");
  }
  return repositoryUri.slice(0, slash);
}

export function parseOnpremAgentJob(value: unknown): OnpremAgentJob {
  if (!isRecord(value)) invalid("job이 객체가 아닙니다.");
  requireString(value.jobId, "jobId", IDENTIFIER_PATTERN);
  requirePositiveInteger(value.attempt, "attempt");
  requirePositiveInteger(value.deploymentId, "deploymentId");
  requireString(value.environmentId, "environmentId", IDENTIFIER_PATTERN);
  validatePlan(value.plan);

  if (!isRecord(value.image)) invalid("image가 올바르지 않습니다.");
  const repositoryUri = requireString(
    value.image.repositoryUri,
    "image.repositoryUri",
  );
  const registry = registryFromRepository(repositoryUri);
  const digest = requireString(value.image.digest, "image.digest", DIGEST_PATTERN);
  if (!digest.startsWith("sha256:")) invalid("지원하지 않는 digest입니다.");
  if (value.image.platform !== "linux/amd64") {
    invalid("P0 platform은 linux/amd64만 지원합니다.");
  }
  if (value.image.registryType !== "ecr") {
    invalid("P0 registry는 ECR만 지원합니다.");
  }
  const region = requireString(value.image.region, "image.region");
  const ecrMatch = ECR_HOST_PATTERN.exec(registry);
  if (!ecrMatch || ecrMatch.groups?.region !== region) {
    invalid("repository URI와 AWS Region이 일치하지 않습니다.");
  }

  if (value.environment !== undefined) {
    if (!isRecord(value.environment)) invalid("environment가 올바르지 않습니다.");
    for (const [key, environmentValue] of Object.entries(value.environment)) {
      requireString(key, "environment key", ENVIRONMENT_KEY_PATTERN);
      if (typeof environmentValue !== "string") {
        invalid("environment value는 문자열이어야 합니다.");
      }
    }
  }

  return value as OnpremAgentJob;
}

export function validateEcrCredential(
  job: OnpremAgentJob,
  value: unknown,
  now = new Date(),
): asserts value is EcrCredential {
  if (!isRecord(value)) {
    throw new AgentError(
      "ecr_auth_failed",
      "ECR 인증정보 형식이 올바르지 않습니다.",
    );
  }
  const credential = value;
  const expectedRegistry = registryFromRepository(job.image.repositoryUri);
  const match =
    typeof credential.registry === "string"
      ? ECR_HOST_PATTERN.exec(credential.registry)
      : null;
  if (
    !match ||
    match.groups?.region !== job.image.region ||
    credential.registry !== expectedRegistry
  ) {
    throw new AgentError(
      "ecr_auth_failed",
      "ECR Registry가 실행 요청과 일치하지 않습니다.",
    );
  }
  if (
    credential.username !== "AWS" ||
    typeof credential.password !== "string" ||
    credential.password.length === 0
  ) {
    throw new AgentError(
      "ecr_auth_failed",
      "ECR 인증정보 형식이 올바르지 않습니다.",
    );
  }
  const expiresAt =
    typeof credential.expiresAt === "string"
      ? Date.parse(credential.expiresAt)
      : Number.NaN;
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    throw new AgentError(
      "ecr_auth_failed",
      "ECR 인증정보가 만료되었습니다.",
    );
  }
}

export function imageUriForJob(job: OnpremAgentJob): string {
  return `${job.image.repositoryUri}@${job.image.digest}`;
}
