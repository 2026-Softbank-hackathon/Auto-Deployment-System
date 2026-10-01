import {
  AwsEcrRegistry,
  type AwsEcrRegistryOptions,
} from "@camellia/aws-registry";
import { AwsConfigSchema } from "@camellia/contracts";
import type { Pool } from "@camellia/db";
import { ApiError } from "../plugins/error-handler.js";
import type { AgentIdentity } from "../routes/agent-jobs.js";
import type { SecretService } from "./secret-service.js";

export type AgentEcrCredential = {
  registry: string;
  username: "AWS";
  password: string;
  expiresAt: string;
};

type CredentialRow = {
  project_id: number | string;
  aws_config: unknown;
  payload: unknown;
  attempt: number;
};

type Registry = Pick<AwsEcrRegistry, "getAuthorization">;
export type AwsEcrRegistryFactory = (
  options: AwsEcrRegistryOptions,
) => Registry;

export class AgentEcrCredentialService {
  constructor(
    private readonly pool: Pool,
    private readonly secretService: SecretService,
    private readonly registryFactory: AwsEcrRegistryFactory = (options) =>
      new AwsEcrRegistry(options),
  ) {}

  async issue(input: {
    agent: AgentIdentity;
    jobId: string;
  }): Promise<AgentEcrCredential> {
    const result = await this.pool.query<CredentialRow>(
      `UPDATE onprem_agent_jobs AS job
       SET ecr_credential_issued_attempt = job.attempt,
           updated_at = NOW()
       FROM deployments AS deployment
       JOIN environments AS target_environment
         ON target_environment.id = deployment.target_environment_id
       JOIN environments AS registry_environment
         ON registry_environment.id = deployment.registry_environment_id
       WHERE job.job_id = $1
         AND job.environment_id = $2
         AND job.lease_owner_id = $3
         AND job.status IN ('claimed', 'running')
         AND job.lease_expires_at > NOW()
         AND job.ecr_credential_issued_attempt IS DISTINCT FROM job.attempt
         AND deployment.id = job.deployment_id
         AND deployment.status = 'deploying'
         AND target_environment.id = job.environment_id
         AND target_environment.type = 'onprem'
         AND registry_environment.type = 'aws'
         AND registry_environment.project_id = deployment.project_id
       RETURNING registry_environment.project_id,
                 registry_environment.aws_config,
                 job.payload,
                 job.attempt`,
      [input.jobId, input.agent.environmentId, input.agent.agentId],
    );

    const row = result.rows[0];
    if (!row) {
      throw new ApiError(
        409,
        "AGENT_JOB_NOT_ELIGIBLE",
        "Agent에 할당된 실행 중 Job이 아니거나 ECR 인증정보를 이미 조회했습니다.",
      );
    }

    try {
      return await this.createCredential(row, input.agent, input.jobId);
    } catch {
      await this.releaseIssueMarker(input.agent, input.jobId, row.attempt);
      throw new ApiError(
        502,
        "ECR_CREDENTIAL_UNAVAILABLE",
        "사용자 AWS 계정의 ECR 인증정보를 발급하지 못했습니다.",
      );
    }
  }

  private async createCredential(
    row: CredentialRow,
    agent: AgentIdentity,
    jobId: string,
  ): Promise<AgentEcrCredential> {
    const config = AwsConfigSchema.parse(row.aws_config);
    if (
      config.credentialsType !== "access_key" ||
      !config.accessKeyIdSecretName ||
      !config.secretAccessKeySecretName
    ) {
      throw new Error("AWS_REGISTRY_CREDENTIALS_UNSUPPORTED");
    }

    const image = imageFromPayload(row.payload);
    const projectId = Number(row.project_id);
    if (!Number.isSafeInteger(projectId) || projectId <= 0) {
      throw new Error("AWS_REGISTRY_PROJECT_INVALID");
    }

    const [accessKeyId, secretAccessKey] = await Promise.all([
      this.secretService.decrypt({
        projectId,
        name: config.accessKeyIdSecretName,
      }),
      this.secretService.decrypt({
        projectId,
        name: config.secretAccessKeySecretName,
      }),
    ]);
    const authorization = await this.registryFactory({
      region: config.region,
      credentials: { accessKeyId, secretAccessKey },
    }).getAuthorization();

    const imageRegistry = registryHost(image.repositoryUri);
    if (authorization.registryUri !== imageRegistry) {
      throw new Error("ECR_REGISTRY_MISMATCH");
    }
    const activeLease = await this.pool.query(
      `SELECT 1
       FROM onprem_agent_jobs AS job
       JOIN deployments AS deployment ON deployment.id = job.deployment_id
       WHERE job.job_id = $1
         AND job.environment_id = $2
         AND job.lease_owner_id = $3
         AND job.attempt = $4
         AND job.ecr_credential_issued_attempt = job.attempt
         AND job.status IN ('claimed', 'running')
         AND job.lease_expires_at > NOW()
         AND deployment.status = 'deploying'`,
      [jobId, agent.environmentId, agent.agentId, row.attempt],
    );
    if ((activeLease.rowCount ?? activeLease.rows.length) !== 1) {
      throw new Error("AGENT_JOB_LEASE_EXPIRED");
    }

    return {
      registry: authorization.registryUri,
      username: authorization.username,
      password: authorization.password,
      expiresAt: authorization.expiresAt,
    };
  }

  private async releaseIssueMarker(
    agent: AgentIdentity,
    jobId: string,
    attempt: number,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE onprem_agent_jobs
       SET ecr_credential_issued_attempt = NULL,
           updated_at = NOW()
       WHERE job_id = $1
         AND environment_id = $2
         AND lease_owner_id = $3
         AND attempt = $4
         AND status IN ('claimed', 'running')
         AND lease_expires_at > NOW()`,
      [jobId, agent.environmentId, agent.agentId, attempt],
    ).catch(() => {});
  }
}

function imageFromPayload(payload: unknown): { repositoryUri: string } {
  const value = typeof payload === "string" ? JSON.parse(payload) as unknown : payload;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AGENT_JOB_PAYLOAD_INVALID");
  }
  const image = (value as Record<string, unknown>)["image"];
  if (!image || typeof image !== "object" || Array.isArray(image)) {
    throw new Error("AGENT_JOB_PAYLOAD_INVALID");
  }
  const repositoryUri = (image as Record<string, unknown>)["repositoryUri"];
  if (typeof repositoryUri !== "string") {
    throw new Error("AGENT_JOB_PAYLOAD_INVALID");
  }
  return { repositoryUri };
}

function registryHost(repositoryUri: string): string {
  const match = /^(\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?)\//.exec(
    repositoryUri,
  );
  if (!match?.[1]) throw new Error("ECR_REPOSITORY_INVALID");
  return match[1];
}
