import { describe, expect, it } from "vitest";
import { loadAgentConfig } from "../src/config.js";
import { StructuredLogger } from "../src/logger.js";

describe("Agent 설정과 구조화 로그", () => {
  it("최초 등록 설정과 등록 이후 설정을 구분한다", () => {
    expect(
      loadAgentConfig({
        ONPREM_CONTROL_PLANE_URL: "https://control.camellia.example",
        ONPREM_AGENT_REGISTRATION_TOKEN: "registration-token-value",
      }),
    ).toMatchObject({
      controlPlaneUrl: "https://control.camellia.example",
      registrationToken: "registration-token-value",
    });

    expect(loadAgentConfig({})).toMatchObject({
      controlPlaneUrl: undefined,
      registrationToken: undefined,
    });
    expect(() =>
      loadAgentConfig({ ONPREM_AGENT_REGISTRATION_TOKEN: "short" }),
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
