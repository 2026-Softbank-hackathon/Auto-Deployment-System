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

/** IR resources 한 개. 환경이 만들어 주지 않으면 앱이 localFallback 저장소로 실행된다 */
export type ResourcePlan = {
  name: string;
  type: "postgres" | "mysql" | "redis" | "object_storage";
  /** 접속 정보를 주입할 환경변수 이름 */
  connectionEnv?: string;
  localFallback?: "sqlite";
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
  resources: ResourcePlan[];
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

/** 서버리스 배포 형태 — 같은 이미지를 Lambda(+ Lambda Web Adapter)로, 공개 origin 은 ALB */
export type AwsLambdaDeploymentPlan = CommonDeploymentPlan & {
  target: "aws";
  runtime: {
    type: "lambda";
    region: string;
    memoryMiB: number;
    timeoutSeconds: number;
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
  | AwsLambdaDeploymentPlan
  | OnpremDockerDeploymentPlan;
