import type { DeploymentAdapter } from "./adapter.js";
import { createCommonPlan } from "./common.js";
import { AdapterError } from "./errors.js";
import type { AwsLambdaDeploymentPlan } from "./types.js";

/** 요청 하나의 Lambda 제한 시간 (초) */
const LAMBDA_TIMEOUT_SECONDS = 30;

export const awsLambdaAdapter: DeploymentAdapter = {
  profileId: "aws-lambda-basic",

  createPlan(ir, profile): AwsLambdaDeploymentPlan {
    if (
      profile.cloud !== "aws" ||
      profile.runtime.type !== "lambda" ||
      profile.ingress.type !== "alb" ||
      !profile.default_region ||
      !profile.terraform_module_ref
    ) {
      throw new AdapterError(
        "PROFILE_CONFIGURATION_INVALID",
        `프로필 "${profile.id}"의 AWS Lambda 설정이 올바르지 않습니다.`,
      );
    }

    const common = createCommonPlan(ir, profile);
    const region = ir.deploy.region ?? profile.default_region;
    const memoryMiB = common.service.compute.memoryMiB;

    return {
      ...common,
      target: "aws",
      runtime: {
        type: "lambda",
        region,
        memoryMiB,
        timeoutSeconds: LAMBDA_TIMEOUT_SECONDS,
      },
      provisioning: {
        engine: "terraform",
        moduleRef: profile.terraform_module_ref,
        variables: {
          app_name: common.application.name,
          region,
          container_port: common.service.containerPort,
          memory_size: memoryMiB,
          timeout: LAMBDA_TIMEOUT_SECONDS,
          health_check_path: common.health.path,
          public_ingress: common.ingress.exposure === "public",
        },
      },
    };
  },
};
