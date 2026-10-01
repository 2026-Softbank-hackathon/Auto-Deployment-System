import { describe, expect, it } from "vitest";
import { loadAgentConfig } from "../src/config.js";
import { StructuredLogger } from "../src/logger.js";

describe("Agent 설정과 구조화 로그", () => {
  it("식별자와 등록 토큰을 검증한다", () => {
    expect(
      loadAgentConfig({
        ONPREM_AGENT_ID: "agent-seoul-01",
        ONPREM_AGENT_REGISTRATION_TOKEN: "registration-token-value",
      }),
    ).toMatchObject({
      agentId: "agent-seoul-01",
      registrationToken: "registration-token-value",
    });

    expect(() => loadAgentConfig({})).toThrow();
    expect(() =>
      loadAgentConfig({
        ONPREM_AGENT_ID: "bad id",
        ONPREM_AGENT_REGISTRATION_TOKEN: "short",
      }),
    ).toThrow();
  });

  it("환경변수와 인증정보 값을 구조화 로그에서 마스킹한다", () => {
    const lines: string[] = [];
    const logger = new StructuredLogger((line) => lines.push(line));

    logger.info("job.received", {
      jobId: "job-001",
      environment: { APP_MESSAGE: "environment-secret" },
      password: "ecr-secret",
      ecrPassword: "nested-password-secret",
      registrationToken: "registration-secret",
      nested: { authorization: "Bearer secret" },
    });

    const serialized = lines.join("\n");
    expect(serialized).toContain("job-001");
    expect(serialized).not.toContain("environment-secret");
    expect(serialized).not.toContain("ecr-secret");
    expect(serialized).not.toContain("nested-password-secret");
    expect(serialized).not.toContain("registration-secret");
    expect(serialized).not.toContain("Bearer secret");
    expect(serialized).toContain("[REDACTED]");
  });
});
