/**
 * apps/worker/src/handlers/build.ts
 *
 * build job 핸들러 — stub.
 * TODO(은영): build 핸들러 구현 (BuildKit linux/amd64, ECR push)
 */

import type { WorkerDeps } from "../deps.js";

export type BuildJobPayload = {
  deployment_id: number;
};

export async function handleBuild(
  job: { data: BuildJobPayload },
  deps: WorkerDeps
): Promise<void> {
  const { deployment_id } = job.data;
  deps.log?.info({ deployment_id }, "build job received (stub — not yet implemented)");
}
