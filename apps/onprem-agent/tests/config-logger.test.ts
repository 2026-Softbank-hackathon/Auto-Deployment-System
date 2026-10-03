import { describe, expect, it } from "vitest";
import { loadAgentConfig } from "../src/config.js";
import { hasLoosePermissions } from "../src/file-permissions.js";
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

  it("기본 상태 디렉터리는 macOS는 Application Support, Windows는 %LOCALAPPDATA% 아래다", () => {
    expect(loadAgentConfig({}, "darwin").stateDirectory).toMatch(
      /Library[\\/]Application Support[\\/]Camellia[\\/]onprem-agent$/,
    );
    expect(
      loadAgentConfig({ LOCALAPPDATA: "C:\\Users\\agent\\AppData\\Local" }, "win32").stateDirectory,
    ).toBe("C:\\Users\\agent\\AppData\\Local\\Camellia\\onprem-agent");
    expect(
      loadAgentConfig({ ONPREM_AGENT_STATE_DIR: "D:\\agent" }, "win32").stateDirectory,
    ).toBe("D:\\agent");
  });

  it("권한 비트(700 · 600) 검사는 POSIX에서만 한다", () => {
    expect(hasLoosePermissions(0o40700, "darwin")).toBe(false);
    expect(hasLoosePermissions(0o40755, "darwin")).toBe(true);
    expect(hasLoosePermissions(0o100644, "linux")).toBe(true);
    // Windows의 mode는 ACL과 무관하게 항상 0o666 · 0o777로 보인다
    expect(hasLoosePermissions(0o100666, "win32")).toBe(false);
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
