#!/usr/bin/env bash
# Camellia 플랫폼 배포 · 갱신 (EC2 호스트에서 root 로 실행).
#
#   sudo bash /opt/camellia/platform/infra/platform/scripts/deploy.sh [git-ref]
#
#   1. git-ref(브랜치 · 태그 · 커밋, 기본 main)를 받아 체크아웃
#   2. SSM Parameter Store(<prefix>/*)를 읽어 infra/platform/.env 생성 (권한 600)
#   3. docker compose --profile tunnel up -d --build
#   4. 디스크 정리 (안 쓰는 이미지 · 빌드 캐시 · 사용자 앱 이미지). 실패해도 배포는 성공으로 둔다
#   5. 배포 기록 (#310): 시작 · 끝(성공/실패)을 플랫폼 DB(platform_deploys)에 남긴다. 기록 실패는 무시한다
#
# 선택 환경변수 (deploy-platform.yml 이 넘김, 없으면 비워 둔다):
#   DEPLOY_RUN_ID   GitHub Actions 실행 ID
#   DEPLOY_RUN_URL  GitHub Actions 실행 페이지
#
# 설정: /etc/camellia/platform.conf (user-data 가 만듦) — AWS_REGION, CAMELLIA_SSM_PREFIX
# 최초 부팅(user-data)과 이후 갱신이 같은 스크립트를 쓴다.
set -euo pipefail

