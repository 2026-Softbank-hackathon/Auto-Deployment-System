/**
 * apps/api/src/server.ts
 * buildServer(opts) — Fastify 인스턴스 팩토리.
 * 테스트에서도 재사용 가능하도록 DB/storage/boss를 opts로 주입.
 */

import Fastify from "fastify";
import type { Pool } from "@camellia/db";
import type PgBoss from "pg-boss";
import type { Storage } from "@camellia/storage";

import requestIdPlugin from "./plugins/request-id.js";
import errorHandlerPlugin from "./plugins/error-handler.js";
import authPlugin from "./plugins/auth.js";
import multipartPlugin from "./plugins/multipart.js";
import sseBrokerPlugin from "./plugins/sse-broker.js";
import swaggerPlugin from "./plugins/swagger.js";
import { startPgListener } from "./plugins/pg-listener.js";

import { ProjectService } from "./services/project-service.js";
import { DeploymentService } from "./services/deployment-service.js";
import { IrService } from "./services/ir-service.js";
import { ApprovalService } from "./services/approval-service.js";
import { AnalysisReportService } from "./services/analysis-report-service.js";
import { LogService } from "./services/log-service.js";
import { DeploymentHealthService } from "./services/deployment-health-service.js";
import { DiagnosisService } from "./services/diagnosis-service.js";
import { AiUsageService } from "./services/ai-usage-service.js";
import { SecretService } from "./services/secret-service.js";
import { EnvironmentService } from "./services/environment-service.js";
import { EnvVarService } from "./services/env-var-service.js";
import { AgentService } from "./services/agent-service.js";

import projectsRoutes from "./routes/projects.js";
import agentsRoutes from "./routes/agents.js";
import projectEnvRoutes from "./routes/project-env.js";
import deploymentsRoutes from "./routes/deployments.js";
import deploymentEventsRoutes from "./routes/deployment-events.js";
import deploymentIrRoutes from "./routes/deployment-ir.js";
import deploymentMissingRoutes from "./routes/deployment-missing.js";
import deploymentApprovalsRoutes from "./routes/deployment-approvals.js";
import deploymentAnalysisReportRoutes from "./routes/deployment-analysis-report.js";
import deploymentLogsRoutes from "./routes/deployment-logs.js";
import deploymentHealthRoutes from "./routes/deployment-health.js";
import deploymentDiagnosisRoutes from "./routes/deployment-diagnosis.js";
import deploymentAiUsageRoutes from "./routes/deployment-ai-usage.js";
import secretsRoutes from "./routes/secrets.js";
import environmentsRoutes from "./routes/environments.js";
import authRoutes from "./routes/auth.js";
import { SessionService } from "./services/session-service.js";
import {
  AgentJobService,
  type TunnelManager,
} from "./services/agent-job-service.js";
import agentJobsRoutes, { type AgentIdentity } from "./routes/agent-jobs.js";

export interface BuildServerOptions {
  pool: Pool;
  boss: PgBoss;
  storage: Storage;
  apiKey?: string;
  nodeEnv?: string;
  logLevel?: string;
  logger?: boolean;
  /** Postgres LISTEN 채널. 제공 시 pg-listener를 시작한다. 기본값 "deployment_events" */
  pgListenChannel?: string;
  /** pg-listener를 명시적으로 비활성화하려면 false로 설정. 기본값 true */
  enablePgListener?: boolean;
  /** AES-256-GCM 마스터 키 (32바이트). 없으면 dev/test 랜덤 생성 (production 부팅 시 config 에서 강제). */
  secretMasterKey?: Buffer;
  /** API-01 세션 TTL(초). 기본 3600 */
  sessionTtlSec?: number;
  /** 플랫폼 도메인 (고정 서비스 URL 발급용). 예: `camellia.app`. 미세팅 시 publicUrl=null */
  platformDomain?: string;
  /** Agent bearer key 검증 함수. Agent 등록 API와 같은 인증기를 주입한다. */
  agentAuthenticator?: (token: string) => Promise<AgentIdentity | null>;
  /** Agent job long-poll 제한 시간 (테스트용 override 포함). 기본 20초 */
  agentJobPollTimeoutMs?: number;
  /** Agent job poll 간격 (테스트용 override 포함). 기본 500ms */
  agentJobPollIntervalMs?: number;
  /** 플랫폼 관리 Cloudflare Named Tunnel 클라이언트. */
  agentTunnelManager?: TunnelManager;
  cloudflareZoneId?: string;
}

