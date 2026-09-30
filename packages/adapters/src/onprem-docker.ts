import type { DeploymentAdapter } from "./adapter.js";
import { createCommonPlan } from "./common.js";
import { AdapterError } from "./errors.js";
import type { OnpremDockerDeploymentPlan } from "./types.js";

export const onpremDockerAdapter: DeploymentAdapter = {
  profileId: "onprem-docker-basic",

  createPlan(ir, profile): OnpremDockerDeploymentPlan {
    if (
      profile.cloud !== "onprem" ||
      profile.runtime.type !== "docker-compose" ||
      profile.ingress.type !== "cloudflare-tunnel"
    ) {
      throw new AdapterError(
        "PROFILE_CONFIGURATION_INVALID",
        `프로필 "${profile.id}"의 On-Prem Docker 설정이 올바르지 않습니다.`,
      );
    }

    const common = createCommonPlan(ir, profile);

    return {
      ...common,
      target: "onprem",
      runtime: {
        type: "docker-compose",
        cpus: common.service.compute.vcpu,
        memoryMiB: common.service.compute.memoryMiB,
        replicas: profile.runtime.replicas,
      },
      provisioning: {
        engine: "docker-compose",
        projectName: common.application.name,
      },
    };
  },
};
