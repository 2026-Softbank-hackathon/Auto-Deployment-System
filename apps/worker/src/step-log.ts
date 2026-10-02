/**
 * apps/worker/src/step-log.ts
 *
 * LOG-02 단계별 작업 로그.
 * 한 줄마다 오브젝트 스토리지(logs/deployments/{id}/{step}.log)에 저장하고,
 * "log.line" 이벤트를 발행해 기존 SSE(/deployments/:id/events)로 실시간 전달한다.
 * 로그 저장·발행 실패는 배포 작업을 멈추지 않는다.
 *
 * 고정 문구는 키로 쓴다 — 웹이 현재 언어로 다시 그린다 (#147, log-messages.ts).
 *
 * 사용:
 *   const logger = createStepLogger(deps, deployment_id, "build");
 *   await logger.line(logMessage("build.ready"));
 *   await logger.line(errorDetail); // 오류 상세 · 도구 출력은 원문 그대로
 */

import type { WorkerDeps } from "./deps.js";
import { formatLogText, type LogText } from "./log-messages.js";

export type StepLogger = {
  line(text: LogText): Promise<void>;
};

export function stepLogKey(deploymentId: number, step: string): string {
  return `logs/deployments/${deploymentId}/${step}.log`;
}

export function createStepLogger(
  deps: Pick<WorkerDeps, "storage" | "notifier" | "log">,
  deploymentId: number,
  step: string,
  opts: { now?: () => Date } = {},
): StepLogger {
  const { storage, notifier, log } = deps;
  const now = opts.now ?? (() => new Date());
  const key = stepLogKey(deploymentId, step);
  let content: string | null = null;

  return {
    async line(text) {
      const line = `[${now().toISOString()}] ${formatLogText(text)}`;

      try {
        // 재시도로 새 로거가 만들어져도 이전 로그를 잃지 않도록 처음 한 번 기존 파일을 읽는다
        if (content === null) {
          content = (await storage.exists(key)) ? (await storage.get(key)).toString("utf8") : "";
        }
        content += `${line}\n`;
        await storage.put(key, Buffer.from(content, "utf8"), "text/plain");
      } catch (err) {
        log?.warn({ err, deploymentId, step }, "step log 저장 실패");
      }

      try {
        await notifier?.notify(deploymentId, "log.line", { step, line });
      } catch (err) {
        log?.warn({ err, deploymentId, step }, "step log 발행 실패");
      }
    },
  };
}
