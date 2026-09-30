/**
 * apps/worker/tests/contracts.test.ts
 * 워커가 발행하는 SSE 이벤트 · 배포 상태 목록이 @camellia/contracts 와 맞는지 확인.
 * (notify 호출 지점의 페이로드 형태는 Notifier 타입으로 tsc 가 검사한다)
 */

import { describe, expect, it } from "vitest";
import type { Storage } from "@camellia/storage";
import { DEPLOYMENT_STATUSES, DeploymentEventSchema } from "@camellia/contracts";
import { STATUSES } from "../src/state-machine.js";
import { createStepLogger } from "../src/step-log.js";
import type { Notifier } from "../src/notifier.js";

describe("워커 ↔ 계약", () => {
  it("상태 전이표의 상태 목록이 계약의 배포 상태와 같음", () => {
    expect([...STATUSES]).toEqual([...DEPLOYMENT_STATUSES]);
  });

  it("단계 로그가 발행하는 log.line 이벤트가 계약 스키마를 통과함", async () => {
    const files = new Map<string, Buffer>();
    const storage = {
      exists: async (key: string) => files.has(key),
      get: async (key: string) => files.get(key)!,
      put: async (key: string, data: Buffer) => void files.set(key, data),
    } as unknown as Storage;
    const events: Array<{ event: string; data: unknown }> = [];
    const notifier: Notifier = {
      async notify(_deploymentId, event, payload) {
        events.push({ event, data: payload });
      },
    };

    await createStepLogger({ storage, notifier }, 7, "build").line("docker build 시작");

    expect(events).toHaveLength(1);
    expect(DeploymentEventSchema.safeParse(events[0]).success).toBe(true);
  });
});
