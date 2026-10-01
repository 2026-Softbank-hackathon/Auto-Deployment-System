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
    launchctl enable "$DOMAIN/$LABEL"
    if ! launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      # bootout 직후에는 launchd의 내부 정리가 늦게 끝날 수 있어 제한적으로 재시도함.
      BOOTSTRAP_ATTEMPT=1
      while ! BOOTSTRAP_ERROR=$(launchctl bootstrap "$DOMAIN" "$PLIST_PATH" 2>&1); do
        if [ "$BOOTSTRAP_ATTEMPT" -ge 5 ]; then
          printf '%s\n' "$BOOTSTRAP_ERROR" >&2
          exit 1
        fi
        BOOTSTRAP_ATTEMPT=$((BOOTSTRAP_ATTEMPT + 1))
        sleep 1
      done
    fi
    launchctl kickstart -k "$DOMAIN/$LABEL"
    ;;
  stop)
    launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    # bootout은 프로세스 종료 전에 반환할 수 있어 다음 start가 기존 job을 오인하지 않게 기다림.
    STOP_ATTEMPT=1
    while launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; do
      if [ "$STOP_ATTEMPT" -ge 10 ]; then
        echo "LaunchAgent가 제한 시간 안에 중지되지 않았습니다." >&2
        exit 1
      fi
      STOP_ATTEMPT=$((STOP_ATTEMPT + 1))
      sleep 1
    done
    ;;
  restart)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      launchctl kickstart -k "$DOMAIN/$LABEL"
    else
      "$0" start
    fi
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL"
    ;;
  *)
    echo "사용법: $0 {start|stop|restart|status}" >&2
    exit 1
    ;;
esac
