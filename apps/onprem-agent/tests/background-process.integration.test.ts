import { describe, expect, it } from "vitest";
import { NodeBackgroundProcessRunner } from "../src/background-process.js";

describe("NodeBackgroundProcessRunner", () => {
  it("실제 장기 실행 자식 프로세스를 정상 종료한다", async () => {
    const runner = new NodeBackgroundProcessRunner({ stopTimeoutMs: 1_000 });
    const child = await runner.start({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
    });

    expect(child.isRunning()).toBe(true);
    await child.stop();
    expect(child.isRunning()).toBe(false);
  });

  it("존재하지 않는 실행 파일은 내부 오류로 거부한다", async () => {
    const runner = new NodeBackgroundProcessRunner();

    await expect(
      runner.start({ command: "camellia-missing-command", args: [] }),
    ).rejects.toMatchObject({ code: "internal_error" });
  });
});
