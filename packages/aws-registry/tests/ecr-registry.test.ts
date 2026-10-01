import {
  CreateRepositoryCommand,
  DescribeRepositoriesCommand,
  GetAuthorizationTokenCommand,
} from "@aws-sdk/client-ecr";
import { describe, expect, it, vi } from "vitest";
import {
  AwsEcrRegistry,
  AwsRegistryError,
  repositoryNameForProject,
  type EcrClientLike,
} from "../src/index.js";

const credentials = {
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
};

function createRegistry(send: EcrClientLike["send"]): AwsEcrRegistry {
  return new AwsEcrRegistry({
    region: "ap-northeast-2",
    credentials,
    client: { send },
  });
}

describe("AwsEcrRegistry", () => {
  it("기존 project repository를 그대로 재사용한다", async () => {
    const send = vi.fn(async (command) => {
      expect(command).toBeInstanceOf(DescribeRepositoriesCommand);
      return {
        repositories: [
          {
            repositoryName: "camellia/projects/42",
            repositoryUri:
              "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/camellia/projects/42",
            registryId: "123456789012",
            repositoryArn: "arn:aws:ecr:ap-northeast-2:123456789012:repository/camellia/projects/42",
          },
        ],
      };
    });
    const registry = createRegistry(send);

    await expect(registry.ensureProjectRepository(42)).resolves.toEqual({
      name: "camellia/projects/42",
      repositoryUri:
        "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/camellia/projects/42",
      registryUri: "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com",
      registryId: "123456789012",
      arn: "arn:aws:ecr:ap-northeast-2:123456789012:repository/camellia/projects/42",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("repository가 없으면 immutable/scanning 설정으로 생성한다", async () => {
    const send = vi.fn(async (command) => {
      if (command instanceof DescribeRepositoriesCommand) {
        const error = new Error("not found");
        error.name = "RepositoryNotFoundException";
        throw error;
      }
      expect(command).toBeInstanceOf(CreateRepositoryCommand);
      expect(command.input).toEqual({
        repositoryName: "camellia/projects/7",
        imageTagMutability: "IMMUTABLE",
        imageScanningConfiguration: { scanOnPush: true },
        encryptionConfiguration: { encryptionType: "AES256" },
      });
      return {
        repository: {
          repositoryName: "camellia/projects/7",
          repositoryUri:
            "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/camellia/projects/7",
        },
      };
    });
    const registry = createRegistry(send);

    const result = await registry.ensureProjectRepository("7");

    expect(result.name).toBe("camellia/projects/7");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("동시 생성 race가 나면 repository를 다시 조회한다", async () => {
    let describeCount = 0;
    const send = vi.fn(async (command) => {
      if (command instanceof DescribeRepositoriesCommand) {
        describeCount += 1;
        if (describeCount === 1) {
          const error = new Error("not found");
          error.name = "RepositoryNotFoundException";
          throw error;
        }
        return {
          repositories: [
            {
              repositoryName: "camellia/projects/9",
              repositoryUri:
                "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/camellia/projects/9",
            },
          ],
        };
      }
      const error = new Error("already exists");
      error.name = "RepositoryAlreadyExistsException";
      throw error;
    });
    const registry = createRegistry(send);

    await expect(registry.ensureProjectRepository(9)).resolves.toMatchObject({
      name: "camellia/projects/9",
    });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("ECR authorization token을 Docker login 계약으로 변환한다", async () => {
    const expiresAt = new Date("2026-10-01T12:00:00.000Z");
    const send = vi.fn(async (command) => {
      expect(command).toBeInstanceOf(GetAuthorizationTokenCommand);
      return {
        authorizationData: [
          {
            authorizationToken: Buffer.from("AWS:temporary-password").toString(
              "base64",
            ),
            expiresAt,
            proxyEndpoint:
              "https://123456789012.dkr.ecr.ap-northeast-2.amazonaws.com",
          },
        ],
      };
    });
    const registry = createRegistry(send);

    await expect(registry.getAuthorization()).resolves.toEqual({
      registryUri: "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com",
      username: "AWS",
      password: "temporary-password",
      expiresAt: "2026-10-01T12:00:00.000Z",
    });
  });

  it("AWS 권한 오류에 원래 메시지나 credential을 노출하지 않는다", async () => {
    const send = vi.fn(async () => {
      const error = new Error(
        `denied for ${credentials.accessKeyId}:${credentials.secretAccessKey}`,
      );
      error.name = "AccessDeniedException";
      throw error;
    });
    const registry = createRegistry(send);

    const error = await registry.ensureProjectRepository(1).catch((caught) => caught);

    expect(error).toBeInstanceOf(AwsRegistryError);
    expect(error.code).toBe("AWS_ECR_PERMISSION_DENIED");
    expect(JSON.stringify(error)).not.toContain(credentials.accessKeyId);
    expect(JSON.stringify(error)).not.toContain(credentials.secretAccessKey);
    expect(error.message).not.toContain(credentials.accessKeyId);
  });

  it("잘못된 authorization 응답을 명시적 오류로 거부한다", async () => {
    const registry = createRegistry(
      vi.fn(async () => ({
        authorizationData: [
          {
            authorizationToken: Buffer.from("invalid-token").toString("base64"),
            expiresAt: new Date(),
            proxyEndpoint: "https://registry.example.com",
          },
        ],
      })),
    );

    await expect(registry.getAuthorization()).rejects.toMatchObject({
      code: "AWS_ECR_RESPONSE_INVALID",
    });
  });
});

describe("repositoryNameForProject", () => {
  it("project ID를 고정된 repository namespace로 변환한다", () => {
    expect(repositoryNameForProject(123)).toBe("camellia/projects/123");
  });

  it.each([0, -1, "", "abc", "1/2"])(
    "잘못된 project ID %s를 거부한다",
    (projectId) => {
      expect(() => repositoryNameForProject(projectId)).toThrow(
        AwsRegistryError,
      );
    },
  );

  it("잘못된 repository 이름을 AWS 호출 전에 거부한다", async () => {
    const send = vi.fn();
    const registry = createRegistry(send);

    await expect(registry.ensureRepository("/invalid")).rejects.toMatchObject({
      code: "INVALID_AWS_REGISTRY_REQUEST",
    });
    expect(send).not.toHaveBeenCalled();
  });
});
