import type { CloudflareClient } from "@camellia/cloudflare";
import { projectSubdomain, serviceHostname as buildServiceHostname } from "@camellia/contracts";
import type { Pool } from "@camellia/db";
import {
  buildHealthUrl,
  type VerifyJobPayload,
  VerifyResultSchema,
} from "./handlers/verify.js";

type CloudflareOperations = Pick<CloudflareClient,
  "deleteCname" | "ensureNamedTunnel" | "ensureCname" | "findNamedTunnel" | "getCname" |
  "getTunnelOrigin" | "removeTunnelOrigin" | "setTunnelOrigin" | "switchServiceOrigin">;

export type OriginActivationOptions = {
  cloudflare?: CloudflareOperations;
  zoneId?: string;
  platformDomain?: string;
};

type OriginContext = {
  project_id: number | string;
  /** 앱 주소 (#300). 비어 있으면 service-{project_id} */
  project_subdomain: string | null;
  target_environment_id: number | string;
  environment_type: string;
  status: string;
  public_url: string | null;
  verify_status: string | null;
  verify_message: string | null;
  agent_status: string | null;
  agent_result: unknown;
};

type AwsStandbyContext = {
  project_id: number | string;
  project_subdomain: string | null;
  active_deployment_id: number | string | null;
  active_status: string;
  active_environment_type: string;
  active_failover_target_id: number | string | null;
  active_digest: string | null;
  standby_project_id: number | string;
  standby_status: string;
  standby_environment_type: string;
  standby_public_url: string | null;
  standby_digest: string | null;
};

export class OriginActivationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OriginActivationError";
  }
}

export type OriginActivationReceipt = {
  serviceHostname: string;
  activatedOrigin: string;
  previousOrigin: {
    hostname: string;
    proxied: boolean;
  } | null;
  tunnelIngress: {
    tunnelId: string;
    hostname: string;
    activatedServiceUrl: string;
    previousServiceUrl: string | null;
  } | null;
  /**
   * 공개 주소 레코드가 이미 이번 origin 을 프록시로 가리키고 Tunnel ingress 도 그대로라 바꾸지 않았다 (#299).
   * 권한 DNS 에 이미 보이는 레코드이므로 최종 URL 검증이 DNS 대기를 생략한다
   */
  reused?: true;
};

/**
 * 주소 변경 (#301) — 새 주소를 지금 서비스 중인 origin 에 연결한 결과. 검증에 실패하면 이걸로 새 주소만 지운다.
 */
