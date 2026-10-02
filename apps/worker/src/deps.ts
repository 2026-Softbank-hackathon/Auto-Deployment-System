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
import type { EcsRolloutWaiter } from "./ecs-rollout.js";
import type { LambdaRolloutWaiter } from "./lambda-rollout.js";
import type { StaticSitePublisher } from "./static-site-publisher.js";

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
  terraformCli?: Pick<TerraformCli, "apply" | "destroy" | "fingerprint" | "output">;
  terraformBackend?: TerraformBackendConfig;
  terraformModuleRoot?: string;
  /** 앱 삭제 때 Terraform state 파일 확인 · 삭제 (#247) */
  terraformStateStore?: TerraformStateStore;
  /** Terraform apply 뒤 ECS 롤아웃 완료 대기 (#253) */
  ecsRolloutWaiter?: Pick<EcsRolloutWaiter, "wait">;
  /** aws-lambda-basic: Terraform apply 뒤 Lambda 갱신 완료 대기 (#282) */
  lambdaRolloutWaiter?: Pick<LambdaRolloutWaiter, "wait">;
  originActivator?: Pick<
    DeploymentOriginActivator,
    | "activate" | "prepareOnpremVerification" | "rollback" | "removeProjectOrigins"
    // 앱 주소 변경 (#301)
    | "addServiceAlias" | "removeServiceAlias" | "removeServiceHostname"
  >;
  finalUrlVerifier?: Pick<FinalUrlVerifier, "verify">;
  /** 플랫폼 공개 도메인 (DEMO_PLATFORM_DOMAIN) — 정적 사이트 버킷 이름 = {앱 주소}.{도메인} (#274, #300) */
  platformDomain?: string;
  /** 정적 사이트: 이미지에서 파일을 꺼내 S3 와 맞춘다 (#274) */
  staticSitePublisher?: Pick<StaticSitePublisher, "publish">;
  /** 정적 사이트: 버킷 정책이 직접 검증을 받도록 워커 공인 IP 확인 (#274) */
  egressIpResolver?: () => Promise<string | null>;
  dnsActivationChecker?: Pick<PublicDnsActivationChecker, "waitUntilResolvable">;
  /** 프로젝트 삭제 시 Agent cleanup 확인 대기 설정. 테스트에서는 sleep을 주입할 수 있다. */
  onpremCleanupWait?: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    sleep?: (milliseconds: number) => Promise<void>;
  };
};
