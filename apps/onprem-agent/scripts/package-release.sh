#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
AGENT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
VERSION=${1:-}
OUTPUT_DIR=${2:-"$AGENT_ROOT/release-output"}

if ! printf '%s\n' "$VERSION" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  echo "패키징할 Agent 버전을 vMAJOR.MINOR.PATCH 형식으로 지정해야 합니다." >&2
  exit 1
fi

PACKAGE_VERSION=$(node -p "require('$AGENT_ROOT/package.json').version")
if [ "$VERSION" != "v$PACKAGE_VERSION" ]; then
  echo "Release 버전($VERSION)과 package.json 버전(v$PACKAGE_VERSION)이 일치하지 않습니다." >&2
  exit 1
fi

if [ ! -f "$AGENT_ROOT/dist/main.js" ] || [ ! -f "$AGENT_ROOT/dist/launchd-cli.js" ]; then
  echo "Agent build 산출물이 없습니다. 먼저 pnpm build를 실행하십시오." >&2
  exit 1
fi
if grep -Eq '@camellia/' "$AGENT_ROOT"/dist/*.js; then
  echo "Agent build가 workspace runtime 패키지에 의존하므로 독립 실행 archive를 만들 수 없습니다." >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
STAGING_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/camellia-agent-package.XXXXXX")
cleanup() {
  rm -rf "$STAGING_ROOT"
}
trap cleanup EXIT HUP INT TERM

X64_ASSET="camellia-onprem-agent-$VERSION-macos-x64.tar.gz"
ARM64_ASSET="camellia-onprem-agent-$VERSION-macos-arm64.tar.gz"

for ENTRY in "x64:$X64_ASSET" "arm64:$ARM64_ASSET"; do
  ARCH=${ENTRY%%:*}
  ASSET_NAME=${ENTRY#*:}
  BUNDLE_ROOT="$STAGING_ROOT/$ARCH/camellia-onprem-agent"

  mkdir -p "$BUNDLE_ROOT/dist" "$BUNDLE_ROOT/install/macos"
  cp "$AGENT_ROOT"/dist/*.js "$BUNDLE_ROOT/dist/"
  cp \
    "$AGENT_ROOT/install/macos/install.sh" \
    "$AGENT_ROOT/install/macos/service.sh" \
    "$AGENT_ROOT/install/macos/uninstall.sh" \
    "$AGENT_ROOT/install/macos/camellia-onprem-agent" \
    "$BUNDLE_ROOT/install/macos/"
  printf '%s\n' "$VERSION" > "$BUNDLE_ROOT/VERSION"
  printf '%s\n' "$ARCH" > "$BUNDLE_ROOT/ARCHITECTURE"
  chmod 755 "$BUNDLE_ROOT/install/macos/"*

  tar -czf "$OUTPUT_DIR/$ASSET_NAME" -C "$STAGING_ROOT/$ARCH" camellia-onprem-agent
  (
    cd "$OUTPUT_DIR"
    shasum -a 256 "$ASSET_NAME" > "$ASSET_NAME.sha256"
  )
done

cp "$AGENT_ROOT/install/macos/download-install.sh" "$OUTPUT_DIR/install-agent.sh"
chmod 755 "$OUTPUT_DIR/install-agent.sh"

echo "Agent Release 자산을 생성했습니다: $OUTPUT_DIR"
