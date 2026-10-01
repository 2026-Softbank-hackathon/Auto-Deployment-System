export type AwsRegistryErrorCode =
  | "INVALID_AWS_REGISTRY_REQUEST"
  | "AWS_ECR_AUTHENTICATION_FAILED"
  | "AWS_ECR_PERMISSION_DENIED"
  | "AWS_ECR_REPOSITORY_FAILED"
  | "AWS_ECR_AUTHORIZATION_FAILED"
  | "AWS_ECR_RESPONSE_INVALID";

export class AwsRegistryError extends Error {
  readonly code: AwsRegistryErrorCode;
  readonly details?: Readonly<Record<string, string | number | boolean>>;

  constructor(
    code: AwsRegistryErrorCode,
    message: string,
    details?: Readonly<Record<string, string | number | boolean>>,
  ) {
    super(message);
    this.name = "AwsRegistryError";
    this.code = code;
    this.details = details;
  }
}
