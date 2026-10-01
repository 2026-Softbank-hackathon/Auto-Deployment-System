import {
  CreateRepositoryCommand,
  DescribeRepositoriesCommand,
  ECRClient,
  GetAuthorizationTokenCommand,
  type Repository,
} from "@aws-sdk/client-ecr";
import { AwsRegistryError, type AwsRegistryErrorCode } from "./errors.js";
import type {
  AwsAccessKeyCredentials,
  EcrAuthorization,
  EcrRepository,
} from "./types.js";

const REPOSITORY_NAME_PATTERN =
  /^[a-z0-9]+(?:(?:[._-][a-z0-9]+)|(?:\/[a-z0-9]+))*$/;

type EcrCommand =
  | DescribeRepositoriesCommand
  | CreateRepositoryCommand
  | GetAuthorizationTokenCommand;

export interface EcrClientLike {
  send(command: EcrCommand): Promise<unknown>;
}

export type AwsEcrRegistryOptions = {
  region: string;
  credentials: AwsAccessKeyCredentials;
  client?: EcrClientLike;
};

export class AwsEcrRegistry {
  private readonly client: EcrClientLike;

  constructor(options: AwsEcrRegistryOptions) {
    const region = requireNonEmpty(options.region, "AWS region");
    const accessKeyId = requireNonEmpty(
      options.credentials.accessKeyId,
      "AWS access key ID",
    );
    const secretAccessKey = requireNonEmpty(
      options.credentials.secretAccessKey,
      "AWS secret access key",
    );

    this.client =
      options.client ??
      new ECRClient({
        region,
        credentials: {
          accessKeyId,
          secretAccessKey,
          ...(options.credentials.sessionToken
            ? { sessionToken: options.credentials.sessionToken }
            : {}),
        },
      });
  }

  async ensureProjectRepository(
    projectId: number | string,
  ): Promise<EcrRepository> {
    return this.ensureRepository(repositoryNameForProject(projectId));
  }

  async ensureRepository(repositoryName: string): Promise<EcrRepository> {
    const name = validateRepositoryName(repositoryName);

    try {
      const existing = await this.describeRepository(name);
      if (existing) return normalizeRepository(existing, name);

      try {
        const response = (await this.client.send(
          new CreateRepositoryCommand({
            repositoryName: name,
            imageTagMutability: "IMMUTABLE",
            imageScanningConfiguration: { scanOnPush: true },
            encryptionConfiguration: { encryptionType: "AES256" },
          }),
        )) as { repository?: Repository };
        return normalizeRepository(response.repository, name);
      } catch (error) {
        if (awsErrorName(error) === "RepositoryAlreadyExistsException") {
          const racedRepository = await this.describeRepository(name);
          return normalizeRepository(racedRepository, name);
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof AwsRegistryError) throw error;
      throw normalizeAwsError(error, "repository");
    }
  }

  async getAuthorization(): Promise<EcrAuthorization> {
    try {
      const response = (await this.client.send(
        new GetAuthorizationTokenCommand({}),
      )) as {
        authorizationData?: Array<{
          authorizationToken?: string;
          expiresAt?: Date;
          proxyEndpoint?: string;
        }>;
      };
      const data = response.authorizationData?.[0];
      if (
        !data?.authorizationToken ||
        !data.expiresAt ||
        !data.proxyEndpoint
      ) {
        throw invalidResponse("ECR authorization 응답에 필수 값이 없습니다.");
      }

      const decoded = Buffer.from(data.authorizationToken, "base64").toString(
        "utf8",
      );
      const separator = decoded.indexOf(":");
      const username = separator === -1 ? "" : decoded.slice(0, separator);
      const password = separator === -1 ? "" : decoded.slice(separator + 1);
      if (username !== "AWS" || password.length === 0) {
        throw invalidResponse("ECR authorization token 형식이 올바르지 않습니다.");
      }

      return {
        registryUri: normalizeRegistryUri(data.proxyEndpoint),
        username: "AWS",
        password,
        expiresAt: data.expiresAt.toISOString(),
      };
    } catch (error) {
      if (error instanceof AwsRegistryError) throw error;
      throw normalizeAwsError(error, "authorization");
    }
  }

  private async describeRepository(name: string): Promise<Repository | null> {
    try {
      const response = (await this.client.send(
        new DescribeRepositoriesCommand({ repositoryNames: [name] }),
      )) as { repositories?: Repository[] };
      return response.repositories?.[0] ?? null;
    } catch (error) {
      if (awsErrorName(error) === "RepositoryNotFoundException") return null;
      throw error;
    }
  }
}

export function repositoryNameForProject(projectId: number | string): string {
  const value = String(projectId);
  if (!/^\d+$/.test(value) || BigInt(value) < 1n) {
    throw new AwsRegistryError(
      "INVALID_AWS_REGISTRY_REQUEST",
      "양수 project ID가 필요합니다.",
    );
  }
  return `camellia/projects/${value}`;
}

function validateRepositoryName(value: string): string {
  const name = value.trim();
  if (
    name.length < 2 ||
    name.length > 256 ||
    !REPOSITORY_NAME_PATTERN.test(name)
  ) {
    throw new AwsRegistryError(
      "INVALID_AWS_REGISTRY_REQUEST",
      "유효한 ECR repository 이름이 필요합니다.",
    );
  }
  return name;
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new AwsRegistryError(
      "INVALID_AWS_REGISTRY_REQUEST",
      `${field} 값이 필요합니다.`,
    );
  }
  return normalized;
}

