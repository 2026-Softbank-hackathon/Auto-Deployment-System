/**
 * apps/worker/src/main.ts
 *
 * 별도 프로세스 진입점.
 * DATABASE_URL, STORAGE_ROOT_DIR, AI_PROVIDER(또는 ANTHROPIC_API_KEY) 환경변수를 읽어
 * 의존성을 초기화하고 pg-boss 워커를 시작한다.
 */

import pino from "pino";
import { createPool, createPgBoss, getEnv } from "@camellia/db";
import { LocalStorage } from "@camellia/storage";
import { createPgNotifier } from "./notifier.js";
import { registerAll } from "./register.js";
import { BuildHandler } from "@camellia/build-handler";
import { AwsEcrRegistry } from "@camellia/aws-registry";
import {
  decodeWorkerSecretMasterKey,
  PostgresProjectSecretReader,
} from "./secret-reader.js";
import { DockerRegistrySession } from "./docker-registry-session.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TerraformCli } from "./terraform-cli.js";
import { loadTerraformBackendConfig } from "./terraform-config.js";
import { CloudflareClient } from "@camellia/cloudflare";
import { DeploymentOriginActivator } from "./origin-activation.js";
import { PublicDnsActivationChecker } from "./public-dns-activation.js";

const log = pino({ name: "worker" });

async function main(): Promise<void> {
  const { databaseUrl } = getEnv();

  const storageRootDir = process.env["STORAGE_ROOT_DIR"];
  if (!storageRootDir) {
    throw new Error("STORAGE_ROOT_DIR environment variable is required");
  }

  const pool = createPool(databaseUrl);
  const boss = createPgBoss(databaseUrl);
  const storage = new LocalStorage({ rootDir: storageRootDir });
  const notifier = createPgNotifier(pool);
  const secretReader = new PostgresProjectSecretReader(
    pool,
    decodeWorkerSecretMasterKey(process.env["SECRET_MASTER_KEY"]),
  );
  const buildHandler = new BuildHandler();
  const registrySession = new DockerRegistrySession();
  const cloudflareAccountId = process.env["CLOUDFLARE_ACCOUNT_ID"]?.trim();
  const cloudflareApiToken = process.env["CLOUDFLARE_API_TOKEN"]?.trim();
  const originActivator = new DeploymentOriginActivator(pool, {
    cloudflare: cloudflareAccountId && cloudflareApiToken
      ? new CloudflareClient({ accountId: cloudflareAccountId, apiToken: cloudflareApiToken })
      : undefined,
    zoneId: process.env["CLOUDFLARE_ZONE_ID"],
    platformDomain: process.env["DEMO_PLATFORM_DOMAIN"],
  });
  const dnsActivationChecker = new PublicDnsActivationChecker();
  const terraformCli = new TerraformCli({
    executable: process.env["TERRAFORM_BINARY"]?.trim() || "terraform",
  });
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const awsRegistryFactory = (input: {
    region: string;
    credentials: { accessKeyId: string; secretAccessKey: string };
  }) => new AwsEcrRegistry(input);

  const deps = {
    pool,
    boss,
    storage,
    notifier,
    log,
    secretReader,
    buildHandler,
    registrySession,
    originActivator,
    dnsActivationChecker,
    awsRegistryFactory,
    terraformCli,
    terraformBackend: loadTerraformBackendConfig(),
    terraformModuleRoot: path.join(repositoryRoot, "infra/terraform/profiles"),
  };

  boss.on("error", (err: unknown) => {
    log.error({ err }, "pg-boss error");
  });

  await boss.start();

  await registerAll(boss, deps);

  log.info("worker started — listening for jobs");

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, "shutting down worker");
    await boss.stop();
    await pool.end();
    log.info("worker stopped");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  log.error({ err }, "worker startup failed");
  process.exit(1);
});
