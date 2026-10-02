#!/usr/bin/env bash
set -euo pipefail

run_dir="${1:?usage: archive-run.sh <run-dir>}"
run_id="$(basename "$run_dir")"
archive_dir="docs/performance-results/$run_id"
mkdir -p "$archive_dir"

for file in metadata.json k6-summary.json submissions.json deployments.json db-metrics.json summary.csv report.md report.html; do
  if [[ -f "$run_dir/$file" ]]; then
    cp "$run_dir/$file" "$archive_dir/$file"
  fi
done

printf '[performance] archived=%s\n' "$archive_dir"
