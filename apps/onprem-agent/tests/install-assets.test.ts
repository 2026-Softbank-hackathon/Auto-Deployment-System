import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const installRoot = join(process.cwd(), "install", "macos");

describe("Intel Mac 설치 자산", () => {
  it("설치 전에 macOS·x86_64·Docker·Compose를 검사한다", async () => {
    const script = await readFile(join(installRoot, "install.sh"), "utf8");

    expect(script).toContain('"$(uname -s)" != "Darwin"');
    expect(script).toContain('"$(uname -m)" != "x86_64"');
    expect(script).toContain("process.versions.node");
    expect(script).toContain("docker info");
    expect(script).toContain("docker compose version");
    expect(script).toContain("command -v cloudflared");
  });

  it("1회용 등록 토큰을 plist나 설치 파일에 기록하지 않는다", async () => {
    const files = await Promise.all([
      readFile(join(installRoot, "install.sh"), "utf8"),
      readFile(join(installRoot, "service.sh"), "utf8"),
      readFile(join(installRoot, "uninstall.sh"), "utf8"),
      readFile(join(installRoot, "camellia-onprem-agent"), "utf8"),
    ]);
    const combined = files.join("\n");

    expect(combined).not.toContain("ONPREM_AGENT_REGISTRATION_TOKEN");
    expect(combined).not.toContain("Tunnel Token");
  });

  it("설치 명령은 최초 등록을 별도 실행하고 장기 Key를 인자로 전달하지 않는다", async () => {
    const launcher = await readFile(
      join(installRoot, "camellia-onprem-agent"),
      "utf8",
    );

    expect(launcher).toContain('"${1:-}" = "register"');
    expect(launcher).toContain("--register-only");
    expect(launcher).not.toContain("agentKey");
  });

  it("서비스 스크립트는 사용자 LaunchAgent만 관리한다", async () => {
    const script = await readFile(join(installRoot, "service.sh"), "utf8");

    expect(script).toContain('DOMAIN="gui/$(id -u)"');
    expect(script).toContain('launchctl bootstrap "$DOMAIN" "$PLIST_PATH"');
    expect(script).toContain('launchctl bootout "$DOMAIN/$LABEL"');
    expect(script).not.toContain("LaunchDaemons");
    expect(script).not.toContain("sudo");
  });

  it("제거 시 고정된 설치 경로만 휴지통으로 이동하고 로그를 보존한다", async () => {
    const script = await readFile(join(installRoot, "uninstall.sh"), "utf8");

    expect(script).toContain('INSTALL_ROOT="$HOME/Library/Application Support/Camellia/onprem-agent"');
    expect(script).toContain('TRASH_ROOT="$HOME/.Trash"');
    expect(script).toContain('CREDENTIAL_PATH="$INSTALL_ROOT/credentials.json"');
    expect(script).toContain('rm -f "$CREDENTIAL_PATH"');
    expect(script).toContain('mv "$INSTALL_ROOT" "$TRASH_TARGET"');
    expect(script).not.toContain("rm -rf");
    expect(script).not.toContain("CAMELLIA_AGENT_INSTALL_ROOT");
  });
});
