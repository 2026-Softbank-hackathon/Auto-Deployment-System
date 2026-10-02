import http from "k6/http";
import { check, sleep } from "k6";

const baseUrl = (__ENV.API_BASE_URL || "https://console.camellia-deploy.app").replace(/\/$/, "");
const iterations = numberEnv("ITERATIONS", 10);
const vus = numberEnv("VUS", 1);

export const options = {
  scenarios: {
    health_smoke: {
      executor: "shared-iterations",
      vus,
      iterations,
      maxDuration: __ENV.MAX_DURATION || "1m",
      tags: { test_run_id: __ENV.TEST_RUN_ID || "manual" },
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: [`p(95)<${numberEnv("HEALTH_P95_MS", 1000)}`],
    checks: ["rate==1"],
  },
};

export default function () {
  const response = http.get(`${baseUrl}/health`, { tags: { endpoint: "health" } });
  check(response, {
    "health status is 200": (res) => res.status === 200,
    "health body is ok": (res) => {
      try {
        return res.json("status") === "ok";
      } catch {
        return false;
      }
    },
  });
  sleep(numberEnv("SLEEP_SECONDS", 0.1));
}

function numberEnv(name, fallback) {
  const parsed = Number(__ENV[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
