/**
 * apps/worker/src/register.ts
 *
 * registerAll(boss, deps) — job_type별 핸들러를 pg-boss에 등록한다.
 * 재사용 가능한 함수로 분리 (main.ts + 테스트 양쪽에서 사용 가능).
 */

import type PgBoss from "pg-boss";
import type { WorkerDeps } from "./deps.js";
import { handleAnalyze, type AnalyzeJobPayload } from "./handlers/analyze.js";
import { handleBuild, type BuildJobPayload } from "./handlers/build.js";
import { handleProvision, type ProvisionJobPayload } from "./handlers/provision.js";
import { handleVerify, type VerifyJobPayload } from "./handlers/verify.js";

export async function registerAll(boss: PgBoss, deps: WorkerDeps): Promise<void> {
  // pg-boss v10 breaking change: send/work 이전에 큐를 명시적으로 생성해야 함.
  // 이미 존재하면 no-op으로 처리.
  for (const q of ["analyze", "build", "provision", "verify"]) {
    try {
      await boss.createQueue(q);
    } catch (e) {
      // pg-boss는 이미 존재하는 큐 생성 시 duplicate 에러를 냄 - 무시
      const msg = e instanceof Error ? e.message : String(e);
      if (!/already exists|duplicate/i.test(msg)) throw e;
    }
  }

  await boss.work("analyze", async (jobs) => {
    for (const job of jobs) {
      try {
        await handleAnalyze(job as { data: AnalyzeJobPayload }, deps);
      } catch (e) {
        // pg-boss가 retry를 처리한다. 로그만 남기고 재던진다.
        deps.log?.error({ err: e, jobId: job.id }, "analyze job failed");
        throw e;
      }
    }
  });

  await boss.work("build", async (jobs) => {
    for (const job of jobs) {
      try {
        await handleBuild(job as { data: BuildJobPayload }, deps);
      } catch (e) {
        deps.log?.error({ err: e, jobId: job.id }, "build job failed");
        throw e;
      }
    }
  });

  await boss.work("provision", async (jobs) => {
    for (const job of jobs) {
      try {
        await handleProvision(job as { data: ProvisionJobPayload }, deps);
      } catch (e) {
        deps.log?.error({ err: e, jobId: job.id }, "provision job failed");
        throw e;
      }
    }
  });

  await boss.work("verify", async (jobs) => {
    for (const job of jobs) {
      try {
        await handleVerify(job as { data: VerifyJobPayload }, deps);
      } catch (e) {
        deps.log?.error({ err: e, jobId: job.id }, "verify job failed");
        throw e;
      }
    }
  });
}