export type ServiceAliasReceipt = {
  /** 새 공개 호스트 이름 */
  hostname: string;
  /** 지금(바꾸기 전) 공개 호스트 이름 */
  previousHostname: string;
  /** 두 주소가 함께 가리키는 origin (ALB · cfargotunnel endpoint) */
  origin: string;
  /** 온프레미스: 새 주소로 더한 Tunnel ingress */
  tunnelIngress: { tunnelId: string; serviceUrl: string } | null;
};

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

  async activate(payload: VerifyJobPayload): Promise<OriginActivationReceipt | null> {
    const result = await this.pool.query<OriginContext>(
      `SELECT deployment.project_id, project.subdomain AS project_subdomain,
              deployment.target_environment_id,
              environment.type AS environment_type, deployment.status,
              deployment.public_url, latest_verify.status AS verify_status,
              latest_verify.message AS verify_message,
              job.status AS agent_status, job.result AS agent_result
       FROM deployments AS deployment
       JOIN projects AS project ON project.id = deployment.project_id
       JOIN environments AS environment ON environment.id = deployment.target_environment_id
       LEFT JOIN onprem_agent_jobs AS job
         ON job.deployment_id = deployment.id AND job.environment_id = environment.id
       LEFT JOIN LATERAL (
         SELECT step.status, step.message FROM deployment_steps AS step
         WHERE step.deployment_id = deployment.id AND step.step_name = 'verify'
           AND step.job_id = $2
         ORDER BY step.id DESC LIMIT 1
       ) AS latest_verify ON TRUE
       WHERE deployment.id = $1`,
      [payload.deploymentId, payload.jobId],
    );
    const row = result.rows[0];
    const targetVerified = row && (
      row.verify_status === "succeeded" ||
      isTargetVerified(row.verify_message, payload)
    );
    if (!row || !targetVerified ||
        String(row.target_environment_id) !== payload.environmentId ||
        row.environment_type !== payload.environmentType ||
        row.public_url !== payload.targetUrl) {
      throw new OriginActivationError("ORIGIN_VERIFICATION_MISMATCH");
    }
    if (row.status === "succeeded") return null;
    if (row.status !== "verifying") {
      throw new OriginActivationError("ORIGIN_DEPLOYMENT_NOT_VERIFYING");
    }

    const projectId = String(row.project_id);
    if (!/^[1-9]\d*$/.test(projectId)) throw new OriginActivationError("ORIGIN_PROJECT_INVALID");
    const { cloudflare, zoneId, domain } = this.cloudflareConfiguration();
    const serviceHostname = projectServiceHostname(row.project_subdomain, projectId, domain);
    let originHostname: string;
    let tunnelIngress: { tunnelId: string; hostname: string; serviceUrl: string } | undefined;

    if (payload.environmentType === "aws") {
      originHostname = awsOriginHostname(payload.targetUrl);
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
    const previousRecord = await safeCloudflare(() => cloudflare.getCname({
      zoneId,
      hostname: serviceHostname,
    }));
    let tunnelChange: OriginActivationReceipt["tunnelIngress"] = null;
    const ingress = tunnelIngress;
    if (ingress) {
      const change = await safeCloudflare(() => cloudflare.setTunnelOrigin(ingress));
      tunnelChange = {
        tunnelId: ingress.tunnelId,
        hostname: ingress.hostname,
        activatedServiceUrl: ingress.serviceUrl,
        previousServiceUrl: change?.previousServiceUrl ?? null,
      };
    }
    // 같은 origin 으로의 갱신 (#299): 레코드 · ingress 가 이미 그대로면 바꿀 것이 없다.
    // 첫 배포(레코드 없음) · AWS ↔ 온프레미스 전환 · 실패 뒤 복구된 다른 origin 은 모두 여기서 갈린다
    const reused =
      previousRecord?.content === originHostname &&
      previousRecord.proxied === true &&
      (!tunnelChange || tunnelChange.previousServiceUrl === tunnelChange.activatedServiceUrl);
    if (!reused) {
      try {
        const activated = await safeCloudflare(() => cloudflare.switchServiceOrigin({
          zoneId: zoneId.trim(), serviceHostname, originHostname,
        }));
        if (activated.content !== originHostname) {
          throw new OriginActivationError("ORIGIN_CLOUDFLARE_MISMATCH");
        }
      } catch (error) {
        if (tunnelChange) {
          await this.restoreTunnelIngress(cloudflare, tunnelChange).catch(() => undefined);
        }
        throw error;
      }
    }
    return {
      serviceHostname,
      activatedOrigin: originHostname,
      previousOrigin: previousRecord
        ? { hostname: previousRecord.content, proxied: previousRecord.proxied }
        : null,
      tunnelIngress: tunnelChange,
      ...(reused ? { reused: true as const } : {}),
    };
  }

  /**
   * On-Prem 장애 시 새 배포를 만들지 않고 명시적으로 연결된 AWS Standby로 Origin을 바꾼다.
   * 연결 관계와 digest를 외부 호출 직전에 다시 확인해 과거 배포를 잘못 승격하지 않는다.
   */
  async activateAwsStandby(input: {
    projectId: number;
    activeDeploymentId: number;
    standbyDeploymentId: number;
  }): Promise<OriginActivationReceipt> {
    const row = await this.loadAwsStandbyContext(input);
    this.assertAwsStandbyContext(row, input);

    const { cloudflare, zoneId, domain } = this.cloudflareConfiguration();
    const serviceHostname = projectServiceHostname(
      row.project_subdomain,
      input.projectId,
      domain,
    );
    const originHostname = awsOriginHostname(row.standby_public_url ?? "");
    const previousRecord = await safeCloudflare(() => cloudflare.getCname({
      zoneId,
      hostname: serviceHostname,
    }));

    // Cloudflare 조회 사이에 새 배포가 성공했으면 오래된 Standby가 덮어쓰지 못하게 막는다.
    this.assertAwsStandbyContext(
      await this.loadAwsStandbyContext(input),
      input,
    );
    const reused = previousRecord?.content === originHostname && previousRecord.proxied === true;
    if (!reused) {
      const activated = await safeCloudflare(() => cloudflare.switchServiceOrigin({
        zoneId,
        serviceHostname,
        originHostname,
      }));
      if (activated.content !== originHostname) {
        throw new OriginActivationError("ORIGIN_CLOUDFLARE_MISMATCH");
      }
    }
    return {
      serviceHostname,
      activatedOrigin: originHostname,
      previousOrigin: previousRecord
        ? { hostname: previousRecord.content, proxied: previousRecord.proxied }
        : null,
      tunnelIngress: null,
      ...(reused ? { reused: true as const } : {}),
    };
  }

  async rollback(receipt: OriginActivationReceipt): Promise<void> {
    const { cloudflare, zoneId } = this.cloudflareConfiguration();
    if (receipt.tunnelIngress) {
      await this.restoreTunnelIngress(cloudflare, receipt.tunnelIngress);
    }
    const previousOrigin = receipt.previousOrigin;
    if (previousOrigin) {
      await safeCloudflare(() => cloudflare.ensureCname({
        zoneId,
        hostname: receipt.serviceHostname,
        target: previousOrigin.hostname,
        proxied: previousOrigin.proxied,
      }));
      return;
    }
    await safeCloudflare(() => cloudflare.deleteCname({
      zoneId,
      hostname: receipt.serviceHostname,
      expectedTarget: receipt.activatedOrigin,
    }));
  }

  /**
   * 앱 삭제 (#247) — 프로젝트 공개 주소({subdomain}, #300) CNAME 을 지우고, 온프레미스에 배포한 적이 있으면
   * 검증용 주소(verify-d{deploymentId}) CNAME 과 프로젝트 Named Tunnel 의 ingress 규칙도 지운다.
   * best effort: 하나가 실패해도 나머지를 계속하고, 실패한 대상을 돌려준다.
   * Tunnel 자체는 남긴다 — 온프레미스 cloudflared 가 붙어 있을 수 있고, ingress 가 없으면 외부에서 닿지 않는다.
   */
  async removeProjectOrigins(input: {
    projectId: number;
    /** 프로젝트 앱 주소 (#300). 비어 있으면 service-{projectId} */
    subdomain?: string | null;
    onpremDeploymentIds: number[];
  }): Promise<string[]> {
    if (!Number.isSafeInteger(input.projectId) || input.projectId < 1) {
      throw new OriginActivationError("ORIGIN_PROJECT_INVALID");
    }
    const { cloudflare, zoneId, domain } = this.cloudflareConfiguration();
    const serviceHostname = projectServiceHostname(input.subdomain, input.projectId, domain);
    const verifyHostnames = input.onpremDeploymentIds.map((id) => `verify-d${id}.${domain}`);
    const failures: string[] = [];

    for (const hostname of [serviceHostname, ...verifyHostnames]) {
      try {
        const record = await cloudflare.getCname({ zoneId, hostname });
        if (record) {
          await cloudflare.deleteCname({ zoneId, hostname, expectedTarget: record.content });
        }
      } catch {
        failures.push(`DNS ${hostname}`);
      }
    }

    if (verifyHostnames.length > 0) {
      try {
        const tunnel = await cloudflare.findNamedTunnel(String(input.projectId));
        if (tunnel) {
          for (const hostname of [serviceHostname, ...verifyHostnames]) {
            await cloudflare.removeTunnelOrigin({ tunnelId: tunnel.id, hostname });
          }
        }
      } catch {
        failures.push(`Tunnel camellia-service-${input.projectId}`);
      }
    }
    return failures;
  }

  /**
   * 주소 변경 (#301) 1단계 — 새 주소를 예전 주소가 가리키는 origin 에 연결한다. 예전 주소는 건드리지 않는다.
   * - AWS(ECS · Lambda 의 ALB): 예전 레코드와 같은 대상 · 프록시 설정으로 새 CNAME
   * - 온프레미스: 프로젝트 Named Tunnel 에 새 주소 ingress(예전 주소와 같은 로컬 포트)를 더한 뒤 같은 Tunnel 로 CNAME
   * 새 주소에 다른 대상을 가리키는 레코드가 이미 있으면 덮어쓰지 않는다. 다시 실행해도 같은 결과(재시도 안전).
   */
  async addServiceAlias(input: {
    projectId: number;
    fromSubdomain: string;
    toSubdomain: string;
  }): Promise<ServiceAliasReceipt> {
    if (!Number.isSafeInteger(input.projectId) || input.projectId < 1) {
      throw new OriginActivationError("ORIGIN_PROJECT_INVALID");
    }
    const { cloudflare, zoneId, domain } = this.cloudflareConfiguration();
    const previousHostname = projectServiceHostname(input.fromSubdomain, input.projectId, domain);
    const hostname = projectServiceHostname(input.toSubdomain, input.projectId, domain);
    if (hostname === previousHostname) throw new OriginActivationError("ADDRESS_UNCHANGED");

    const current = await safeCloudflare(() => cloudflare.getCname({ zoneId, hostname: previousHostname }));
    if (!current) throw new OriginActivationError("ADDRESS_ORIGIN_MISSING");
    const existing = await safeCloudflare(() => cloudflare.getCname({ zoneId, hostname }));
    if (existing && existing.content !== current.content) {
      throw new OriginActivationError("ADDRESS_RECORD_CONFLICT");
    }

    let tunnelIngress: ServiceAliasReceipt["tunnelIngress"] = null;
    if (current.content.endsWith(".cfargotunnel.com")) {
      const tunnel = await safeCloudflare(() => cloudflare.findNamedTunnel(String(input.projectId)));
      const serviceUrl = tunnel && tunnel.endpoint === current.content
        ? await safeCloudflare(() => cloudflare.getTunnelOrigin({ tunnelId: tunnel.id, hostname: previousHostname }))
        : null;
      if (!tunnel || !serviceUrl) throw new OriginActivationError("ADDRESS_TUNNEL_MISMATCH");
      await safeCloudflare(() => cloudflare.setTunnelOrigin({ tunnelId: tunnel.id, hostname, serviceUrl }));
      tunnelIngress = { tunnelId: tunnel.id, serviceUrl };
    }

    const receipt: ServiceAliasReceipt = { hostname, previousHostname, origin: current.content, tunnelIngress };
    try {
      await safeCloudflare(() => cloudflare.ensureCname({
        zoneId,
        hostname,
        target: current.content,
        proxied: current.proxied,
      }));
    } catch (error) {
      await this.removeServiceAlias(receipt).catch(() => undefined);
      throw error;
    }
    return receipt;
  }

  /** 주소 변경 실패 (#301) — 새 주소의 레코드 · ingress 만 지운다 (지금 origin 을 가리킬 때만). 예전 주소는 그대로 */
  async removeServiceAlias(receipt: ServiceAliasReceipt): Promise<void> {
    const { cloudflare, zoneId } = this.cloudflareConfiguration();
    await safeCloudflare(() => cloudflare.deleteCname({
      zoneId,
      hostname: receipt.hostname,
      expectedTarget: receipt.origin,
    }));
    const ingress = receipt.tunnelIngress;
    if (ingress) {
      await safeCloudflare(() => cloudflare.removeTunnelOrigin({
        tunnelId: ingress.tunnelId,
        hostname: receipt.hostname,
        expectedServiceUrl: ingress.serviceUrl,
      }));
    }
  }

  /**
   * 주소 변경 성공 뒤 (#301) — 예전 주소의 레코드와 (온프레미스에 배포한 적이 있으면) Tunnel ingress 를 지운다.
   * best effort: 실패한 대상을 돌려준다. 새 주소는 이미 서비스 중이라 여기서 실패해도 되돌리지 않는다.
   */
  async removeServiceHostname(input: { projectId: number; subdomain: string }): Promise<string[]> {
    if (!Number.isSafeInteger(input.projectId) || input.projectId < 1) {
      throw new OriginActivationError("ORIGIN_PROJECT_INVALID");
    }
    const { cloudflare, zoneId, domain } = this.cloudflareConfiguration();
    const hostname = projectServiceHostname(input.subdomain, input.projectId, domain);
    const failures: string[] = [];
    try {
      const record = await cloudflare.getCname({ zoneId, hostname });
      if (record) await cloudflare.deleteCname({ zoneId, hostname, expectedTarget: record.content });
    } catch {
      failures.push(`DNS ${hostname}`);
    }
    try {
      const tunnel = await cloudflare.findNamedTunnel(String(input.projectId));
      if (tunnel) await cloudflare.removeTunnelOrigin({ tunnelId: tunnel.id, hostname });
    } catch {
      failures.push(`Tunnel camellia-service-${input.projectId}`);
    }
    return failures;
  }

  private async restoreTunnelIngress(
    cloudflare: CloudflareOperations,
    change: NonNullable<OriginActivationReceipt["tunnelIngress"]>,
  ): Promise<void> {
    const previousServiceUrl = change.previousServiceUrl;
    if (previousServiceUrl) {
      await safeCloudflare(() => cloudflare.setTunnelOrigin({
        tunnelId: change.tunnelId,
        hostname: change.hostname,
        serviceUrl: previousServiceUrl,
      }));
      return;
    }
    await safeCloudflare(() => cloudflare.removeTunnelOrigin({
      tunnelId: change.tunnelId,
      hostname: change.hostname,
      expectedServiceUrl: change.activatedServiceUrl,
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

  private async loadAwsStandbyContext(input: {
    projectId: number;
    activeDeploymentId: number;
    standbyDeploymentId: number;
  }): Promise<AwsStandbyContext> {
    const result = await this.pool.query<AwsStandbyContext>(
      `SELECT project.id AS project_id,
              project.subdomain AS project_subdomain,
              project.active_deployment_id,
              active.status AS active_status,
              active_environment.type AS active_environment_type,
              active.failover_target_deployment_id AS active_failover_target_id,
              active_artifact.image_digest AS active_digest,
              standby.project_id AS standby_project_id,
              standby.status AS standby_status,
              standby_environment.type AS standby_environment_type,
              standby.public_url AS standby_public_url,
              standby_artifact.image_digest AS standby_digest
       FROM projects AS project
       JOIN deployments AS active ON active.id = $2 AND active.project_id = project.id
       JOIN environments AS active_environment ON active_environment.id = active.target_environment_id
       JOIN build_artifacts AS active_artifact ON active_artifact.deployment_id = active.id
       JOIN deployments AS standby ON standby.id = $3
       JOIN environments AS standby_environment ON standby_environment.id = standby.target_environment_id
       JOIN build_artifacts AS standby_artifact ON standby_artifact.deployment_id = standby.id
       WHERE project.id = $1`,
      [input.projectId, input.activeDeploymentId, input.standbyDeploymentId],
    );
    const row = result.rows[0];
    if (!row) throw new OriginActivationError("ORIGIN_FAILOVER_TARGET_MISSING");
    return row;
  }

  private assertAwsStandbyContext(
    row: AwsStandbyContext,
    input: {
      projectId: number;
      activeDeploymentId: number;
      standbyDeploymentId: number;
    },
  ): void {
    if (
      String(row.project_id) !== String(input.projectId) ||
      String(row.standby_project_id) !== String(input.projectId) ||
      String(row.active_deployment_id) !== String(input.activeDeploymentId) ||
      String(row.active_failover_target_id) !== String(input.standbyDeploymentId) ||
      row.active_status !== "succeeded" ||
      row.standby_status !== "succeeded" ||
      row.active_environment_type !== "onprem" ||
      row.standby_environment_type !== "aws" ||
      !row.active_digest ||
      row.active_digest !== row.standby_digest ||
      !row.standby_public_url
    ) {
      throw new OriginActivationError("ORIGIN_FAILOVER_TARGET_MISMATCH");
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

/** 프로젝트 공개 호스트 이름 — 예전 row(subdomain 없음)는 service-{id}. DNS 레이블이 아니면 거부 */
function projectServiceHostname(
  subdomain: string | null | undefined,
  projectId: number | string,
  domain: string,
): string {
  const label = projectSubdomain(subdomain, projectId).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
    throw new OriginActivationError("ORIGIN_SUBDOMAIN_INVALID");
  }
  return buildServiceHostname(label, domain);
}

function isTargetVerified(
  message: string | null,
  payload: VerifyJobPayload,
): boolean {
  if (!message) return false;
  try {
    const parsed: unknown = JSON.parse(message);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const result = VerifyResultSchema.safeParse(Reflect.get(parsed, "targetResult"));
    return result.success &&
      result.data.status === "passed" &&
      result.data.deploymentId === payload.deploymentId &&
      result.data.environmentId === payload.environmentId &&
      result.data.targetUrl === buildHealthUrl(payload.targetUrl, payload.health.path);
  } catch {
    return false;
  }
}

/**
 * AWS 프로필이 Terraform 출력으로 돌려주는 origin 만 공개 주소 CNAME 대상으로 받는다.
 * 프로필을 추가하면 여기에 그 endpoint 형식을 더한다.
 */
const AWS_ORIGIN_HOSTNAMES = [
  // aws-ecs-basic: ALB
  /\.elb\.amazonaws\.com(?:\.cn)?$/,
  // aws-static-basic (#274): S3 웹사이트 endpoint (리전에 따라 s3-website.<region> 또는 s3-website-<region>)
  /^[a-z0-9.-]+\.s3-website[.-][a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/,
];

function awsOriginHostname(value: string): string {
  const url = safeUrl(value);
  if (!["http:", "https:"].includes(url.protocol) || url.port ||
      !AWS_ORIGIN_HOSTNAMES.some((pattern) => pattern.test(url.hostname))) {
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
