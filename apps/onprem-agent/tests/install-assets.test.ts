import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const installRoot = join(process.cwd(), "install", "macos");
const repositoryRoot = join(process.cwd(), "..", "..");
const serviceScriptPath = join(installRoot, "service.sh");
const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("macOS 설치 자산", () => {
  it("설치 전에 macOS·x86_64/arm64·Docker·Compose를 검사한다", async () => {
    const script = await readFile(join(installRoot, "install.sh"), "utf8");

    expect(script).toContain('"$(uname -s)" != "Darwin"');
    expect(script).toContain("x86_64)");
    expect(script).toContain("arm64)");
    expect(script).toContain('EXPECTED_ARCH=$(cat "$SOURCE_ROOT/ARCHITECTURE")');
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
      readFile(join(installRoot, "download-install.sh"), "utf8"),
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
    const script = await readFile(serviceScriptPath, "utf8");

    expect(script).toContain('DOMAIN="gui/$(id -u)"');
    expect(script).toContain('launchctl bootstrap "$DOMAIN" "$PLIST_PATH"');
    expect(script).toContain('launchctl bootout "$DOMAIN/$LABEL"');
    expect(script).not.toContain("LaunchDaemons");
    expect(script).not.toContain("sudo");
  });

  it("disabled 상태에서도 enable 후 bootstrap하여 서비스를 시작한다", async () => {
    const fixture = await createServiceFixture();
    await writeFile(fixture.disabledPath, "disabled\n");

    await execFileAsync("sh", [serviceScriptPath, "start"], {
      env: fixture.environment,
    });

    const calls = (await readFile(fixture.logPath, "utf8")).trim().split("\n");
    const enableIndex = calls.indexOf(
      "enable gui/501/com.camellia.onprem-agent",
    );
    const bootstrapIndex = calls.findIndex((call) =>
      call.startsWith("bootstrap gui/501 "),
    );
    expect(enableIndex).toBeGreaterThanOrEqual(0);
    expect(bootstrapIndex).toBeGreaterThan(enableIndex);
  });

  it("stop은 bootout만 수행하고 disabled 상태를 남기지 않는다", async () => {
    const fixture = await createServiceFixture();
    await writeFile(fixture.loadedPath, "loaded\n");

    await execFileAsync("sh", [serviceScriptPath, "stop"], {
      env: fixture.environment,
    });

    const calls = (await readFile(fixture.logPath, "utf8")).trim().split("\n");
    expect(calls.map((call) => call.split(" ")[0])).toEqual([
      "bootout",
      "print",
      "print",
    ]);
    expect(calls).not.toContain("disable gui/501/com.camellia.onprem-agent");
  });

  it("restart는 로드된 서비스를 kickstart한다", async () => {
    const fixture = await createServiceFixture();
    await writeFile(fixture.loadedPath, "loaded\n");

    await execFileAsync("sh", [serviceScriptPath, "restart"], {
      env: fixture.environment,
    });

    const calls = (await readFile(fixture.logPath, "utf8")).trim().split("\n");
    expect(calls.map((call) => call.split(" ")[0])).toEqual([
      "print",
      "kickstart",
    ]);
  });

  it("stop 직후 start는 launchd 정리가 끝날 때까지 bootstrap을 재시도한다", async () => {
    const fixture = await createServiceFixture();
    await writeFile(fixture.loadedPath, "loaded\n");

    await execFileAsync("sh", [serviceScriptPath, "stop"], {
      env: fixture.environment,
    });
    await writeFile(fixture.bootstrapFailuresPath, "1\n");
    await execFileAsync("sh", [serviceScriptPath, "start"], {
      env: fixture.environment,
    });

    const calls = (await readFile(fixture.logPath, "utf8")).trim().split("\n");
    expect(calls.filter((call) => call.startsWith("bootstrap "))).toHaveLength(
      2,
    );
    expect(calls.at(-1)).toBe(
      "kickstart -k gui/501/com.camellia.onprem-agent",
    );
  });

  it("제거 시 고정된 설치 경로만 휴지통으로 이동하고 로그를 보존한다", async () => {
    const script = await readFile(join(installRoot, "uninstall.sh"), "utf8");

    expect(script).toContain('INSTALL_ROOT="$HOME/Library/Application Support/Camellia/onprem-agent"');
    expect(script).toContain('TRASH_ROOT="$HOME/.Trash"');
    expect(script).toContain('CREDENTIAL_PATH="$INSTALL_ROOT/credentials.json"');
    expect(script).toContain('rm -f "$CREDENTIAL_PATH"');
    expect(script).toContain('launchctl disable "$DOMAIN/$LABEL"');
    expect(script).toContain('mv "$INSTALL_ROOT" "$TRASH_TARGET"');
    expect(script).not.toContain("rm -rf");
    expect(script).not.toContain("CAMELLIA_AGENT_INSTALL_ROOT");
  });

  it.each([
    ["x86_64", "x64"],
    ["arm64", "arm64"],
  ])(
    "%s 호스트에서 해당 아키텍처의 버전 고정 archive를 설치한다",
    async (machineArchitecture, releaseArchitecture) => {
      const fixture = await createReleaseFixture(releaseArchitecture);
      const resultPath = join(fixture.root, "installed-architecture.txt");

      await execFileAsync("sh", [join(installRoot, "download-install.sh"), "v0.1.0"], {
        env: {
          ...process.env,
          PATH: `${fixture.binPath}:${process.env.PATH ?? ""}`,
          FAKE_RELEASE_DIR: fixture.releasePath,
          TEST_UNAME_M: machineArchitecture,
          CAMELLIA_TEST_RESULT: resultPath,
        },
      });

      await expect(readFile(resultPath, "utf8")).resolves.toBe(
        `${releaseArchitecture}\n`,
      );
    },
  );

  it("checksum이 다르면 archive를 실행하지 않는다", async () => {
    const fixture = await createReleaseFixture("arm64", "0".repeat(64));
    const resultPath = join(fixture.root, "installed-architecture.txt");

    await expect(
      execFileAsync("sh", [join(installRoot, "download-install.sh"), "v0.1.0"], {
        env: {
          ...process.env,
          PATH: `${fixture.binPath}:${process.env.PATH ?? ""}`,
          FAKE_RELEASE_DIR: fixture.releasePath,
          TEST_UNAME_M: "arm64",
          CAMELLIA_TEST_RESULT: resultPath,
        },
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("checksum") });
  });

  it("유효하지 않은 버전과 지원하지 않는 아키텍처를 거부한다", async () => {
    const fixture = await createReleaseFixture("arm64");

    await expect(
      execFileAsync("sh", [join(installRoot, "download-install.sh"), "latest"], {
        env: {
          ...process.env,
          PATH: `${fixture.binPath}:${process.env.PATH ?? ""}`,
          TEST_UNAME_M: "arm64",
        },
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("버전") });

    await expect(
      execFileAsync("sh", [join(installRoot, "download-install.sh"), "v0.1.0"], {
        env: {
          ...process.env,
          PATH: `${fixture.binPath}:${process.env.PATH ?? ""}`,
          TEST_UNAME_M: "riscv64",
        },
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("지원하지 않는") });
  });

  it("Release workflow가 검증 후 두 아키텍처 자산을 게시한다", async () => {
    const workflow = await readFile(
      join(repositoryRoot, ".github", "workflows", "agent-release.yml"),
      "utf8",
    );
    const packager = await readFile(
      join(process.cwd(), "scripts", "package-release.sh"),
      "utf8",
    );

    expect(workflow).toContain('"onprem-agent-v*"');
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("pnpm --filter @camellia/onprem-agent test");
    expect(workflow).toContain("pnpm --filter @camellia/onprem-agent typecheck");
    expect(workflow).toContain("pnpm --filter @camellia/onprem-agent lint");
    expect(workflow).toContain("package-release.sh");
    expect(workflow).toContain("gh release create");
    expect(packager).toContain("macos-x64.tar.gz");
    expect(packager).toContain("macos-arm64.tar.gz");
    expect(packager).toContain("shasum -a 256");
  });
});

async function createReleaseFixture(
  architecture: "x64" | "arm64",
  checksumOverride?: string,
) {
  const root = await mkdtemp(join(tmpdir(), "camellia-agent-release-"));
  temporaryDirectories.push(root);
  const binPath = join(root, "bin");
  const releasePath = join(root, "release");
  const bundlePath = join(root, "bundle", "camellia-onprem-agent");
  const installerPath = join(bundlePath, "install", "macos", "install.sh");
  const assetName = `camellia-onprem-agent-v0.1.0-macos-${architecture}.tar.gz`;
  const archivePath = join(releasePath, assetName);

  await mkdir(binPath, { recursive: true });
  await mkdir(releasePath, { recursive: true });
  await mkdir(join(bundlePath, "install", "macos"), { recursive: true });
  await writeFile(join(bundlePath, "VERSION"), "v0.1.0\n");
  await writeFile(join(bundlePath, "ARCHITECTURE"), `${architecture}\n`);
  await writeFile(
    installerPath,
    `#!/bin/sh\nset -eu\nSCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nSOURCE_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)\ncat "$SOURCE_ROOT/ARCHITECTURE" > "$CAMELLIA_TEST_RESULT"\n`,
  );
  await chmod(installerPath, 0o755);
  await execFileAsync("tar", ["-czf", archivePath, "-C", join(root, "bundle"), "camellia-onprem-agent"]);
  const archive = await readFile(archivePath);
  const checksum = checksumOverride ?? createHash("sha256").update(archive).digest("hex");
  await writeFile(`${archivePath}.sha256`, `${checksum}  ${assetName}\n`);

  await writeFile(
    join(binPath, "uname"),
    '#!/bin/sh\ncase "$1" in\n  -s) echo Darwin ;;\n  -m) echo "$TEST_UNAME_M" ;;\n  *) exec /usr/bin/uname "$@" ;;\nesac\n',
  );
  await chmod(join(binPath, "uname"), 0o755);
  await writeFile(
    join(binPath, "curl"),
    '#!/bin/sh\nset -eu\nout=""\nurl=""\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in\n    -o) out=$2; shift 2 ;;\n    http*) url=$1; shift ;;\n    *) shift ;;\n  esac\ndone\ncp "$FAKE_RELEASE_DIR/${url##*/}" "$out"\n',
  );
  await chmod(join(binPath, "curl"), 0o755);

  return { root, binPath, releasePath };
}

async function createServiceFixture() {
  const root = await mkdtemp(join(tmpdir(), "camellia-agent-service-"));
  temporaryDirectories.push(root);
  const homePath = join(root, "home");
  const binPath = join(root, "bin");
  const logPath = join(root, "launchctl.log");
  const disabledPath = join(root, "disabled");
  const loadedPath = join(root, "loaded");
  const pendingBootoutPath = join(root, "pending-bootout");
  const bootstrapFailuresPath = join(root, "bootstrap-failures");
  const stagedPlistPath = join(
    homePath,
    "Library",
    "Application Support",
    "Camellia",
    "onprem-agent",
    "com.camellia.onprem-agent.plist",
  );

  await mkdir(binPath, { recursive: true });
  await mkdir(join(homePath, "Library", "LaunchAgents"), { recursive: true });
  await mkdir(dirname(stagedPlistPath), { recursive: true });
  await writeFile(stagedPlistPath, "fixture plist\n");
  await writeFile(logPath, "");
  await writeFile(
    join(binPath, "id"),
    '#!/bin/sh\nif [ "${1:-}" = "-u" ]; then echo 501; else exit 1; fi\n',
  );
  await chmod(join(binPath, "id"), 0o755);
  await writeFile(
    join(binPath, "launchctl"),
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FAKE_LAUNCHCTL_LOG"
case "$1" in
  print)
    if [ -f "$FAKE_LAUNCHCTL_PENDING_BOOTOUT" ]; then
      rm -f "$FAKE_LAUNCHCTL_PENDING_BOOTOUT" "$FAKE_LAUNCHCTL_LOADED"
      exit 0
    fi
    test -f "$FAKE_LAUNCHCTL_LOADED"
    ;;
  bootout)
    if [ -f "$FAKE_LAUNCHCTL_LOADED" ]; then
      : > "$FAKE_LAUNCHCTL_PENDING_BOOTOUT"
    fi
    ;;
  disable)
    : > "$FAKE_LAUNCHCTL_DISABLED"
    ;;
  enable)
    rm -f "$FAKE_LAUNCHCTL_DISABLED"
    ;;
  bootstrap)
    if [ -f "$FAKE_LAUNCHCTL_DISABLED" ]; then
      echo "Bootstrap failed: 5: Input/output error" >&2
      exit 5
    fi
    if [ -f "$FAKE_LAUNCHCTL_BOOTSTRAP_FAILURES" ]; then
      COUNT=$(cat "$FAKE_LAUNCHCTL_BOOTSTRAP_FAILURES")
      if [ "$COUNT" -gt 0 ]; then
        printf '%s\\n' "$((COUNT - 1))" > "$FAKE_LAUNCHCTL_BOOTSTRAP_FAILURES"
        echo "Bootstrap failed: 5: Input/output error" >&2
        exit 5
      fi
    fi
    if [ -f "$FAKE_LAUNCHCTL_PENDING_BOOTOUT" ]; then
      echo "Bootstrap failed: 5: Input/output error" >&2
      exit 5
    fi
    : > "$FAKE_LAUNCHCTL_LOADED"
    ;;
  kickstart)
    test -f "$FAKE_LAUNCHCTL_LOADED"
    ;;
esac
`,
  );
  await chmod(join(binPath, "launchctl"), 0o755);
  await writeFile(join(binPath, "sleep"), "#!/bin/sh\nexit 0\n");
  await chmod(join(binPath, "sleep"), 0o755);

  return {
    bootstrapFailuresPath,
    disabledPath,
    loadedPath,
    logPath,
    environment: {
      ...process.env,
      HOME: homePath,
      PATH: `${binPath}:${process.env.PATH ?? ""}`,
      FAKE_LAUNCHCTL_LOG: logPath,
      FAKE_LAUNCHCTL_DISABLED: disabledPath,
      FAKE_LAUNCHCTL_LOADED: loadedPath,
      FAKE_LAUNCHCTL_PENDING_BOOTOUT: pendingBootoutPath,
      FAKE_LAUNCHCTL_BOOTSTRAP_FAILURES: bootstrapFailuresPath,
    },
  };
}
