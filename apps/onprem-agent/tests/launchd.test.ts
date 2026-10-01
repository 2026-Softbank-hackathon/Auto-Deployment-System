import { describe, expect, it } from "vitest";
import { renderLaunchAgentPlist } from "../src/launchd.js";

describe("LaunchAgent plist", () => {
  it("로그인 자동 시작·재시작·로그 경로를 포함한다", () => {
    const plist = renderLaunchAgentPlist({
      executablePath: "/Users/demo/Camellia Agent/bin/camellia-onprem-agent",
      workingDirectory: "/Users/demo/Library/Application Support/Camellia",
      stdoutPath: "/Users/demo/Library/Logs/Camellia/agent.log",
      stderrPath: "/Users/demo/Library/Logs/Camellia/agent-error.log",
    });

    expect(plist).toContain("<string>com.camellia.onprem-agent</string>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain(
      "<string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>",
    );
    expect(plist).toContain(
      "<string>/Users/demo/Camellia Agent/bin/camellia-onprem-agent</string>",
    );
  });

  it("경로의 XML 특수문자를 이스케이프한다", () => {
    const plist = renderLaunchAgentPlist({
      executablePath: "/Users/a&b/bin/agent",
      workingDirectory: "/Users/a&b/app",
      stdoutPath: "/Users/a&b/log/out",
      stderrPath: "/Users/a&b/log/err",
    });

    expect(plist).not.toContain("/Users/a&b/");
    expect(plist).toContain("/Users/a&amp;b/");
  });
});
