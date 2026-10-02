import type { IrServiceType } from "@camellia/ir-schema";

export type BuildPlan = {
  context: string;
  dockerfile?: string;
  buildpack?: "railpack";
  /** 정적 사이트 (#273) — 빌드 결과를 nginx 이미지 하나로 만든다. 있으면 dockerfile · buildpack 대신 쓴다 */
  staticSite?: StaticSiteBuildPlan;
};

export type StaticSiteBuildPlan = {
  /** 한 줄 빌드 명령. 없으면 context 를 그대로 서빙 */
  buildCommand?: string;
  /** context 기준 서빙할 폴더 */
  outputDir: string;
  /** 없는 경로를 index.html 로 응답 */
  spaFallback: boolean;
  /** nginx 가 듣는 포트 (= service.containerPort) */
  listenPort: number;
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
  type: "alb" | "cloudflare-tunnel" | "cloudflare-proxy";
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

/** 정적 사이트 on AWS (#273) — 서버 없이 S3 웹사이트 호스팅. 파일은 빌드한 이미지에서 꺼내 동기화한다 */
export type AwsStaticDeploymentPlan = CommonDeploymentPlan & {
  target: "aws";
  runtime: {
    type: "s3-website";
    region: string;
  };
  provisioning: {
    engine: "terraform";
    moduleRef: string;
    variables: Record<string, string | number | boolean>;
  };
};

export type DeploymentPlan =
  | AwsEcsDeploymentPlan
  | AwsLambdaDeploymentPlan
  | AwsStaticDeploymentPlan
  | OnpremDockerDeploymentPlan;
