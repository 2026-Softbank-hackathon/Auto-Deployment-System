import {
  projectSubdomain,
  serviceHostname as buildServiceHostname,
} from "@camellia/contracts";
import type { Pool } from "@camellia/db";
import type { Logger } from "pino";
import type { OriginActivationReceipt } from "./origin-activation.js";
import type { FinalUrlVerifier } from "./final-url-verifier.js";
import {
  buildHealthUrl,
  executeHealthCheck,
  type VerifyRuntime,
} from "./handlers/verify.js";

export type FailoverHealth = {
  path: string;
  expectedStatus: number;
  timeoutMs: number;
};

export type FailoverCandidate = {
  projectId: number;
  activeDeploymentId: number;
  standbyDeploymentId: number;
  activeStatus: string;
  standbyStatus: string;
  activeEnvironmentType: string;
  standbyEnvironmentType: string;
  activeDigest: string | null;
  standbyDigest: string | null;
  hasStatefulResources: boolean;
  agentLastSeenAt: Date | null;
  serviceHostname: string;
  standbyTargetUrl: string;
  standbyEnvironmentId: string;
  health: FailoverHealth;
};

export type FailoverLockedStore = {
  loadCandidate(): Promise<FailoverCandidate | null>;
  markStandbyActive(
    expectedActiveDeploymentId: number,
    standbyDeploymentId: number,
  ): Promise<boolean>;
};

export type FailoverStore = {
  listCandidates(): Promise<FailoverCandidate[]>;
  withProjectLock(
    projectId: number,
    task: (locked: FailoverLockedStore) => Promise<void>,
  ): Promise<boolean>;
};

export type FailoverConfig = {
  enabled: boolean;
  checkIntervalMs: number;
  heartbeatIntervalMs: number;
  agentTimeoutMs: number;
  publicFailureThreshold: number;
  candidateRequiredPasses: number;
  candidateMaxAttempts: number;
  probeIntervalMs: number;
  cooldownMs: number;
};

type HealthProbe = (
  url: string,
  health: FailoverHealth,
  attempt: number,
  signal?: AbortSignal,
) => Promise<boolean>;

type FailoverOriginActivator = {
  activateAwsStandby(input: {
    projectId: number;
    activeDeploymentId: number;
    standbyDeploymentId: number;
  }): Promise<OriginActivationReceipt>;
  rollback(receipt: OriginActivationReceipt): Promise<void>;
};

type FailoverMonitorDeps = {
  store: FailoverStore;
  originActivator: FailoverOriginActivator;
  finalUrlVerifier: Pick<FinalUrlVerifier, "verify">;
  probe?: HealthProbe;
  config: FailoverConfig;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  log?: Pick<Logger, "info" | "warn" | "error">;
};

type FailoverCandidateRow = {
  project_id: number | string;
  project_subdomain: string | null;
  active_deployment_id: number | string;
  standby_deployment_id: number | string;
  active_status: string;
  standby_status: string;
  active_environment_type: string;
  standby_environment_type: string;
  active_digest: string | null;
  standby_digest: string | null;
  has_stateful_resources: boolean;
  agent_last_seen_at: Date | string | null;
  standby_target_url: string;
  standby_environment_id: number | string;
  health_path: string;
  health_expected_status: number | string;
  health_timeout_seconds: number | string;
};

