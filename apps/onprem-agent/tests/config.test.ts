import { describe, expect, it } from "vitest";
import { loadAgentConfig } from "../src/config.js";

describe("Agent config", () => {
  it("데모 장애 감지가 가능하도록 기본 heartbeat를 2초로 전송한다", () => {
    expect(loadAgentConfig({}).heartbeatIntervalMs).toBe(2_000);
  });

  it("명시한 heartbeat 주기를 우선한다", () => {
    expect(loadAgentConfig({
      ONPREM_AGENT_HEARTBEAT_INTERVAL_MS: "5000",
    }).heartbeatIntervalMs).toBe(5_000);
  });
});
