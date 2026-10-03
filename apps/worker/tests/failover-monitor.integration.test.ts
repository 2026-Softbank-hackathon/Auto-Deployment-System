import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "@camellia/db";
import { MIGRATION_FILES } from "@camellia/db/migrations";
import {
  FailoverMonitor,
  PostgresFailoverStore,
  type FailoverConfig,
} from "../src/failover-monitor.js";

const databaseUrl = process.env["FAILOVER_TEST_DATABASE_URL"];
const schema = `failover_${randomUUID().replaceAll("-", "")}`;
const digest = `sha256:${"a".repeat(64)}`;
const config: FailoverConfig = {
  enabled: true,
  checkIntervalMs: 2_000,
  heartbeatIntervalMs: 2_000,
  agentTimeoutMs: 8_000,
  publicFailureThreshold: 3,
  candidateRequiredPasses: 3,
  candidateMaxAttempts: 8,
  probeIntervalMs: 2_000,
  cooldownMs: 300_000,
};

let admin: Pool;
let pool: Pool;

describe.skipIf(!databaseUrl)("automatic failover: isolated PostgreSQL (#349)", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    for (const file of MIGRATION_FILES) {
      await pool.query(await readFile(
        new URL(`../../../packages/db/migrations/${file}`, import.meta.url),
        "utf8",
      ));
    }
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it("stale Agent와 공개 URL 실패를 확인한 뒤 명시된 AWS Standby를 active로 바꾼다", async () => {
    const project = await pool.query<{ id: string }>(
      `INSERT INTO projects (name, subdomain) VALUES ('failover-app', 'failover-app') RETURNING id`,
    );
    const projectId = Number(project.rows[0]!.id);
    const environments = await pool.query<{ id: string; type: string }>(
      `INSERT INTO environments (project_id, name, type, onprem_config, aws_config)
       VALUES ($1, 'aws', 'aws', NULL, '{}'::jsonb),
              ($1, 'mac', 'onprem', '{}'::jsonb, NULL)
       RETURNING id, type`,
      [projectId],
    );
    const awsEnvironmentId = Number(environments.rows.find((row) => row.type === "aws")!.id);
    const onpremEnvironmentId = Number(environments.rows.find((row) => row.type === "onprem")!.id);
    const aws = await pool.query<{ id: string }>(
      `INSERT INTO deployments
         (project_id, status, target_profile, target_environment_id, public_url, succeeded_at)
       VALUES ($1, 'succeeded', 'aws-ecs-basic', $2,
               'http://demo.ap-northeast-2.elb.amazonaws.com', NOW())
       RETURNING id`,
      [projectId, awsEnvironmentId],
    );
    const awsDeploymentId = Number(aws.rows[0]!.id);
    const onprem = await pool.query<{ id: string }>(
      `INSERT INTO deployments
         (project_id, status, target_profile, target_environment_id, public_url,
          succeeded_at, failover_target_deployment_id)
       VALUES ($1, 'succeeded', 'onprem-docker-basic', $2,
               'https://verify-d1.camellia-deploy.app', NOW(), $3)
       RETURNING id`,
      [projectId, onpremEnvironmentId, awsDeploymentId],
    );
    const onpremDeploymentId = Number(onprem.rows[0]!.id);
    await pool.query(
      `UPDATE projects SET active_deployment_id = $2 WHERE id = $1`,
      [projectId, onpremDeploymentId],
    );
    for (const deploymentId of [awsDeploymentId, onpremDeploymentId]) {
      await pool.query(
        `INSERT INTO build_artifacts
           (deployment_id, repository_uri, image_tag, image_digest, immutable_ref, platform, strategy)
         VALUES ($1, 'example.ecr/app', 'v1', $2, 'example.ecr/app@' || $2, 'linux/amd64', 'dockerfile')`,
        [deploymentId, digest],
      );
    }
    await pool.query(
      `INSERT INTO ir_versions (deployment_id, ir_json, source)
       VALUES ($1, $2::jsonb, 'analyzer')`,
      [onpremDeploymentId, JSON.stringify({ resources: {} })],
    );
    await pool.query(
      `INSERT INTO onprem_agent_jobs
         (job_id, deployment_id, environment_id, status, payload)
       VALUES ('job-onprem', $1, $2, 'ready_for_verify', $3::jsonb)`,
      [onpremDeploymentId, onpremEnvironmentId, JSON.stringify({
        plan: {
          health: { path: "/health", expectedStatus: 200, timeoutSeconds: 1 },
        },
      })],
    );
    await pool.query(
      `INSERT INTO agents (environment_id, long_lived_key_hash, last_seen_at)
       VALUES ($1, 'hash', NOW() - INTERVAL '1 minute')`,
      [onpremEnvironmentId],
    );

    const activateAwsStandby = vi.fn(async () => ({
      serviceHostname: "failover-app.camellia-deploy.app",
      activatedOrigin: "demo.ap-northeast-2.elb.amazonaws.com",
      previousOrigin: { hostname: "tunnel.cfargotunnel.com", proxied: true },
      tunnelIngress: null,
    }));
    const monitor = new FailoverMonitor({
      store: new PostgresFailoverStore(pool, "camellia-deploy.app"),
      originActivator: {
        activateAwsStandby,
        rollback: vi.fn(async () => undefined),
      },
      finalUrlVerifier: {
        verify: vi.fn(async () => ({
          deploymentId: awsDeploymentId,
          environmentId: String(awsEnvironmentId),
          status: "passed" as const,
          targetUrl: "https://failover-app.camellia-deploy.app/health",
          checks: [],
          consecutivePassed: 3,
          requiredPasses: 3 as const,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 1,
        })),
      },
      probe: vi.fn(async (url) => !url.includes("camellia-deploy.app")),
      config,
      sleep: async () => undefined,
    });

    await monitor.runOnce();

    expect(activateAwsStandby).toHaveBeenCalledWith({
      projectId,
      activeDeploymentId: onpremDeploymentId,
      standbyDeploymentId: awsDeploymentId,
    });
    const active = await pool.query<{ active_deployment_id: string }>(
      `SELECT active_deployment_id FROM projects WHERE id = $1`,
      [projectId],
    );
    expect(Number(active.rows[0]!.active_deployment_id)).toBe(awsDeploymentId);
  });
});
