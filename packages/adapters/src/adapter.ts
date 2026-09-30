import type { Ir } from "@camellia/ir-schema";
import type { Profile } from "@camellia/profiles";
import type { DeploymentPlan } from "./types.js";

export interface DeploymentAdapter {
  readonly profileId: string;
  createPlan(ir: Ir, profile: Profile): DeploymentPlan;
}
