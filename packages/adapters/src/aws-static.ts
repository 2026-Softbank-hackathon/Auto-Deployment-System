import type { DeploymentAdapter } from "./adapter.js";
import { createCommonPlan } from "./common.js";
import { AdapterError } from "./errors.js";
import type { AwsStaticDeploymentPlan } from "./types.js";

/**
 * aws-static-basic (#273) — 정적 사이트를 서버 없이 S3 웹사이트 호스팅으로.
 * 버킷 이름(= 공개 호스트 이름) · 이미지는 프로젝트 · 플랫폼 도메인을 아는 provision 이 채운다.
 */
export const awsStaticAdapter: DeploymentAdapter = {
  profileId: "aws-static-basic",

  createPlan(ir, profile): AwsStaticDeploymentPlan {
    if (
      profile.cloud !== "aws" ||
      profile.runtime.type !== "s3-website" ||
      profile.ingress.type !== "cloudflare-proxy" ||
      !profile.default_region ||
      !profile.terraform_module_ref
    ) {
      throw new AdapterError(
        "PROFILE_CONFIGURATION_INVALID",
        `프로필 "${profile.id}"의 AWS 정적 사이트 설정이 올바르지 않습니다.`,
      );
    }

    const common = createCommonPlan(ir, profile);
    const site = common.build.staticSite;
    if (!site) {
      throw new AdapterError(
        "P0_SINGLE_HTTP_SERVICE_REQUIRED",
        `프로필 "${profile.id}"은 정적 사이트만 지원합니다.`,
      );
    }
    const region = ir.deploy.region ?? profile.default_region;

    return {
      ...common,
      target: "aws",
      runtime: {
        type: "s3-website",
        region,
      },
      provisioning: {
        engine: "terraform",
        moduleRef: profile.terraform_module_ref,
        variables: {
          app_name: common.application.name,
          region,
          spa_fallback: site.spaFallback,
        },
      },
    };
  },
};
