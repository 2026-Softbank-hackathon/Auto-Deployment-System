import type { Ir } from "@camellia/ir-schema";
import { matchProfile } from "@camellia/profile-matcher";
import { getProfile } from "@camellia/profiles";
import type { DeploymentAdapter } from "./adapter.js";
import { AdapterError } from "./errors.js";
import { awsEcsAdapter } from "./aws-ecs.js";
import { awsLambdaAdapter } from "./aws-lambda.js";
import { onpremDockerAdapter } from "./onprem-docker.js";
import type { DeploymentPlan } from "./types.js";

const ADAPTERS: Record<string, DeploymentAdapter> = {
  [awsEcsAdapter.profileId]: awsEcsAdapter,
  [awsLambdaAdapter.profileId]: awsLambdaAdapter,
  [onpremDockerAdapter.profileId]: onpremDockerAdapter,
};

export function createDeploymentPlan(
  ir: Ir,
  targetProfile: string,
): DeploymentPlan {
  const profile = getProfile(targetProfile);
  if (!profile) {
    throw new AdapterError(
      "PROFILE_NOT_FOUND",
      `프로필 "${targetProfile}"을 찾을 수 없습니다.`,
    );
  }

  if (ir.deploy.profile !== targetProfile) {
    throw new AdapterError(
      "PROFILE_MISMATCH",
      `IR 프로필 "${ir.deploy.profile}"과 대상 프로필 "${targetProfile}"이 일치하지 않습니다.`,
    );
  }

  const match = matchProfile(ir, profile);
  if (!match.compatible || match.warnings.length > 0) {
    const details = [
      ...match.missing_resources.map(
        (item) => `${item.resource_name}:${item.resource_type}`,
      ),
      ...match.warnings.map((warning) => warning.code),
    ].join(", ");

    throw new AdapterError(
      "PROFILE_INCOMPATIBLE",
      `IR이 프로필 "${profile.id}"과 호환되지 않습니다${details ? `: ${details}` : ""}.`,
    );
  }

  const adapter = ADAPTERS[targetProfile];
  if (!adapter) {
    throw new AdapterError(
      "ADAPTER_NOT_FOUND",
      `프로필 "${targetProfile}"용 Adapter가 없습니다.`,
    );
  }

  return adapter.createPlan(ir, profile);
}

export function getRegisteredProfileIds(): string[] {
  return Object.keys(ADAPTERS);
}