const FAILOVER_CANDIDATE_SQL = `
  SELECT project.id AS project_id,
         project.subdomain AS project_subdomain,
         active.id AS active_deployment_id,
         standby.id AS standby_deployment_id,
         active.status AS active_status,
         standby.status AS standby_status,
         active_environment.type AS active_environment_type,
         standby_environment.type AS standby_environment_type,
         active_artifact.image_digest AS active_digest,
         standby_artifact.image_digest AS standby_digest,
         EXISTS (
           SELECT 1
           FROM jsonb_each(COALESCE(active_ir.ir_json -> 'resources', '{}'::jsonb))
         ) AS has_stateful_resources,
         agent.last_seen_at AS agent_last_seen_at,
         standby.public_url AS standby_target_url,
         standby.target_environment_id AS standby_environment_id,
         agent_job.payload #>> '{plan,health,path}' AS health_path,
         agent_job.payload #>> '{plan,health,expectedStatus}' AS health_expected_status,
         agent_job.payload #>> '{plan,health,timeoutSeconds}' AS health_timeout_seconds
  FROM projects AS project
  JOIN deployments AS active ON active.id = project.active_deployment_id
  JOIN environments AS active_environment ON active_environment.id = active.target_environment_id
  JOIN deployments AS standby ON standby.id = active.failover_target_deployment_id
  JOIN environments AS standby_environment ON standby_environment.id = standby.target_environment_id
  JOIN build_artifacts AS active_artifact ON active_artifact.deployment_id = active.id
  JOIN build_artifacts AS standby_artifact ON standby_artifact.deployment_id = standby.id
  JOIN onprem_agent_jobs AS agent_job ON agent_job.deployment_id = active.id
  LEFT JOIN agents AS agent ON agent.environment_id = active.target_environment_id
  LEFT JOIN LATERAL (
    SELECT ir_json
    FROM ir_versions
    WHERE deployment_id = active.id
    ORDER BY id DESC
    LIMIT 1
  ) AS active_ir ON TRUE
  WHERE project.deletion_status IS NULL
    AND active.failover_target_deployment_id IS NOT NULL
    AND standby.public_url IS NOT NULL`;

function positiveInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function loadFailoverConfig(
  environment: NodeJS.ProcessEnv = process.env,
): FailoverConfig {
  const heartbeatIntervalMs = positiveInteger(
    environment,
    "FAILOVER_AGENT_HEARTBEAT_INTERVAL_MS",
    2_000,
  );
  const agentTimeoutMs = positiveInteger(
    environment,
    "FAILOVER_AGENT_TIMEOUT_MS",
    8_000,
  );
  if (agentTimeoutMs < heartbeatIntervalMs * 3) {
    throw new Error(
      "FAILOVER_AGENT_TIMEOUT_MS must be at least three heartbeat intervals",
    );
  }
  return {
    enabled: environment.FAILOVER_ENABLED?.trim().toLowerCase() === "true",
    checkIntervalMs: positiveInteger(
      environment,
      "FAILOVER_CHECK_INTERVAL_MS",
      2_000,
    ),
    heartbeatIntervalMs,
    agentTimeoutMs,
    publicFailureThreshold: positiveInteger(
      environment,
      "FAILOVER_PUBLIC_FAILURE_THRESHOLD",
      3,
    ),
    candidateRequiredPasses: 3,
    candidateMaxAttempts: 8,
    probeIntervalMs: positiveInteger(
      environment,
      "FAILOVER_PROBE_INTERVAL_MS",
      2_000,
    ),
    cooldownMs: positiveInteger(
      environment,
      "FAILOVER_COOLDOWN_MS",
      5 * 60 * 1_000,
    ),
  };
}

export function isEligibleFailoverCandidate(
  candidate: FailoverCandidate,
): boolean {
  return candidate.activeStatus === "succeeded" &&
    candidate.standbyStatus === "succeeded" &&
    candidate.activeEnvironmentType === "onprem" &&
    candidate.standbyEnvironmentType === "aws" &&
    candidate.activeDigest !== null &&
    candidate.activeDigest === candidate.standbyDigest &&
    !candidate.hasStatefulResources;
}

export class PostgresFailoverStore implements FailoverStore {
  constructor(
    private readonly pool: Pool,
    private readonly platformDomain: string,
  ) {}

  async listCandidates(): Promise<FailoverCandidate[]> {
    const result = await this.pool.query<FailoverCandidateRow>(
      FAILOVER_CANDIDATE_SQL,
    );
    return result.rows.flatMap((row) => {
      const candidate = this.toCandidate(row);
      return candidate ? [candidate] : [];
    });
  }

