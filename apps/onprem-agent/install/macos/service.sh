#!/bin/sh
set -eu

LABEL="com.camellia.onprem-agent"
DOMAIN="gui/$(id -u)"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
INSTALL_ROOT="$HOME/Library/Application Support/Camellia/onprem-agent"
STAGED_PLIST="$INSTALL_ROOT/$LABEL.plist"

case "${1:-}" in
  start)
    if [ ! -f "$STAGED_PLIST" ]; then
      echo "LaunchAgent plist가 없습니다. install.sh를 먼저 실행하십시오." >&2
      exit 1
    fi
    mkdir -p "$HOME/Library/LaunchAgents"
    cp "$STAGED_PLIST" "$PLIST_PATH"
    chmod 600 "$PLIST_PATH"
    launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    launchctl bootstrap "$DOMAIN" "$PLIST_PATH"
    launchctl enable "$DOMAIN/$LABEL"
    launchctl kickstart -k "$DOMAIN/$LABEL"
    ;;
  stop)
    launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    launchctl disable "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    ;;
  restart)
    "$0" stop
    "$0" start
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL"
    ;;
  *)
    echo "사용법: $0 {start|stop|restart|status}" >&2
    exit 1
    ;;
esac
