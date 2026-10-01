#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "이 설치 스크립트는 macOS 전용입니다." >&2
  exit 1
fi

if [ "$(uname -m)" != "x86_64" ]; then
  echo "P0 On-Prem Agent는 Intel Mac(x86_64)만 지원합니다." >&2
  exit 1
fi

command -v node >/dev/null 2>&1 || {
  echo "Node.js 20 이상이 필요합니다." >&2
  exit 1
}
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || {
  echo "Node.js 20 이상이 필요합니다." >&2
  exit 1
}
command -v docker >/dev/null 2>&1 || {
  echo "docker CLI가 필요합니다." >&2
  exit 1
}
command -v cloudflared >/dev/null 2>&1 || {
  echo "cloudflared가 필요합니다." >&2
  exit 1
}
docker info >/dev/null 2>&1 || {
  echo "현재 사용자 세션에서 Docker daemon을 사용할 수 없습니다." >&2
  exit 1
}
docker compose version >/dev/null 2>&1 || {
  echo "Docker Compose v2가 필요합니다." >&2
  exit 1
}

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SOURCE_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
INSTALL_ROOT="$HOME/Library/Application Support/Camellia/onprem-agent"
LOG_ROOT=${CAMELLIA_AGENT_LOG_ROOT:-"$HOME/Library/Logs/Camellia"}
BIN_DIR="$INSTALL_ROOT/bin"
LIB_DIR="$INSTALL_ROOT/lib"
STAGED_PLIST="$INSTALL_ROOT/com.camellia.onprem-agent.plist"

if [ ! -f "$SOURCE_ROOT/dist/main.js" ] || [ ! -f "$SOURCE_ROOT/dist/launchd-cli.js" ]; then
  echo "빌드된 Agent 배포 파일이 없습니다. Release bundle 또는 pnpm build 결과가 필요합니다." >&2
  exit 1
fi

mkdir -p "$BIN_DIR" "$LIB_DIR" "$LOG_ROOT"
cp -R "$SOURCE_ROOT/dist/." "$LIB_DIR/"
cp "$SCRIPT_DIR/camellia-onprem-agent" "$BIN_DIR/camellia-onprem-agent"
cp "$SCRIPT_DIR/service.sh" "$BIN_DIR/camellia-onprem-agent-service"
cp "$SCRIPT_DIR/uninstall.sh" "$BIN_DIR/camellia-onprem-agent-uninstall"
chmod 755 \
  "$BIN_DIR/camellia-onprem-agent" \
  "$BIN_DIR/camellia-onprem-agent-service" \
  "$BIN_DIR/camellia-onprem-agent-uninstall"

PLIST_TEMP="$STAGED_PLIST.tmp.$$"
trap 'rm -f "$PLIST_TEMP"' EXIT HUP INT TERM
node "$LIB_DIR/launchd-cli.js" \
  "$BIN_DIR/camellia-onprem-agent" \
  "$INSTALL_ROOT" \
  "$LOG_ROOT/agent.log" \
  "$LOG_ROOT/agent-error.log" > "$PLIST_TEMP"
chmod 600 "$PLIST_TEMP"
mv "$PLIST_TEMP" "$STAGED_PLIST"
trap - EXIT HUP INT TERM

echo "Agent 파일과 LaunchAgent plist를 설치했습니다."
echo "등록·장기 인증키 설정 후 다음 명령으로 시작하십시오:"
echo "  $BIN_DIR/camellia-onprem-agent-service start"
