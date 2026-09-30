#!/bin/sh
# 사용: pnpm-install-if-changed.sh <old-rev> <new-rev>
# 두 커밋 사이에 pnpm-lock.yaml이 바뀌었으면 pnpm install --frozen-lockfile 실행.
# git 작업을 막지 않도록 항상 exit 0.

[ "$SKIP_AUTO_INSTALL" = "1" ] && exit 0

changed=$(git diff --name-only "$1" "$2" -- pnpm-lock.yaml 2>/dev/null)
[ -n "$changed" ] || exit 0

if ! command -v pnpm >/dev/null 2>&1; then
  echo "[githooks] pnpm-lock.yaml changed, but pnpm is not on PATH. Run 'pnpm install' manually." >&2
  exit 0
fi

echo "[githooks] pnpm-lock.yaml changed. Running 'pnpm install --frozen-lockfile' (set SKIP_AUTO_INSTALL=1 to skip)"
if ! pnpm install --frozen-lockfile; then
  echo "[githooks] 'pnpm install --frozen-lockfile' failed. Run 'pnpm install' manually." >&2
fi
exit 0
