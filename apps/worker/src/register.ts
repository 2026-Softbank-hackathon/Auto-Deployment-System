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
import type { VerifyJobPayload } from "./handlers/verify.js";
import { runVerifyJob } from "./verify-orchestrator.js";
import { handleDiagnose, type DiagnoseJobPayload } from "./handlers/diagnose.js";
import { handleTeardown, type TeardownJobPayload } from "./handlers/teardown.js";
import { handleAddressChange, type AddressChangeJobPayload } from "./handlers/address-change.js";
import { trackActive } from "./shutdown.js";

export async function registerAll(boss: PgBoss, deps: WorkerDeps): Promise<void> {
  // pg-boss v10 breaking change: send/work 이전에 큐를 명시적으로 생성해야 함.
  // 이미 존재하면 no-op으로 처리.
  // address-change: 앱 주소 변경 (#301) — API 가 프로젝트마다 singletonKey 로 넣는다
  for (const q of ["analyze", "build", "provision", "verify", "diagnose", "address-change"]) {
    try {
      await boss.createQueue(q);
    } catch (e) {
      // pg-boss는 이미 존재하는 큐 생성 시 duplicate 에러를 냄 - 무시
      const msg = e instanceof Error ? e.message : String(e);
      if (!/already exists|duplicate/i.test(msg)) throw e;
    }
  }
  // 앱 삭제 (#247): stately — 프로젝트(singletonKey)마다 대기 1개 · 실행 1개만 둬서
  // 삭제를 여러 번 눌러도 같은 프로젝트의 destroy 가 겹쳐 돌지 않는다.
  try {
    await boss.createQueue("teardown", { name: "teardown", policy: "stately" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/already exists|duplicate/i.test(msg)) throw e;
  }

  await boss.work("analyze", trackActive(async (jobs) => {
    for (const job of jobs) {
      try {
        await handleAnalyze(job as { data: AnalyzeJobPayload }, deps);
      } catch (e) {
        // pg-boss가 retry를 처리한다. 로그만 남기고 재던진다.
        deps.log?.error({ err: e, jobId: job.id }, "analyze job failed");
        throw e;
      }
    }
  }));

  await boss.work("build", trackActive(async (jobs) => {
    for (const job of jobs) {
      try {
        await handleBuild(job as { data: BuildJobPayload }, deps);
      } catch (e) {
        deps.log?.error({ err: e, jobId: job.id }, "build job failed");
        throw e;
      }
    }
  }));

  await boss.work("provision", trackActive(async (jobs) => {
    for (const job of jobs) {
      try {
        await handleProvision(job as { data: ProvisionJobPayload }, deps);
      } catch (e) {
        deps.log?.error({ err: e, jobId: job.id }, "provision job failed");
        throw e;
      }
    }
  }));

  await boss.work("verify", trackActive(async (jobs) => {
    for (const job of jobs) {
      try {
        await runVerifyJob(job as { data: VerifyJobPayload }, deps);
      } catch (e) {
        deps.log?.error({ err: e, jobId: job.id }, "verify job failed");
        throw e;
      }
    }
  }));

  await boss.work("teardown", trackActive(async (jobs) => {
    for (const job of jobs) {
      try {
        await handleTeardown(job as { data: TeardownJobPayload }, deps);
      } catch (e) {
        deps.log?.error({ err: e, jobId: job.id }, "teardown job failed");
        throw e;
      }
    }
  }));

  await boss.work("address-change", trackActive(async (jobs) => {
    for (const job of jobs) {
      try {
        await handleAddressChange(job as { data: AddressChangeJobPayload }, deps);
      } catch (e) {
        deps.log?.error({ err: e, jobId: job.id }, "address-change job failed");
        throw e;
      }
    }
  }));

  // API-36 진단 잡: state-machine.transitionTo(..., "failed", { boss }) 가 자동 큐잉.
  await boss.work("diagnose", trackActive(async (jobs) => {
    for (const job of jobs) {
      try {
        await handleDiagnose(job as { data: DiagnoseJobPayload }, deps);
      } catch (e) {
        deps.log?.error({ err: e, jobId: job.id }, "diagnose job failed");
        throw e;
      }
    }
  }));
}