export async function buildServer(opts: BuildServerOptions) {
  const fastify = Fastify({
    logger: opts.logger !== false
      ? {
          level: opts.logLevel ?? "info",
          transport:
            (opts.nodeEnv ?? "development") !== "production"
              ? { target: "pino-pretty", options: { colorize: true } }
              : undefined,
        }
      : false,
    genReqId: () =>
      `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 26)}`,
  });

  // ── plugins ────────────────────────────────────────────────────────────────
  await fastify.register(requestIdPlugin);
  await fastify.register(errorHandlerPlugin);
  await fastify.register(authPlugin, {
    apiKey: opts.apiKey,
    nodeEnv: opts.nodeEnv,
    agentJobClaimEnabled: true,
  });
  await fastify.register(multipartPlugin);
  await fastify.register(sseBrokerPlugin);
  await fastify.register(swaggerPlugin);

  // Wait for plugins to be ready before accessing decorators
  await fastify.after();

  // ── services ───────────────────────────────────────────────────────────────
  const projectService = new ProjectService(opts.pool);
  const deploymentService = new DeploymentService(opts.pool, opts.boss, opts.storage, opts.platformDomain);
  const irService = new IrService(opts.pool);
  const approvalService = new ApprovalService(opts.pool);
  const analysisReportService = new AnalysisReportService(opts.pool);
  const logService = new LogService(opts.pool, opts.storage);
  const deploymentHealthService = new DeploymentHealthService(opts.pool);
  const diagnosisService = new DiagnosisService(opts.pool);
  const aiUsageService = new AiUsageService(opts.pool);
  const secretMasterKey = opts.secretMasterKey ?? (await import("node:crypto")).randomBytes(32);
  const secretService = new SecretService(opts.pool, secretMasterKey);
  const environmentService = new EnvironmentService(opts.pool);
  const envVarService = new EnvVarService(opts.pool);
  const agentJobService = new AgentJobService(opts.pool, {
    tunnelManager: opts.agentTunnelManager,
    cloudflareZoneId: opts.cloudflareZoneId,
    platformDomain: opts.platformDomain,
    boss: opts.boss,
  });
  const sessionService = opts.apiKey
    ? new SessionService(opts.apiKey, opts.sessionTtlSec ?? 3600)
    : undefined;
  const agentService = new AgentService(opts.pool);
  const authenticateAgent = opts.agentAuthenticator ??
    ((token: string) => agentService.authenticate(token));
  const sseBroker = fastify.sseBroker;

  // ── pg-listener (LISTEN → SSE relay) ──────────────────────────────────────
  if (opts.enablePgListener !== false) {
    let unsubscribePg: (() => Promise<void>) | undefined;

    fastify.addHook("onReady", async () => {
      try {
        unsubscribePg = await startPgListener(opts.pool, {
          channel: opts.pgListenChannel ?? "deployment_events",
          onNotification: (raw) => {
            if (
              raw === null ||
              typeof raw !== "object" ||
              Array.isArray(raw)
            ) {
              return;
            }
            const msg = raw as Record<string, unknown>;
            const deploymentId = String(msg["deployment_id"] ?? "");
            const event = String(msg["event"] ?? "");
            const payload = msg["payload"] ?? {};
            if (!deploymentId || !event) return;
            sseBroker.publish(deploymentId, { event, data: payload });
          },
        });
        fastify.log.info({ channel: opts.pgListenChannel ?? "deployment_events" }, "pg-listener started");
      } catch (err) {
        // LISTEN 실패는 치명적이지 않다 — SSE 실시간 업데이트만 안 됨
        fastify.log.warn({ err }, "pg-listener failed to start; SSE relay disabled");
      }
    });

    fastify.addHook("onClose", async () => {
      if (unsubscribePg) {
        await unsubscribePg().catch(() => {});
        fastify.log.info("pg-listener stopped");
      }
    });
  }

  // ── health check ───────────────────────────────────────────────────────────
  fastify.get(
    "/health",
    { schema: { tags: ["system"], summary: "헬스 체크", security: [] } },
    async () => ({ status: "ok" }),
  );

  // ── routes under /api/v1 ───────────────────────────────────────────────────
  fastify.register(async (v1) => {
    v1.register(projectsRoutes, {
      prefix: "/projects",
      projectService,
    });

    v1.register(projectEnvRoutes, {
      prefix: "/projects",
      envVarService,
    });

    v1.register(deploymentsRoutes, {
      prefix: "/deployments",
      deploymentService,
    });

    v1.register(deploymentEventsRoutes, {
      prefix: "/deployments",
      sseBroker,
      pool: opts.pool,
    });

    v1.register(deploymentIrRoutes, {
      prefix: "/deployments",
      irService,
      sseBroker,
    });

    v1.register(deploymentMissingRoutes, {
      prefix: "/deployments",
      pool: opts.pool,
      sseBroker,
    });

    v1.register(deploymentApprovalsRoutes, {
      prefix: "/deployments",
      approvalService,
      sseBroker,
      boss: opts.boss,
    });

    v1.register(deploymentAnalysisReportRoutes, {
      prefix: "/deployments",
      analysisReportService,
    });

    v1.register(deploymentLogsRoutes, {
      prefix: "/deployments",
      logService,
    });

    v1.register(deploymentHealthRoutes, {
      prefix: "/deployments",
      deploymentHealthService,
    });

    v1.register(deploymentDiagnosisRoutes, {
      prefix: "/deployments",
      diagnosisService,
    });

    v1.register(deploymentAiUsageRoutes, {
      prefix: "/deployments",
      aiUsageService,
    });

    v1.register(secretsRoutes, {
      prefix: "/secrets",
      secretService,
    });

    v1.register(authRoutes, {
      prefix: "/auth",
      sessionService,
    });

    v1.register(environmentsRoutes, {
      prefix: "/environments",
      environmentService,
    });

    v1.register(agentsRoutes, {
      agentService,
      agentJobService,
    });

    v1.register(agentJobsRoutes, {
      prefix: "/agents",
      agentJobService,
      authenticate: authenticateAgent,
      pollTimeoutMs: opts.agentJobPollTimeoutMs,
      pollIntervalMs: opts.agentJobPollIntervalMs,
    });
  }, { prefix: "/api/v1" });

  return fastify;
}
