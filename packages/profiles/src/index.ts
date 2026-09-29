export { ProfileSchema, ProfileCapabilitiesSchema } from "./types.js";
export type { Profile, ProfileCapabilities } from "./types.js";
export { awsEcsBasic } from "./aws-ecs-basic.js";
export { onpremDockerBasic } from "./onprem-docker-basic.js";

import type { Profile } from "./types.js";
import { awsEcsBasic } from "./aws-ecs-basic.js";
import { onpremDockerBasic } from "./onprem-docker-basic.js";

export const PROFILES: Record<string, Profile> = {
  [awsEcsBasic.id]: awsEcsBasic,
  [onpremDockerBasic.id]: onpremDockerBasic,
};

export function getProfile(id: string): Profile | null {
  return PROFILES[id] ?? null;
}