# 스크립트 전체를 함수로 감싼다: 1단계 git checkout 이 이 파일을 바꿔도
# bash 는 이미 파싱한 함수를 실행하므로 중간에 꼬이지 않는다.
main() {
  REF="${1:-main}"
  DEPLOY_STARTED_AT="$(date +%s)"
  DEPLOY_KEY="$(cat /proc/sys/kernel/random/uuid)"
  COMMIT_SHA="" COMMIT_SUBJECT="" COMMIT_URL=""
  DISK_BEFORE="" DISK_AFTER="" DISK_TOTAL=""
  tmp_env=""
  # snap 으로 설치한 aws CLI (SSM Run Command · cloud-init 셸은 /snap/bin 이 PATH 에 없을 수 있다)
  export PATH="$PATH:/snap/bin"
  CONF=/etc/camellia/platform.conf
  [ -f "$CONF" ] && . "$CONF"
  : "${AWS_REGION:?AWS_REGION 이 필요하다 ($CONF)}"
  : "${CAMELLIA_SSM_PREFIX:?CAMELLIA_SSM_PREFIX 가 필요하다 ($CONF)}"

  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
  PLATFORM_DIR="$REPO_DIR/infra/platform"
  REQUIRED_KEYS=(POSTGRES_PASSWORD API_KEY SECRET_MASTER_KEY CONSOLE_BASIC_AUTH_PASSWORD CLOUDFLARE_TUNNEL_TOKEN)

  log() { echo "[camellia-deploy] $*"; }

  disk_usage() { df -h / | awk 'NR == 2 { print $3 " / " $2 " (" $5 ")" }'; }
  # 사용 중 · 전체 바이트 (배포 기록용)
  disk_bytes() { df -B1 --output=used,size / | awk 'NR == 2 { print $1, $2 }'; }

  # 플랫폼 CD 기록 (#310): deploy_key 로 platform_deploys 에 upsert (scripts/record-deploy.sql).
  # postgres 가 아직 없거나(최초 부팅) 재시작 중이면 남기지 못하고 넘어간다 — 배포 성공 · 실패에 영향 없음
  record_deploy() {
    local status="$1" pg=""
    pg="$(docker ps -q --filter label=com.docker.compose.project=camellia-platform \
      --filter label=com.docker.compose.service=postgres 2>/dev/null | head -n 1)" || true
    if [ -z "$pg" ]; then
      log "배포 기록 생략 ($status) — postgres 컨테이너 없음"
      return 0
    fi
    if timeout 30 docker exec -i "$pg" psql -U camellia -d camellia -X -q -v ON_ERROR_STOP=1 \
        -v deploy_key="$DEPLOY_KEY" -v status="$status" -v ref="$REF" \
        -v commit_sha="$COMMIT_SHA" -v commit_subject="$COMMIT_SUBJECT" -v commit_url="$COMMIT_URL" \
        -v started_at="$DEPLOY_STARTED_AT" \
        -v disk_before="$DISK_BEFORE" -v disk_after="$DISK_AFTER" -v disk_total="$DISK_TOTAL" \
        -v run_id="${DEPLOY_RUN_ID:-}" -v run_url="${DEPLOY_RUN_URL:-}" \
        -f - < "$PLATFORM_DIR/scripts/record-deploy.sql" >/dev/null 2>&1; then
      log "배포 기록: $status"
    else
      log "배포 기록 실패 ($status) — 무시한다"
    fi
  }

  # 중간에 실패하면(set -e 중단 · exit 1) failed 를 남긴다. 성공은 끝에서 직접 남긴다
  # shellcheck disable=SC2329 # trap 으로 호출
  on_exit() {
    local rc=$?
    if [ -n "$tmp_env" ]; then rm -f "$tmp_env"; fi
    if [ "$rc" -ne 0 ]; then record_deploy failed || true; fi
  }
  trap on_exit EXIT

  cleanup_disk() {
    read -r DISK_BEFORE DISK_TOTAL < <(disk_bytes) || true
    log "disk before cleanup: $(disk_usage)"
    docker image prune -f >/dev/null
    # 빌드 캐시는 5GB 만 남긴다. Docker 28+ 는 --reserved-space, 이전 버전은 --keep-storage
    docker builder prune -f --reserved-space 5gb >/dev/null 2>&1 \
      || docker builder prune -f --keep-storage 5gb >/dev/null
    # worker 가 빌드해 ECR 에 push 한 사용자 앱 이미지 (<계정>.dkr.ecr.../camellia/projects/<id>:<tag>).
    # 진행 중인 빌드와 겹치지 않게 1시간 지난 것만 지우고, 컨테이너가 쓰는 이미지는 docker rmi 가 거부한다
    local cutoff ref created removed=0
    cutoff=$(( $(date +%s) - 3600 ))
    while read -r ref; do
      created="$(docker image inspect -f '{{.Created}}' "$ref" 2>/dev/null)" || continue
      created="$(date -d "$created" +%s 2>/dev/null)" || continue
      [ "$created" -lt "$cutoff" ] || continue
      docker rmi "$ref" >/dev/null 2>&1 && removed=$((removed + 1))
    done < <(docker image ls --filter 'reference=*/camellia/projects/*' --format '{{.Repository}}:{{.Tag}}' | grep -v ':<none>$')
    log "user-app images removed: $removed"
    read -r DISK_AFTER DISK_TOTAL < <(disk_bytes) || true
    log "disk after cleanup: $(disk_usage)"
  }

  # ── 1. 소스 ──────────────────────────────────────────────────────────────
  log "git ref: $REF"
  git -C "$REPO_DIR" fetch --prune origin "$REF"
  git -C "$REPO_DIR" checkout --force --detach FETCH_HEAD
  log "commit: $(git -C "$REPO_DIR" log -1 --format='%h %s')"
  COMMIT_SHA="$(git -C "$REPO_DIR" rev-parse HEAD)"
  COMMIT_SUBJECT="$(git -C "$REPO_DIR" log -1 --format=%s)"
  # 커밋 링크는 origin 이 공개 GitHub https 주소일 때만 (자격 증명이 든 URL 은 남기지 않는다)
  repo_url="$(git -C "$REPO_DIR" remote get-url origin 2>/dev/null || true)"
  repo_url="${repo_url%.git}"
  if [[ "$repo_url" =~ ^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; then
    COMMIT_URL="$repo_url/commit/$COMMIT_SHA"
  fi
  # worker 이미지에 커밋을 넣는다 (운영 화면의 워커 커밋 — compose.yaml worker build args)
  export CAMELLIA_COMMIT="$COMMIT_SHA"
  record_deploy running

  # ── 2. env (SSM → .env) ─────────────────────────────────────────────────
  tmp_env="$(mktemp)"
  chmod 600 "$tmp_env"

  aws ssm get-parameters-by-path \
    --region "$AWS_REGION" \
    --path "$CAMELLIA_SSM_PREFIX" \
    --recursive \
    --with-decryption \
    --output json \
    | jq -r '.Parameters[] | "\(.Name | split("/") | last)=\(.Value)"' > "$tmp_env"

  missing=()
  for key in "${REQUIRED_KEYS[@]}"; do
    grep -q "^${key}=." "$tmp_env" || missing+=("$key")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    log "SSM ${CAMELLIA_SSM_PREFIX} 에 필수 값이 없다: ${missing[*]}"
    log "docs/deploy-platform.md 의 'SSM 파라미터 등록' 참고"
    exit 1
  fi

  # worker 컨테이너가 /var/run/docker.sock 을 쓰도록 호스트 docker 그룹 GID 를 넘긴다
  echo "DOCKER_GID=$(getent group docker | cut -d: -f3)" >> "$tmp_env"
  install -m 600 -o root -g root "$tmp_env" "$PLATFORM_DIR/.env"
  log "env: $(cut -d= -f1 "$PLATFORM_DIR/.env" | sort | tr '\n' ' ')"

  # ── 3. compose ──────────────────────────────────────────────────────────
  cd "$PLATFORM_DIR"
  docker compose --profile tunnel build
  # worker 는 진행 중인 사용자 배포가 끝날 때까지 최대 30분 멈추며 교체된다 (stop_grace_period, #241).
  # 한 번에 up 하면 compose 가 그동안 다른 서비스 시작도 미루므로, worker 를 뺀 나머지를 먼저 올린다
  mapfile -t services < <(docker compose --profile tunnel config --services | grep -vx worker)
  docker compose --profile tunnel up -d --no-build --remove-orphans "${services[@]}"
  log "worker 교체 — 진행 중인 작업이 있으면 끝날 때까지 기다린다"
  docker compose --profile tunnel up -d --no-build --no-deps worker

  # ── 4. 디스크 정리 ──────────────────────────────────────────────────────
  # 매 배포 빌드 캐시와 worker 가 빌드한 사용자 앱 이미지가 쌓여 루트 디스크가 찬다 (#257).
  # best-effort: `|| ...` 로 부르므로 함수 안에서는 set -e 가 꺼지고, 실패해도 배포는 성공이다
  cleanup_disk || log "디스크 정리 중 오류 — 무시한다"
  docker compose --profile tunnel ps

  # ── 5. 배포 기록 ────────────────────────────────────────────────────────
  # 모든 서비스가 올라온 뒤(compose 가 postgres healthy · migrate 완료를 기다렸다)라 DB 가 준비돼 있다
  record_deploy success
  log "done"
}

main "$@"
exit $?
