import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const windowsRoot = join(process.cwd(), "install", "windows");
const execFileAsync = promisify(execFile);

async function readScript(name: string): Promise<string> {
  return readFile(join(windowsRoot, name), "utf8");
}

describe("Windows 설치 자산", () => {
  it("Windows PowerShell 5.1이 코드 페이지로 읽어도 깨지지 않게 ASCII로만 쓴다", async () => {
    for (const name of await readdir(windowsRoot)) {
      const content = await readFile(join(windowsRoot, name));
      expect(content.every((byte) => byte < 0x80), name).toBe(true);
    }
  });

  it("1회용 등록 토큰과 장기 Key를 설치 파일에 기록하지 않는다", async () => {
    const combined = (
      await Promise.all((await readdir(windowsRoot)).map((name) => readScript(name)))
    ).join("\n");

    expect(combined).not.toContain("ONPREM_AGENT_REGISTRATION_TOKEN");
    expect(combined).not.toContain("agentKey");
  });

  it("실행기는 최초 등록을 따로 하고 서비스 명령을 로그온 작업 스크립트로 넘긴다", async () => {
    const launcher = await readScript("camellia-onprem-agent.cmd");

    expect(launcher).toContain('if /i "%ACTION%"=="register" goto register');
    expect(launcher).toContain("--register-only");
    expect(launcher).toContain("camellia-onprem-agent-service.ps1");
  });

  it("서비스는 관리자 권한 없이 현재 사용자의 로그온 작업으로만 등록한다", async () => {
    const script = await readScript("service.ps1");

    expect(script).toContain("New-ScheduledTaskTrigger -AtLogOn -User $user");
    expect(script).toContain("-LogonType Interactive -RunLevel Limited");
    // 기본 실행 제한(72시간)이 걸리면 Agent가 사흘 뒤 꺼진다
    expect(script).toContain("-ExecutionTimeLimit ([TimeSpan]::Zero)");
    expect(script).not.toContain("Highest");
  });

  it("설치기는 버전 · 아키텍처 · SHA-256을 확인한 뒤 설치한다", async () => {
    const script = await readScript("download-install.ps1");

    expect(script).toContain("windows-x64.zip");
    expect(script).toContain("Get-FileHash -Algorithm SHA256");
    expect(script).toContain("does not match the requested version");
    expect(script).toContain("is not for Windows x64");
  });

  it("Release에 Windows archive와 설치기를 함께 게시한다", async () => {
    const packager = await readFile(join(process.cwd(), "scripts", "package-release.sh"), "utf8");

    expect(packager).toContain("windows-x64.zip");
    expect(packager).toContain('shasum -a 256 "$WINDOWS_ASSET"');
    expect(packager).toContain("install-agent.ps1");
  });

  it.runIf(process.platform === "win32")("모든 PowerShell 스크립트가 문법 오류 없이 파싱된다", async () => {
    const names = (await readdir(windowsRoot)).filter((name) => name.endsWith(".ps1"));
    const command = names
      .map((name) => {
        const path = join(windowsRoot, name).replaceAll("'", "''");
        return `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${path}', [ref]$null, [ref]$e); if ($e.Count) { Write-Output '${name}'; $e | ForEach-Object { Write-Output $_.Message } }`;
      })
      .join("; ");
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]);

    expect(stdout.trim()).toBe("");
  });
});
