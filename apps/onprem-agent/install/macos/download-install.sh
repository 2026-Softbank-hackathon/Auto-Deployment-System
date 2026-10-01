#!/bin/sh
set -eu

REPOSITORY="2026-Softbank-hackerton/Auto-Deployment-System"
VERSION=${1:-}

if ! printf '%s\n' "$VERSION" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  echo "설치할 Agent 버전을 vMAJOR.MINOR.PATCH 형식으로 지정해야 합니다." >&2
  exit 1
fi

if [ "$(uname -s)" != "Darwin" ]; then
  echo "이 설치 스크립트는 macOS 전용입니다." >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64)
    ARCH=x64
    ;;
  arm64)
    ARCH=arm64
    ;;
  *)
    echo "지원하지 않는 macOS 아키텍처입니다: $(uname -m)" >&2
    exit 1
    ;;
esac

command -v curl >/dev/null 2>&1 || {
  echo "Release 다운로드에 curl이 필요합니다." >&2
  exit 1
}
command -v shasum >/dev/null 2>&1 || {
  echo "checksum 검증에 shasum이 필요합니다." >&2
  exit 1
}
command -v tar >/dev/null 2>&1 || {
  echo "Release archive 압축 해제에 tar가 필요합니다." >&2
  exit 1
}

TAG="onprem-agent-$VERSION"
ASSET_NAME="camellia-onprem-agent-$VERSION-macos-$ARCH.tar.gz"
RELEASE_URL="https://github.com/$REPOSITORY/releases/download/$TAG"
DOWNLOAD_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/camellia-onprem-agent.XXXXXX")
ARCHIVE_PATH="$DOWNLOAD_ROOT/$ASSET_NAME"
CHECKSUM_PATH="$ARCHIVE_PATH.sha256"
EXTRACT_ROOT="$DOWNLOAD_ROOT/extracted"

cleanup() {
  rm -rf "$DOWNLOAD_ROOT"
}
trap cleanup EXIT HUP INT TERM

curl --fail --location --silent --show-error --retry 3 \
  --proto '=https' --tlsv1.2 \
  -o "$ARCHIVE_PATH" "$RELEASE_URL/$ASSET_NAME"
curl --fail --location --silent --show-error --retry 3 \
  --proto '=https' --tlsv1.2 \
  -o "$CHECKSUM_PATH" "$RELEASE_URL/$ASSET_NAME.sha256"

EXPECTED_CHECKSUM=$(awk -v asset="$ASSET_NAME" '$2 == asset { print $1 }' "$CHECKSUM_PATH")
if ! printf '%s\n' "$EXPECTED_CHECKSUM" | grep -Eq '^[0-9a-fA-F]{64}$'; then
  echo "올바른 SHA-256 checksum을 찾을 수 없습니다." >&2
  exit 1
fi
ACTUAL_CHECKSUM=$(shasum -a 256 "$ARCHIVE_PATH" | awk '{ print $1 }')
if [ "$ACTUAL_CHECKSUM" != "$EXPECTED_CHECKSUM" ]; then
  echo "Agent Release archive checksum 검증에 실패했습니다." >&2
  exit 1
fi

mkdir -p "$EXTRACT_ROOT"
tar -xzf "$ARCHIVE_PATH" -C "$EXTRACT_ROOT"
BUNDLE_ROOT="$EXTRACT_ROOT/camellia-onprem-agent"

if [ "$(cat "$BUNDLE_ROOT/VERSION" 2>/dev/null || true)" != "$VERSION" ]; then
  echo "다운로드한 Agent Release 버전이 요청한 버전과 일치하지 않습니다." >&2
  exit 1
fi
if [ "$(cat "$BUNDLE_ROOT/ARCHITECTURE" 2>/dev/null || true)" != "$ARCH" ]; then
  echo "다운로드한 Agent Release 아키텍처가 현재 Mac과 일치하지 않습니다." >&2
  exit 1
fi
if [ ! -f "$BUNDLE_ROOT/install/macos/install.sh" ]; then
  echo "Agent Release archive에 설치 파일이 없습니다." >&2
  exit 1
fi

sh "$BUNDLE_ROOT/install/macos/install.sh"
