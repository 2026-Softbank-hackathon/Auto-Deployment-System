#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "사용법: $0 <deployment-id>" >&2
  exit 1
fi

DEPLOYMENT_ID=$1
case "$DEPLOYMENT_ID" in
  *[!0-9]*|'')
    echo "deployment-id는 양의 정수여야 합니다." >&2
    exit 1
    ;;
esac

SERVICE="$HOME/Library/Application Support/Camellia/onprem-agent/bin/camellia-onprem-agent-service"
if [ ! -x "$SERVICE" ]; then
  echo "설치된 Camellia Agent 서비스 명령을 찾을 수 없습니다: $SERVICE" >&2
  exit 1
fi

CONTAINERS=$(docker ps \
  --filter "label=io.camellia.managed=true" \
  --filter "label=io.camellia.deployment-id=$DEPLOYMENT_ID" \
  --format '{{.ID}}')
if [ -z "$CONTAINERS" ]; then
  echo "실행 중인 Camellia deployment $DEPLOYMENT_ID 컨테이너를 찾을 수 없습니다." >&2
  exit 1
fi

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] On-Prem 장애 재현을 시작합니다."
"$SERVICE" stop
for container in $CONTAINERS; do
  docker stop "$container" >/dev/null
  echo "컨테이너를 중지했습니다: $container"
done
echo "Agent와 deployment $DEPLOYMENT_ID 컨테이너가 중지됐습니다."
