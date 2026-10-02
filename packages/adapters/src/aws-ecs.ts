import type { DeploymentAdapter } from "./adapter.js";
import { createCommonPlan } from "./common.js";
import { AdapterError } from "./errors.js";
import type { AwsEcsDeploymentPlan } from "./types.js";

/** IR 리소스에 connection_env 가 없을 때 PostgreSQL 접속 정보를 넣는 환경변수 */
const DEFAULT_DATABASE_ENV = "DATABASE_URL";

export const awsEcsAdapter: DeploymentAdapter = {
  profileId: "aws-ecs-basic",

  createPlan(ir, profile): AwsEcsDeploymentPlan {
    if (
      profile.cloud !== "aws" ||
      profile.runtime.type !== "ecs-fargate" ||
      profile.ingress.type !== "alb" ||
      !profile.default_region ||
      !profile.terraform_module_ref
    ) {
      throw new AdapterError(
        "PROFILE_CONFIGURATION_INVALID",
        `프로필 "${profile.id}"의 AWS ECS 설정이 올바르지 않습니다.`,
      );
    }

    // postgres 는 프로필 위에 RDS 추가 모듈로 만든다 (#278)
    const common = createCommonPlan(ir, profile, { managedResourceTypes: ["postgres"] });
    const region = ir.deploy.region ?? profile.default_region;
    const taskCpu = Math.round(common.service.compute.vcpu * 1024);

    const databases = common.resources.filter((resource) => resource.type === "postgres");
    if (databases.length > 1) {
      throw new AdapterError(
        "P0_RESOURCES_UNSUPPORTED",
        "aws-ecs-basic 은 PostgreSQL 리소스를 하나만 지원합니다.",
      );
    }
    const databaseEnvName = databases[0]
      ? (databases[0].connectionEnv ?? DEFAULT_DATABASE_ENV)
      : DEFAULT_DATABASE_ENV;

    return {
      ...common,
      service: {
        ...common.service,
        // 접속 정보는 모듈이 주입한다 — 사용자가 등록할 환경변수가 아니다
        environmentNames: databases.length > 0
          ? common.service.environmentNames.filter((name) => name !== databaseEnvName)
          : common.service.environmentNames,
      },
      target: "aws",
      runtime: {
        type: "ecs-fargate",
        region,
        taskCpu,
        taskMemoryMiB: common.service.compute.memoryMiB,
        desiredCount: profile.runtime.replicas,
      },
      provisioning: {
        engine: "terraform",
        moduleRef: profile.terraform_module_ref,
        variables: {
          app_name: common.application.name,
          region,
          container_port: common.service.containerPort,
          task_cpu: taskCpu,
          task_memory: common.service.compute.memoryMiB,
          desired_count: profile.runtime.replicas,
          health_check_path: common.health.path,
          health_check_expected_status: common.health.expectedStatus,
          public_ingress: common.ingress.exposure === "public",
          tls_enabled: common.ingress.tls,
          database_enabled: databases.length > 0,
          database_env_name: databaseEnvName,
        },
      },
    };
  },
};
