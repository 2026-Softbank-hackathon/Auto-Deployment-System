#!/usr/bin/env bash
set -euo pipefail

profile="${1:?usage: run-live-case.sh <profile>}"
: "${TEST_RUN_ID:?TEST_RUN_ID is required}"

export API_BASE_URL="${API_BASE_URL:-https://console.camellia-deploy.app/api/v1}"
export AWS_PROFILE="${AWS_PROFILE:-SB-hackathon}"
export AWS_REGION="${AWS_REGION:-ap-northeast-2}"
: "${SSM_INSTANCE_ID:?SSM_INSTANCE_ID is required}"
: "${LIVE_API_TOKEN_PARAMETER:?LIVE_API_TOKEN_PARAMETER is required}"
api_token_parameter="$LIVE_API_TOKEN_PARAMETER"
run_dir="${PERF_RESULTS_DIR:-tests/performance/results}/${TEST_RUN_ID}"

API_TOKEN="$(aws --profile "$AWS_PROFILE" --region "$AWS_REGION" ssm get-parameter \
  --name "$api_token_parameter" --with-decryption --query 'Parameter.Value' --output text)"
export API_TOKEN
trap 'unset API_TOKEN' EXIT

bash tests/performance/run.sh "$profile"
node tests/performance/scripts/collect-ssm-db.mjs "$run_dir"
node tests/performance/scripts/report.mjs "$run_dir"
bash tests/performance/archive-run.sh "$run_dir"

printf '[performance-live] archived=%s\n' "docs/performance-results/${TEST_RUN_ID}"
