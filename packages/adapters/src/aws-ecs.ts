import type { DeploymentAdapter } from "./adapter.js";
import { createCommonPlan } from "./common.js";
import { AdapterError } from "./errors.js";
import type { AwsEcsDeploymentPlan } from "./types.js";

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

    const common = createCommonPlan(ir, profile);
    const region = ir.deploy.region ?? profile.default_region;
    const taskCpu = Math.round(common.service.compute.vcpu * 1024);

    return {
      ...common,
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
        },
      },
    };
  },
};
