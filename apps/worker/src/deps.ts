/**
 * apps/worker/src/deps.ts
 *
 * WorkerDeps 타입 정의 — 핸들러에 주입되는 의존성 모음.
 */

import type { Pool } from "@camellia/db";
import type PgBoss from "pg-boss";
import type { Storage } from "@camellia/storage";
import type { Notifier } from "./notifier.js";
import type { Logger } from "pino";
import type { BuildHandler } from "@camellia/build-handler";
import type {
  AwsAccessKeyCredentials,
  AwsEcrRegistry,
} from "@camellia/aws-registry";
import type { ProjectSecretReader } from "./secret-reader.js";
import type { RegistrySession } from "./docker-registry-session.js";
import type { TerraformBackendConfig, TerraformCli } from "./terraform-cli.js";
import type { DeploymentOriginActivator } from "./origin-activation.js";
import type { PublicDnsActivationChecker } from "./public-dns-activation.js";
import type { FinalUrlVerifier } from "./final-url-verifier.js";
import type { TerraformStateStore } from "./terraform-state-store.js";

export type AwsRegistryFactory = (input: {
  region: string;
  credentials: AwsAccessKeyCredentials;
}) => Pick<AwsEcrRegistry, "ensureProjectRepository" | "getAuthorization">;

export type WorkerDeps = {
  pool: Pool;
  boss: PgBoss;
  storage: Storage;
  notifier?: Notifier;
  log?: Logger;
  secretReader?: ProjectSecretReader;
  buildHandler?: Pick<BuildHandler, "build">;
  awsRegistryFactory?: AwsRegistryFactory;
  registrySession?: RegistrySession;
  terraformCli?: Pick<TerraformCli, "apply" | "destroy" | "fingerprint">;
  terraformBackend?: TerraformBackendConfig;
  terraformModuleRoot?: string;
  /** 앱 삭제 때 Terraform state 파일 확인 · 삭제 (#247) */
  terraformStateStore?: TerraformStateStore;
  originActivator?: Pick<
    DeploymentOriginActivator,
    "activate" | "prepareOnpremVerification" | "rollback" | "removeProjectOrigins"
  >;
  finalUrlVerifier?: Pick<FinalUrlVerifier, "verify">;
  dnsActivationChecker?: Pick<PublicDnsActivationChecker, "waitUntilResolvable">;
};
