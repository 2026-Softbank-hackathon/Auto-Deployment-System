/**
 * 배포 실패 코드(deployments.error) → 사용자가 무엇을 하면 되는지에 따른 분류.
 * 코드는 워커의 빌드 · 프로비저닝 핸들러가 남긴다 (apps/worker handlers/build.ts normalizeBuildFailure,
 * handlers/provision.ts normalizeProvisionFailure, packages/aws-registry · packages/build-handler · packages/adapters 의 오류 코드).
 * 모르는 코드는 분류하지 않는다. 화면은 일반 안내 문구와 함께 코드를 작게 보여 준다.
 */
export type FailureKind = 'awsKey' | 'awsKeyStored' | 'awsPermission' | 'registry' | 'source' | 'build' | 'buildTool'
  | 'setup' | 'appSecret' | 'envVar' | 'infra' | 'agent' | 'server'
  | 'multiService' | 'resources' | 'port' | 'profile' | 'appStart';

const kinds: Record<string, FailureKind> = {
  AWS_ECR_AUTHENTICATION_FAILED: 'awsKey',
  AWS_REGISTRY_CREDENTIALS_INVALID: 'awsKey',
  PROJECT_SECRET_NOT_FOUND: 'awsKeyStored',
  PROJECT_SECRET_DECRYPT_FAILED: 'awsKeyStored',
  AWS_ECR_PERMISSION_DENIED: 'awsPermission',
  AWS_ECR_REPOSITORY_FAILED: 'registry',
  AWS_ECR_AUTHORIZATION_FAILED: 'registry',
  AWS_ECR_RESPONSE_INVALID: 'registry',
  DOCKER_AUTH_FAILED: 'registry',
  DOCKERFILE_NOT_FOUND: 'source',
  BUILD_CONTEXT_NOT_FOUND: 'source',
  BUILD_COMMAND_FAILED: 'build',
  BUILD_FAILED: 'build',
  BUILD_TOOL_UNAVAILABLE: 'buildTool',
  BUILD_DEPENDENCY_MISSING: 'buildTool',
  DOCKER_AUTH_UNAVAILABLE: 'buildTool',
  // IR → 배포 계획 변환 (packages/adapters). 빌드 · 프로비저닝 어느 쪽에서도 날 수 있다.
  P0_SINGLE_HTTP_SERVICE_REQUIRED: 'multiService',
  P0_RESOURCES_UNSUPPORTED: 'resources',
  SERVICE_PORT_REQUIRED: 'port',
  ROUTE_TARGET_INVALID: 'port',
  PROFILE_INCOMPATIBLE: 'profile',
  PROFILE_MISMATCH: 'profile',
  PROFILE_NOT_FOUND: 'profile',
  SIZE_MAPPING_NOT_FOUND: 'profile',
  PROFILE_CONFIGURATION_INVALID: 'server',
  ADAPTER_NOT_FOUND: 'server',
  // 프로비저닝 단계
  AWS_CREDENTIALS_UNSUPPORTED: 'awsKey',
  TARGET_ENVIRONMENT_REQUIRED: 'setup',
  APPLICATION_SECRET_DELIVERY_UNAVAILABLE: 'appSecret',
  PROJECT_ENV_VAR_NOT_FOUND: 'envVar',
  PROVISION_FAILED: 'infra',
  TERRAFORM_INIT_FAILED: 'infra',
  TERRAFORM_VALIDATE_FAILED: 'infra',
  TERRAFORM_PLAN_FAILED: 'infra',
  TERRAFORM_APPLY_FAILED: 'infra',
  TERRAFORM_OUTPUT_FAILED: 'infra',
  TERRAFORM_OUTPUT_INVALID: 'infra',
  TERRAFORM_OUTPUT_MISSING: 'infra',
  // ECS 롤아웃 대기 (apps/worker ecs-rollout.ts) — 새 태스크가 뜨지 않거나 헬스체크를 못 넘김
  ECS_TASK_STOPPED: 'appStart',
  ECS_ROLLOUT_FAILED: 'appStart',
  ECS_ROLLOUT_TIMEOUT: 'appStart',
  ECS_SERVICE_NOT_FOUND: 'infra',
  ECS_ROLLOUT_CHECK_FAILED: 'infra',
  BUILD_ARTIFACT_MISSING: 'build',
  IMAGE_PLATFORM_UNSUPPORTED: 'build',
  ECR_REPOSITORY_INVALID: 'registry',
  AGENT_JOB_CONFLICT: 'agent',
  AGENT_JOB_NOT_RETRYABLE: 'agent',
  AGENT_JOB_PERSIST_FAILED: 'agent',
  TERRAFORM_DEPENDENCY_MISSING: 'server',
  TERRAFORM_BACKEND_CONFIG_INCOMPLETE: 'server',
  TERRAFORM_MODULE_INVALID: 'server',
  TERRAFORM_BINARY_UNAVAILABLE: 'server',
  TERRAFORM_BACKEND_INVALID: 'server',
  TERRAFORM_INPUT_INVALID: 'server',
  PROVISION_TARGET_UNSUPPORTED: 'server',
  PROVISION_STATE_INVALID: 'server',
  AUTO_APPROVE_STATE_INVALID: 'server',
};

/**
 * 서버가 준 실패 사유(deployments.error)를 코드와 상세로 나눈다. 서버는 이런 모양으로 준다:
 *   "TERRAFORM_APPLY_FAILED"                         코드만
 *   "TERRAFORM_APPLY_FAILED\n<Terraform 오류 원문>"   코드 + 줄바꿈 + 상세 (apps/worker handlers/provision.ts failProvisionStage)
 *   "PROJECT_ENV_VAR_NOT_FOUND: A,B"                  코드 + 콜론 + 설명
 * 첫머리가 코드 모양(대문자 · 숫자 · 밑줄)이 아니면 전체를 상세로 본다.
 */
export function parseFailure(raw: string | null): { code: string | null; detail: string | null } {
  const text = raw?.trim() ?? '';
  if (!text) return { code: null, detail: null };
  const match = /^([A-Z][A-Z0-9_]*)(?:\s*:\s*|\s*\n|$)([\s\S]*)$/.exec(text);
  if (!match) return { code: null, detail: text };
  return { code: match[1], detail: match[2].trim() || null };
}

export function failureKind(code: string | null): FailureKind | null {
  const parsed = parseFailure(code).code;
  return parsed ? kinds[parsed] ?? null : null;
}

/** 연결 설정에서 풀 수 있는 실패인지 — 연결 설정으로 가는 버튼을 보여 줄지 정한다. */
export function fixableByAwsKey(kind: FailureKind | null): boolean {
  return kind === 'awsKey' || kind === 'awsKeyStored' || kind === 'awsPermission' || kind === 'setup';
}