  async withProjectLock(
    projectId: number,
    task: (locked: FailoverLockedStore) => Promise<void>,
  ): Promise<boolean> {
    const client = await this.pool.connect();
    const lockKey = `camellia-failover:${projectId}`;
    let acquired = false;
    try {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
        [lockKey],
      );
      acquired = result.rows[0]?.acquired === true;
      if (!acquired) return false;
      await task({
        loadCandidate: async () => {
          const current = await client.query<FailoverCandidateRow>(
            `${FAILOVER_CANDIDATE_SQL} AND project.id = $1`,
            [projectId],
          );
          const row = current.rows[0];
          return row ? this.toCandidate(row) : null;
        },
        markStandbyActive: async (
          expectedActiveDeploymentId,
          standbyDeploymentId,
        ) => {
          const updated = await client.query(
            `UPDATE projects
             SET active_deployment_id = $3, updated_at = NOW()
             WHERE id = $1 AND active_deployment_id = $2
             RETURNING id`,
            [projectId, expectedActiveDeploymentId, standbyDeploymentId],
          );
          return updated.rows.length === 1;
        },
      });
      return true;
    } finally {
      if (acquired) {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey])
          .catch(() => undefined);
      }
      client.release();
    }
  }

  private toCandidate(row: FailoverCandidateRow): FailoverCandidate | null {
    const projectId = Number(row.project_id);
    const activeDeploymentId = Number(row.active_deployment_id);
    const standbyDeploymentId = Number(row.standby_deployment_id);
    const expectedStatus = Number(row.health_expected_status);
    const timeoutSeconds = Number(row.health_timeout_seconds);
    if (
      !Number.isSafeInteger(projectId) || projectId < 1 ||
      !Number.isSafeInteger(activeDeploymentId) || activeDeploymentId < 1 ||
      !Number.isSafeInteger(standbyDeploymentId) || standbyDeploymentId < 1 ||
      !row.health_path?.startsWith("/") ||
      !Number.isInteger(expectedStatus) || expectedStatus < 100 || expectedStatus > 599 ||
      !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0
    ) {
      return null;
    }
    return {
      projectId,
      activeDeploymentId,
      standbyDeploymentId,
      activeStatus: row.active_status,
      standbyStatus: row.standby_status,
      activeEnvironmentType: row.active_environment_type,
      standbyEnvironmentType: row.standby_environment_type,
      activeDigest: row.active_digest,
      standbyDigest: row.standby_digest,
      hasStatefulResources: row.has_stateful_resources === true,
      agentLastSeenAt: row.agent_last_seen_at === null
        ? null
        : new Date(row.agent_last_seen_at),
      serviceHostname: buildServiceHostname(
        projectSubdomain(row.project_subdomain, projectId),
        this.platformDomain,
      ),
      standbyTargetUrl: row.standby_target_url,
      standbyEnvironmentId: String(row.standby_environment_id),
      health: {
        path: row.health_path,
        expectedStatus,
        timeoutMs: timeoutSeconds * 1_000,
      },
    };
  }
}

export class FailoverMonitor {
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly probe: HealthProbe;
  private readonly cooldownUntil = new Map<number, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(private readonly deps: FailoverMonitorDeps) {
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.probe = deps.probe ?? (async (url, health, attempt, signal) => {
      const result = await executeHealthCheck(
        url,
        health.expectedStatus,
        health.timeoutMs,
        attempt,
        signal,
      );
      return result.passed;
    });
  }

