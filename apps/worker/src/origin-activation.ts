import type { CloudflareClient } from "@camellia/cloudflare";
import type { Pool } from "@camellia/db";
import type { VerifyJobPayload } from "./handlers/verify.js";

type CloudflareOperations = Pick<CloudflareClient,
  "ensureNamedTunnel" | "ensureCname" | "setTunnelOrigin" | "switchServiceOrigin">;

export type OriginActivationOptions = {
  cloudflare?: CloudflareOperations;
  zoneId?: string;
  platformDomain?: string;
};

type OriginContext = {
  project_id: number | string;
  target_environment_id: number | string;
  environment_type: string;
  status: string;
  public_url: string | null;
  verify_status: string | null;
  agent_status: string | null;
  agent_result: unknown;
};

export class OriginActivationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OriginActivationError";
  }
}

export class DeploymentOriginActivator {
  constructor(
    private readonly pool: Pool,
    private readonly options: OriginActivationOptions,
  ) {}

  async prepareOnpremVerification(input: {
    deploymentId: number;
    projectId: number;
  }): Promise<void> {
    if (!Number.isSafeInteger(input.deploymentId) || input.deploymentId < 1) {
      throw new OriginActivationError("ORIGIN_DEPLOYMENT_INVALID");
    }
    if (!Number.isSafeInteger(input.projectId) || input.projectId < 1) {
      throw new OriginActivationError("ORIGIN_PROJECT_INVALID");
    }
    const { cloudflare, zoneId, domain } = this.cloudflareConfiguration();
    const tunnel = await safeCloudflare(() =>
      cloudflare.ensureNamedTunnel(String(input.projectId))
    );
    await safeCloudflare(() => cloudflare.ensureCname({
      zoneId,
      hostname: `verify-d${input.deploymentId}.${domain}`,
      target: tunnel.endpoint,
      proxied: true,
    }));
  }

  async activate(payload: VerifyJobPayload): Promise<void> {
    const result = await this.pool.query<OriginContext>(
      `SELECT deployment.project_id, deployment.target_environment_id,
              environment.type AS environment_type, deployment.status,
              deployment.public_url, latest_verify.status AS verify_status,
              job.status AS agent_status, job.result AS agent_result
       FROM deployments AS deployment
       JOIN environments AS environment ON environment.id = deployment.target_environment_id
       LEFT JOIN onprem_agent_jobs AS job
         ON job.deployment_id = deployment.id AND job.environment_id = environment.id
       LEFT JOIN LATERAL (
         SELECT step.status FROM deployment_steps AS step
         WHERE step.deployment_id = deployment.id AND step.step_name = 'verify'
           AND step.job_id = $2
         ORDER BY step.id DESC LIMIT 1
       ) AS latest_verify ON TRUE
       WHERE deployment.id = $1`,
      [payload.deploymentId, payload.jobId],
    );
    const row = result.rows[0];
    if (!row || row.verify_status !== "succeeded" ||
        String(row.target_environment_id) !== payload.environmentId ||
        row.environment_type !== payload.environmentType ||
        row.public_url !== payload.targetUrl) {
      throw new OriginActivationError("ORIGIN_VERIFICATION_MISMATCH");
    }
    if (row.status === "succeeded") return;
    if (row.status !== "verifying") {
      throw new OriginActivationError("ORIGIN_DEPLOYMENT_NOT_VERIFYING");
    }

    const projectId = String(row.project_id);
    if (!/^[1-9]\d*$/.test(projectId)) throw new OriginActivationError("ORIGIN_PROJECT_INVALID");
    const { cloudflare, zoneId, domain } = this.cloudflareConfiguration();
    const serviceHostname = `service-${projectId}.apps.${domain}`;
    let originHostname: string;
    let tunnelIngress: { tunnelId: string; hostname: string; serviceUrl: string } | undefined;

    if (payload.environmentType === "aws") {
      originHostname = albHostname(payload.targetUrl);
    } else {
      const agentResult = parseAgentResult(row.agent_result);
      if (row.agent_status !== "ready_for_verify" ||
          agentResult["status"] !== "ready_for_verify" ||
          agentResult["deploymentId"] !== payload.deploymentId ||
          agentResult["environmentId"] !== payload.environmentId ||
          agentResult["endpoint"] !== payload.targetUrl ||
          safeUrl(payload.targetUrl).hostname !== `verify-d${payload.deploymentId}.${domain}` ||
          (payload.expectedDigest && agentResult["runningDigest"] !== payload.expectedDigest)) {
        throw new OriginActivationError("ORIGIN_AGENT_RESULT_MISMATCH");
      }
      const serviceUrl = loopbackOrigin(agentResult["localUrl"]);
      const tunnel = await safeCloudflare(() => cloudflare.ensureNamedTunnel(projectId));
      originHostname = tunnel.endpoint;
      tunnelIngress = { tunnelId: tunnel.id, hostname: serviceHostname, serviceUrl };
    }

    await this.assertStillVerifying(payload.deploymentId);
    if (tunnelIngress) {
      await safeCloudflare(() => cloudflare.setTunnelOrigin(tunnelIngress!));
    }
    await safeCloudflare(() => cloudflare.switchServiceOrigin({
      zoneId: zoneId.trim(), serviceHostname, originHostname,
    }));
  }

  private async assertStillVerifying(deploymentId: number): Promise<void> {
    const result = await this.pool.query<{ status: string }>(
      "SELECT status FROM deployments WHERE id = $1", [deploymentId],
    );
    if (result.rows[0]?.status !== "verifying") {
      throw new OriginActivationError("ORIGIN_DEPLOYMENT_NOT_VERIFYING");
    }
  }

  private cloudflareConfiguration(): {
    cloudflare: CloudflareOperations;
    zoneId: string;
    domain: string;
  } {
    const { cloudflare, zoneId, platformDomain } = this.options;
    const normalizedZoneId = zoneId?.trim();
    const domain = platformDomain?.trim().replace(/\.$/, "").toLowerCase();
    if (!cloudflare || !normalizedZoneId || !domain) {
      throw new OriginActivationError("ORIGIN_CONFIGURATION_MISSING");
    }
    if (!domain.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw new OriginActivationError("ORIGIN_DOMAIN_INVALID");
    }
    return { cloudflare, zoneId: normalizedZoneId, domain };
  }
}

function albHostname(value: string): string {
  const url = safeUrl(value);
  if (!["http:", "https:"].includes(url.protocol) || url.port ||
      !/\.elb\.amazonaws\.com(?:\.cn)?$/.test(url.hostname)) {
    throw new OriginActivationError("ORIGIN_ALB_INVALID");
  }
  return url.hostname;
}

function loopbackOrigin(value: unknown): string {
  if (typeof value !== "string") throw new OriginActivationError("ORIGIN_LOCAL_URL_INVALID");
  const url = safeUrl(value);
  const port = Number(url.port);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
      !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new OriginActivationError("ORIGIN_LOCAL_URL_INVALID");
  }
  return `http://127.0.0.1:${port}`;
}

function safeUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error();
    }
    return url;
  } catch {
    throw new OriginActivationError("ORIGIN_URL_INVALID");
  }
}

function parseAgentResult(value: unknown): Record<string, unknown> {
  try {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new OriginActivationError("ORIGIN_AGENT_RESULT_INVALID");
  }
}

async function safeCloudflare<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new OriginActivationError("ORIGIN_CLOUDFLARE_FAILED");
  }
}
