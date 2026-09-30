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
export { onpremDockerBasic } from "./onprem-docker-basic.js";

import type { Profile } from "./types.js";
import { awsEcsBasic } from "./aws-ecs-basic.js";
import { onpremDockerBasic } from "./onprem-docker-basic.js";

export const PROFILES: Record<string, Profile> = {
  [awsEcsBasic.id]: awsEcsBasic,
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
