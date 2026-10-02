import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPhaseStats,
  csvCell,
  extractDeploymentEvents,
  percentile,
} from "../lib/metrics.mjs";

test("k6 JSON points에서 생성된 deployment를 중복 없이 추출한다", () => {
  const lines = [
    JSON.stringify({
      type: "Point",
      metric: "camellia_deployment_created",
      data: {
        time: "2026-10-02T00:00:00Z",
        value: 1,
        tags: { deployment_id: "101", project_id: "6", target: "aws", test_run_id: "run-1" },
      },
    }),
    JSON.stringify({
      type: "Point",
      metric: "camellia_deployment_created",
      data: {
        time: "2026-10-02T00:00:01Z",
        value: 1,
        tags: { deployment_id: "101", project_id: "6", target: "aws", test_run_id: "run-1" },
      },
    }),
    JSON.stringify({ type: "Metric", metric: "http_req_duration", data: {} }),
  ];

  assert.deepEqual(extractDeploymentEvents(lines.join("\n")), [
    {
      deploymentId: "101",
      projectId: "6",
      target: "aws",
      environmentId: null,
      acceptedAt: "2026-10-02T00:00:00Z",
      testRunId: "run-1",
    },
  ]);
});

test("percentile은 정렬되지 않은 표본을 선형 보간한다", () => {
  assert.equal(percentile([40, 10, 30, 20], 0.5), 25);
  assert.equal(percentile([100], 0.95), 100);
  assert.equal(percentile([], 0.95), null);
});

test("큐 단계 통계는 성공적으로 측정된 값만 집계한다", () => {
  const stats = buildPhaseStats([
    { name: "provision", queueWaitMs: 100, executionMs: 900 },
    { name: "provision", queueWaitMs: 300, executionMs: 1100 },
    { name: "verify", queueWaitMs: null, executionMs: 500 },
  ]);

  assert.deepEqual(stats, [
    {
      name: "provision",
      count: 2,
      queueWaitMedianMs: 200,
      queueWaitP95Ms: 290,
      executionMedianMs: 1000,
      executionP95Ms: 1090,
    },
    {
      name: "verify",
      count: 1,
      queueWaitMedianMs: null,
      queueWaitP95Ms: null,
      executionMedianMs: 500,
      executionP95Ms: 500,
    },
  ]);
});

test("CSV 셀은 쉼표와 따옴표를 안전하게 이스케이프한다", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('a"b'), '"a""b"');
  assert.equal(csvCell(null), "");
});
