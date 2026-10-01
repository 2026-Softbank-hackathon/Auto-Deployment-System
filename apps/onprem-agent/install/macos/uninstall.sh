#!/bin/sh
set -eu

LABEL="com.camellia.onprem-agent"
DOMAIN="gui/$(id -u)"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
INSTALL_ROOT="$HOME/Library/Application Support/Camellia/onprem-agent"
TRASH_ROOT="$HOME/.Trash"
TRASH_TARGET="$TRASH_ROOT/Camellia-onprem-agent-$(date +%Y%m%d%H%M%S)-$$"

launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true

if [ -e "$INSTALL_ROOT" ]; then
  mkdir -p "$TRASH_ROOT"
  mv "$INSTALL_ROOT" "$TRASH_TARGET"
fi

if [ -e "$PLIST_PATH" ]; then
  mkdir -p "$TRASH_TARGET"
  mv "$PLIST_PATH" "$TRASH_TARGET/$LABEL.plist"
fi

echo "Agent와 LaunchAgent plist를 휴지통으로 이동했습니다. 로그는 보존했습니다."
