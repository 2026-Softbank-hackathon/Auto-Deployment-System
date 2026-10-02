#!/usr/bin/env bash
set -uo pipefail

if [[ "${1:-}" == "--" ]]; then shift; fi
profile="${1:-health}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
export PROFILE="$profile"
export TEST_RUN_ID="${TEST_RUN_ID:-${timestamp}-${profile}}"
results_root="${PERF_RESULTS_DIR:-tests/performance/results}"
run_dir="${results_root}/${TEST_RUN_ID}"

mkdir -p "$run_dir"
node tests/performance/scripts/write-metadata.mjs "$run_dir"

if [[ "$profile" == "health" ]]; then
  script="tests/performance/k6/health-smoke.js"
else
  script="tests/performance/k6/deployment-submit.js"
fi

set +e
k6 run \
  --summary-export "$run_dir/k6-summary.json" \
  --out "json=$run_dir/k6-points.json" \
  "$script" 2>&1 | tee "$run_dir/k6-console.log"
k6_status=${PIPESTATUS[0]}
set -e

node tests/performance/scripts/collect.mjs "$run_dir"
node tests/performance/scripts/report.mjs "$run_dir"

printf '[performance] run_id=%s k6_status=%s report=%s/report.html\n' "$TEST_RUN_ID" "$k6_status" "$run_dir"
exit "$k6_status"
