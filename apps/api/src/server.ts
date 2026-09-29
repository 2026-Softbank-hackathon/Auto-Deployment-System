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

import { ProjectService } from "./services/project-service.js";
import { DeploymentService } from "./services/deployment-service.js";
import { IrService } from "./services/ir-service.js";
import { ApprovalService } from "./services/approval-service.js";

import projectsRoutes from "./routes/projects.js";
import deploymentsRoutes from "./routes/deployments.js";
import deploymentEventsRoutes from "./routes/deployment-events.js";
import deploymentIrRoutes from "./routes/deployment-ir.js";
import deploymentMissingRoutes from "./routes/deployment-missing.js";
import deploymentApprovalsRoutes from "./routes/deployment-approvals.js";

export interface BuildServerOptions {
  pool: Pool;
  boss: PgBoss;
  storage: Storage;
  apiKey?: string;
  nodeEnv?: string;
  logLevel?: string;
  logger?: boolean;
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
  await fastify.register(authPlugin, { apiKey: opts.apiKey, nodeEnv: opts.nodeEnv });
  await fastify.register(multipartPlugin);
  await fastify.register(sseBrokerPlugin);

  // Wait for plugins to be ready before accessing decorators
  await fastify.after();

  // ── services ───────────────────────────────────────────────────────────────
  const projectService = new ProjectService(opts.pool);
  const deploymentService = new DeploymentService(opts.pool, opts.boss, opts.storage);
  const irService = new IrService(opts.pool);
  const approvalService = new ApprovalService(opts.pool);
  const sseBroker = fastify.sseBroker;

  // ── health check ───────────────────────────────────────────────────────────
  fastify.get("/health", async () => ({ status: "ok" }));

  // ── routes under /api/v1 ───────────────────────────────────────────────────
  fastify.register(async (v1) => {
    v1.register(projectsRoutes, {
      prefix: "/projects",
      projectService,
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
    });
  }, { prefix: "/api/v1" });

  return fastify;
}