  async start(): Promise<void> {
    if (!this.deps.config.enabled || this.timer) return;
    await this.runOnce();
    this.timer = setInterval(
      () => void this.runOnce(),
      this.deps.config.checkIntervalMs,
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(): Promise<void> {
    if (!this.deps.config.enabled || this.running) return;
    this.running = true;
    try {
      const candidates = await this.deps.store.listCandidates();
      for (const candidate of candidates) {
        try {
          await this.evaluate(candidate);
        } catch (error) {
          this.deps.log?.error(
            { project_id: candidate.projectId, err: error },
            "automatic failover evaluation failed",
          );
        }
      }
    } catch (error) {
      this.deps.log?.warn({ err: error }, "automatic failover scan failed");
    } finally {
      this.running = false;
    }
  }

  private async evaluate(initial: FailoverCandidate): Promise<void> {
    if (!this.shouldEvaluate(initial)) return;
    await this.deps.store.withProjectLock(initial.projectId, async (locked) => {
      const candidate = await locked.loadCandidate();
      if (!candidate || !this.shouldEvaluate(candidate)) return;

      const publicUrl = buildHealthUrl(
        `https://${candidate.serviceHostname}`,
        candidate.health.path,
      );
      const publicFailed = await this.hasConsecutiveFailures(
        publicUrl,
        candidate.health,
      );
      if (!publicFailed) return;

      this.cooldownUntil.set(
        candidate.projectId,
        this.now().getTime() + this.deps.config.cooldownMs,
      );
      this.deps.log?.warn(
        {
          project_id: candidate.projectId,
          active_deployment_id: candidate.activeDeploymentId,
          standby_deployment_id: candidate.standbyDeploymentId,
        },
        "on-prem outage confirmed; automatic AWS failover started",
      );

      const standbyUrl = buildHealthUrl(
        candidate.standbyTargetUrl,
        candidate.health.path,
      );
      if (!await this.hasConsecutiveSuccesses(standbyUrl, candidate.health)) {
        this.deps.log?.warn(
          { project_id: candidate.projectId },
          "automatic failover aborted; AWS standby health check failed",
        );
        return;
      }

      let activation: OriginActivationReceipt | undefined;
      try {
        activation = await this.deps.originActivator.activateAwsStandby({
          projectId: candidate.projectId,
          activeDeploymentId: candidate.activeDeploymentId,
          standbyDeploymentId: candidate.standbyDeploymentId,
        });
        const finalResult = await this.deps.finalUrlVerifier.verify(
          {
            deploymentId: candidate.standbyDeploymentId,
            environmentId: candidate.standbyEnvironmentId,
            serviceHostname: candidate.serviceHostname,
            health: candidate.health,
          },
          { sleep: this.sleep } satisfies VerifyRuntime,
        );
        if (finalResult.status !== "passed") {
          await this.deps.originActivator.rollback(activation);
          return;
        }
        const marked = await locked.markStandbyActive(
          candidate.activeDeploymentId,
          candidate.standbyDeploymentId,
        );
        if (!marked) {
          await this.deps.originActivator.rollback(activation);
          return;
        }
        this.deps.log?.info(
          {
            project_id: candidate.projectId,
            active_deployment_id: candidate.standbyDeploymentId,
          },
          "automatic AWS failover completed",
        );
      } catch (error) {
        if (activation) {
          await this.deps.originActivator.rollback(activation).catch(
            (rollbackError) => this.deps.log?.error(
              { project_id: candidate.projectId, err: rollbackError },
              "automatic failover origin rollback failed",
            ),
          );
        }
        throw error;
      }
    });
  }

  private shouldEvaluate(candidate: FailoverCandidate): boolean {
    if (!isEligibleFailoverCandidate(candidate)) return false;
    if ((this.cooldownUntil.get(candidate.projectId) ?? 0) > this.now().getTime()) {
      return false;
    }
    const lastSeenAt = candidate.agentLastSeenAt?.getTime() ?? 0;
    return this.now().getTime() - lastSeenAt >= this.deps.config.agentTimeoutMs;
  }

  private async hasConsecutiveFailures(
    url: string,
    health: FailoverHealth,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= this.deps.config.publicFailureThreshold; attempt += 1) {
      if (await this.probe(url, health, attempt)) return false;
      if (attempt < this.deps.config.publicFailureThreshold) {
        await this.sleep(this.deps.config.probeIntervalMs);
      }
    }
    return true;
  }

  private async hasConsecutiveSuccesses(
    url: string,
    health: FailoverHealth,
  ): Promise<boolean> {
    let consecutive = 0;
    for (let attempt = 1; attempt <= this.deps.config.candidateMaxAttempts; attempt += 1) {
      consecutive = await this.probe(url, health, attempt) ? consecutive + 1 : 0;
      if (consecutive >= this.deps.config.candidateRequiredPasses) return true;
      if (attempt < this.deps.config.candidateMaxAttempts) {
        await this.sleep(this.deps.config.probeIntervalMs);
      }
    }
    return false;
  }
}
