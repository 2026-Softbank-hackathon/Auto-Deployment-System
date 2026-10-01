#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "이 설치 스크립트는 macOS 전용입니다." >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64)
    DETECTED_ARCH=x64
    ;;
  arm64)
    DETECTED_ARCH=arm64
    ;;
  *)
    echo "지원하지 않는 macOS 아키텍처입니다: $(uname -m)" >&2
    exit 1
    ;;
esac

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SOURCE_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)

if [ -f "$SOURCE_ROOT/ARCHITECTURE" ]; then
  EXPECTED_ARCH=$(cat "$SOURCE_ROOT/ARCHITECTURE")
  if [ "$EXPECTED_ARCH" != "$DETECTED_ARCH" ]; then
    echo "Release 아키텍처($EXPECTED_ARCH)와 현재 Mac($DETECTED_ARCH)이 일치하지 않습니다." >&2
    exit 1
  fi
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
echo "1회용 등록 토큰으로 먼저 등록하십시오:"
echo "  README의 최초 등록 명령을 사용해 $BIN_DIR/camellia-onprem-agent register를 실행하십시오."
echo "등록을 마친 뒤 다음 명령으로 서비스를 시작하십시오:"
echo "  $BIN_DIR/camellia-onprem-agent-service start"
