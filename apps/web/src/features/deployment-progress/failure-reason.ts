/**
 * 배포 실패 코드(deployments.error) → 사용자가 무엇을 하면 되는지에 따른 분류.
 * 코드는 워커 빌드 핸들러가 남긴다 (apps/worker handlers/build.ts normalizeBuildFailure,
 * packages/aws-registry · packages/build-handler 의 오류 코드). 모르는 코드는 분류하지 않고 그대로 보여 준다.
 */
export type FailureKind = 'awsKey' | 'awsKeyStored' | 'awsPermission' | 'registry' | 'source' | 'build' | 'buildTool';

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
};

export function failureKind(code: string | null): FailureKind | null {
  return code ? kinds[code.trim()] ?? null : null;
}

/** AWS 키를 바꾸면 풀리는 실패인지 — 설정으로 가는 버튼을 보여 줄지 정한다. */
export function fixableByAwsKey(kind: FailureKind | null): boolean {
  return kind === 'awsKey' || kind === 'awsKeyStored' || kind === 'awsPermission';
}
