export {
  ProfileSchema,
  ProfileCapabilitiesSchema,
  ComputeSizeSchema,
  RuntimeProfileSchema,
  IngressProfileSchema,
} from "./types.js";
export type {
  Profile,
  ProfileCapabilities,
  ComputeSize,
  RuntimeProfile,
  IngressProfile,
} from "./types.js";
export { awsEcsBasic } from "./aws-ecs-basic.js";
export { awsLambdaBasic } from "./aws-lambda-basic.js";
export { awsStaticBasic } from "./aws-static-basic.js";
export { onpremDockerBasic } from "./onprem-docker-basic.js";
export {
  DEPLOY_MODES,
  isStaticSiteIr,
  resolveProfile,
  resolveProfileAfterAnalysis,
} from "./resolve-profile.js";
export type { DeployMode, ResolveProfileOptions } from "./resolve-profile.js";

import type { Profile } from "./types.js";
import { awsEcsBasic } from "./aws-ecs-basic.js";
import { awsLambdaBasic } from "./aws-lambda-basic.js";
import { awsStaticBasic } from "./aws-static-basic.js";
import { onpremDockerBasic } from "./onprem-docker-basic.js";

export const PROFILES: Record<string, Profile> = {
  [awsEcsBasic.id]: awsEcsBasic,
  [awsLambdaBasic.id]: awsLambdaBasic,
  [awsStaticBasic.id]: awsStaticBasic,
  [onpremDockerBasic.id]: onpremDockerBasic,
};

const DEFAULT_PROFILE_IDS = {
  aws: awsEcsBasic.id,
  onprem: onpremDockerBasic.id,
} as const;

export type DefaultProfileVendor = keyof typeof DEFAULT_PROFILE_IDS;

export function defaultProfileFor(vendor: DefaultProfileVendor): string {
  return DEFAULT_PROFILE_IDS[vendor];
}

export function getProfile(id: string): Profile | null {
  return PROFILES[id] ?? null;
}
export { estimateMonthlyCost, MONTHLY_HOURS } from "./cost-estimate.js";
export type { CostEstimateInput, CostLineItem, CostLineItemKey, MonthlyCostEstimate } from "./cost-estimate.js";
