import type { IrServiceType } from "@camellia/ir-schema";

export type BuildPlan = {
  context: string;
  dockerfile?: string;
  buildpack?: "railpack";
};

export type HealthPlan = {
  path: string;
  expectedStatus: number;
  timeoutSeconds: number;
};

export type RoutePlan = {
  path: string;
  service: string;
  port: number;
};

export type IngressPlan = {
  enabled: boolean;
  exposure: "public" | "internal" | "none";
  type: "alb" | "cloudflare-tunnel";
  tls: boolean;
  domain?: string;
  routes: RoutePlan[];
};

export type ServicePlan = {
  name: string;
  type: IrServiceType;
  command?: string[];
  containerPort: number;
  environmentNames: string[];
  /**
   * 분석기가 `.env.example` 에서 추출한 default 값 매핑.
   * 원클릭 복원 (이슈 #137): provision 이 user env_vars 미등록 시 fallback.
   */
  environmentDefaults: Record<string, string>;
  secretNames: string[];
  compute: {
    vcpu: number;
    memoryMiB: number;
  };
};

export type CommonDeploymentPlan = {
  schemaVersion: "0.1.0";
  profile: {
    id: string;
    version: string;
  };
  application: {
    name: string;
    version: string;
  };
  build: BuildPlan;
  service: ServicePlan;
  health: HealthPlan;
  ingress: IngressPlan;
};

export type AwsEcsDeploymentPlan = CommonDeploymentPlan & {
  target: "aws";
  runtime: {
    type: "ecs-fargate";
    region: string;
    taskCpu: number;
    taskMemoryMiB: number;
    desiredCount: number;
  };
  provisioning: {
    engine: "terraform";
    moduleRef: string;
    variables: Record<string, string | number | boolean>;
  };
};

export type OnpremDockerDeploymentPlan = CommonDeploymentPlan & {
  target: "onprem";
  runtime: {
    type: "docker-compose";
    cpus: number;
    memoryMiB: number;
    replicas: number;
  };
  provisioning: {
    engine: "docker-compose";
    projectName: string;
  };
};

export type DeploymentPlan =
  | AwsEcsDeploymentPlan
  | OnpremDockerDeploymentPlan;
