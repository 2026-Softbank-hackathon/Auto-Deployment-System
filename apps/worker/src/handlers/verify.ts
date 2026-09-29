/**
 * apps/worker/src/handlers/verify.ts
 *
 * verify job 핸들러 — stub.
 * TODO(민서): 헬스체크 + digest 확인 (Q3 결정 대기)
 */

import type { WorkerDeps } from "../deps.js";

export type VerifyJobPayload = {
  deployment_id: number;
};

export async function handleVerify(
  job: { data: VerifyJobPayload },
  deps: WorkerDeps
): Promise<void> {
  const { deployment_id } = job.data;
  deps.log?.info({ deployment_id }, "verify job received (stub — not yet implemented)");
}
