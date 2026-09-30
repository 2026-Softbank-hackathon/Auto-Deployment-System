/**
 * apps/worker/src/handlers/provision.ts
 *
 * provision job 핸들러 — stub.
 * TODO(은영): terraform apply 구현
 */

import type { WorkerDeps } from "../deps.js";

export type ProvisionJobPayload = {
  deployment_id: number;
};

export async function handleProvision(
  job: { data: ProvisionJobPayload },
  deps: WorkerDeps
): Promise<void> {
  const { deployment_id } = job.data;
  deps.log?.info({ deployment_id }, "provision job received (stub — not yet implemented)");
}
