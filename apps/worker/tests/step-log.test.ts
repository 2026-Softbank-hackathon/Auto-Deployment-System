/**
 * apps/worker/tests/step-log.test.ts
 * LOG-02 단계별 작업 로그 — 실제 LocalStorage(임시 디렉터리) + 기록용 notifier.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalStorage, type Storage } from "@camellia/storage";
import { createStepLogger, stepLogKey } from "../src/step-log.js";
import type { Notifier } from "../src/notifier.js";

let rootDir: string;
let storage: Storage;
let events: Array<{ deploymentId: number; event: string; payload: unknown }>;
let notifier: Notifier;
const now = () => new Date("2026-09-30T12:00:00.000Z");

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "step-log-"));
  storage = new LocalStorage({ rootDir });
  events = [];
  notifier = {
    async notify(deploymentId, event, payload) {
      events.push({ deploymentId, event, payload });
    },
  };
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

async function readLog(deploymentId: number, step: string) {
  return (await storage.get(stepLogKey(deploymentId, step))).toString("utf8");
}

describe("createStepLogger", () => {
  it("로그 줄을 시각과 함께 단계별 파일에 순서대로 저장함", async () => {
    const logger = createStepLogger({ storage, notifier }, 7, "analyze", { now });

    await logger.line("소스 압축 해제");
    await logger.line("스택 감지 완료");

    expect(await readLog(7, "analyze")).toBe(
      "[2026-09-30T12:00:00.000Z] 소스 압축 해제\n" +
        "[2026-09-30T12:00:00.000Z] 스택 감지 완료\n",
    );
  });

  it("줄마다 log.line 이벤트를 발행해 SSE로 실시간 전달함", async () => {
    const logger = createStepLogger({ storage, notifier }, 7, "analyze", { now });

    await logger.line("스택 감지 완료");

    expect(events).toEqual([
      {
        deploymentId: 7,
        event: "log.line",
        payload: { step: "analyze", line: "[2026-09-30T12:00:00.000Z] 스택 감지 완료" },
      },
    ]);
  });

  it("재시도로 로거를 새로 만들어도 기존 로그 뒤에 이어 씀", async () => {
    await createStepLogger({ storage, notifier }, 7, "build", { now }).line("1차 시도 실패");

    await createStepLogger({ storage, notifier }, 7, "build", { now }).line("2차 시도");

    expect(await readLog(7, "build")).toBe(
      "[2026-09-30T12:00:00.000Z] 1차 시도 실패\n" +
        "[2026-09-30T12:00:00.000Z] 2차 시도\n",
    );
  });

  it("스토리지 저장이 실패해도 작업을 멈추지 않음", async () => {
    const broken = {
      ...storage,
      exists: async () => false,
      put: async () => {
        throw new Error("disk full");
      },
    } as Storage;
    const logger = createStepLogger({ storage: broken, notifier }, 7, "analyze", { now });

    await expect(logger.line("계속 진행")).resolves.toBeUndefined();
    expect(events).toHaveLength(1);
  });
});
