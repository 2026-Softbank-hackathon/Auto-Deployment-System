#!/bin/sh
set -eu

LABEL="com.camellia.onprem-agent"
DOMAIN="gui/$(id -u)"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
INSTALL_ROOT="$HOME/Library/Application Support/Camellia/onprem-agent"
CREDENTIAL_PATH="$INSTALL_ROOT/credentials.json"
TRASH_ROOT="$HOME/.Trash"
TRASH_TARGET="$TRASH_ROOT/Camellia-onprem-agent-$(date +%Y%m%d%H%M%S)-$$"

launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
launchctl disable "$DOMAIN/$LABEL" >/dev/null 2>&1 || true

# 장기 Agent Key는 휴지통에 복구 가능한 상태로 남기지 않는다.
if [ -f "$CREDENTIAL_PATH" ] && [ ! -L "$CREDENTIAL_PATH" ]; then
  rm -f "$CREDENTIAL_PATH"
fi

if [ -e "$INSTALL_ROOT" ]; then
  mkdir -p "$TRASH_ROOT"
  mv "$INSTALL_ROOT" "$TRASH_TARGET"
fi

if [ -e "$PLIST_PATH" ]; then
  mkdir -p "$TRASH_TARGET"
  mv "$PLIST_PATH" "$TRASH_TARGET/$LABEL.plist"
fi

echo "로컬 Agent 인증정보를 삭제하고 Agent와 LaunchAgent plist를 휴지통으로 이동했습니다. 로그는 보존했습니다."