function normalizeRepository(
  repository: Repository | undefined | null,
  expectedName: string,
): EcrRepository {
  if (!repository?.repositoryUri) {
    throw invalidResponse("ECR repository 응답에 URI가 없습니다.");
  }
  const repositoryUri = repository.repositoryUri.replace(/^https?:\/\//, "");
  const separator = repositoryUri.indexOf("/");
  if (separator <= 0 || separator === repositoryUri.length - 1) {
    throw invalidResponse("ECR repository URI 형식이 올바르지 않습니다.");
  }

  return {
    name: repository.repositoryName ?? expectedName,
    repositoryUri,
    registryUri: repositoryUri.slice(0, separator),
    ...(repository.registryId ? { registryId: repository.registryId } : {}),
    ...(repository.repositoryArn ? { arn: repository.repositoryArn } : {}),
  };
}

function normalizeRegistryUri(value: string): string {
  const normalized = value.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (normalized.length === 0 || normalized.includes("/")) {
    throw invalidResponse("ECR registry URI 형식이 올바르지 않습니다.");
  }
  return normalized;
}

function invalidResponse(message: string): AwsRegistryError {
  return new AwsRegistryError("AWS_ECR_RESPONSE_INVALID", message);
}

function awsErrorName(error: unknown): string {
  if (!error || typeof error !== "object") return "UnknownAwsError";
  const candidate = error as { name?: unknown };
  return typeof candidate.name === "string"
    ? candidate.name
    : "UnknownAwsError";
}

function normalizeAwsError(
  error: unknown,
  operation: "repository" | "authorization",
): AwsRegistryError {
  const awsCode = awsErrorName(error);
  let code: AwsRegistryErrorCode;
  let message: string;

  if (
    [
      "CredentialsProviderError",
      "UnrecognizedClientException",
      "InvalidSignatureException",
      "ExpiredTokenException",
    ].includes(awsCode)
  ) {
    code = "AWS_ECR_AUTHENTICATION_FAILED";
    message = "AWS 자격 증명을 확인할 수 없습니다.";
  } else if (awsCode === "AccessDeniedException") {
    code = "AWS_ECR_PERMISSION_DENIED";
    message = "ECR 작업에 필요한 AWS 권한이 없습니다.";
  } else if (operation === "repository") {
    code = "AWS_ECR_REPOSITORY_FAILED";
    message = "ECR repository를 준비하지 못했습니다.";
  } else {
    code = "AWS_ECR_AUTHORIZATION_FAILED";
    message = "ECR authorization token을 발급하지 못했습니다.";
  }

  return new AwsRegistryError(code, message, {
    operation,
    awsCode,
  });
}
