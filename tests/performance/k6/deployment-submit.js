import http from "k6/http";
import { check } from "k6";
import exec from "k6/execution";
import { Counter, Rate, Trend } from "k6/metrics";

const accepted = new Rate("camellia_deployment_accepted");
const created = new Counter("camellia_deployment_created");
const rejected = new Counter("camellia_deployment_rejected");
const acceptDuration = new Trend("camellia_deployment_accept_duration", true);

const apiBaseUrl = (__ENV.API_BASE_URL || "").replace(/\/$/, "");
const apiToken = __ENV.API_TOKEN || "";
const sourcePath = __ENV.SOURCE_ZIP || "";
const requestKind = __ENV.REQUEST_KIND || "upload";
const projectIds = csv(__ENV.PROJECT_IDS);
const sourceDeploymentIds = csv(__ENV.SOURCE_DEPLOYMENT_IDS);
const environmentIds = csv(__ENV.ENVIRONMENT_IDS);
const targets = csv(__ENV.TARGETS);
const profile = __ENV.PROFILE || "smoke";
const testRunId = __ENV.TEST_RUN_ID || "manual";

if (!apiBaseUrl) throw new Error("API_BASE_URL is required");
if (!apiToken) throw new Error("API_TOKEN is required; it is never written to result files");
if (requestKind === "upload" && !sourcePath) throw new Error("SOURCE_ZIP is required for upload");
if (requestKind === "upload" && projectIds.length === 0) throw new Error("PROJECT_IDS is required for upload");
if (requestKind === "redeploy" && sourceDeploymentIds.length === 0) {
  throw new Error("SOURCE_DEPLOYMENT_IDS is required for redeploy");
}
if (!["upload", "redeploy"].includes(requestKind)) throw new Error(`Unsupported REQUEST_KIND: ${requestKind}`);
if (environmentIds.length === 0 && targets.length === 0) {
  throw new Error("ENVIRONMENT_IDS or TARGETS is required");
}

const source = requestKind === "upload" ? open(sourcePath, "b") : null;
const scenario = scenarioFor(profile);
const expectedAcceptRate = numberEnv("EXPECTED_ACCEPT_RATE", 1);

export const options = {
  scenarios: { deployment_submit: scenario },
  thresholds: {
    camellia_deployment_accepted: [`rate>=${expectedAcceptRate}`],
    camellia_deployment_accept_duration: [
      `p(95)<${numberEnv("ACCEPT_P95_MS", 5000)}`,
    ],
  },
};

export default function () {
  const iteration = Number(exec.scenario.iterationInTest);
  const projectId = pick(projectIds, iteration);
  const sourceDeploymentId = pick(sourceDeploymentIds, iteration);
  const environmentId = pick(environmentIds, iteration);
  const target = pick(targets, iteration);
  const tags = {
    test_run_id: testRunId,
    project_id: projectId,
    target: target || "environment-selected",
    environment_id: environmentId || "none",
    workload_profile: profile,
    request_kind: requestKind,
    source_deployment_id: sourceDeploymentId || "none",
  };

  const response = requestKind === "upload"
    ? submitUpload({ projectId, environmentId, target, tags })
    : submitRedeploy({ sourceDeploymentId, environmentId, tags });

  const isAccepted = response.status === 202;
  accepted.add(isAccepted, tags);
  acceptDuration.add(response.timings.duration, tags);

  if (isAccepted) {
    const deploymentId = safeJson(response, "deploymentId");
    const eventTags = { ...tags, deployment_id: String(deploymentId || "unknown") };
    created.add(1, eventTags);
    console.log(JSON.stringify({
      event: "deployment_accepted",
      deploymentId,
      projectId,
      environmentId: environmentId || null,
      target: target || null,
      sourceDeploymentId: sourceDeploymentId || null,
      requestKind,
      testRunId,
    }));
  } else {
    const errorCode = safeJson(response, "error.code") || `HTTP_${response.status}`;
    rejected.add(1, { ...tags, error_code: String(errorCode) });
    console.error(JSON.stringify({
      event: "deployment_rejected",
      status: response.status,
      errorCode,
      projectId,
      environmentId: environmentId || null,
      target: target || null,
      sourceDeploymentId: sourceDeploymentId || null,
      requestKind,
      testRunId,
    }));
  }

  check(response, {
    "deployment request reached an expected response": (res) =>
      expectedAcceptRate < 1 ? res.status === 202 || res.status === 409 : res.status === 202,
  }, tags);
}

function scenarioFor(name) {
  if (name === "smoke") {
    return { executor: "shared-iterations", vus: 1, iterations: 1, maxDuration: "1m" };
  }
  if (name === "burst2" || name === "burst5") {
    const vus = name === "burst2" ? 2 : 5;
    assertDistinctProjectCapacity(vus);
    return { executor: "per-vu-iterations", vus, iterations: 1, maxDuration: "1m" };
  }
  if (name === "same-project-burst2") {
    return { executor: "per-vu-iterations", vus: 2, iterations: 1, maxDuration: "1m" };
  }
  if (name === "arrival") {
    return {
      executor: "constant-arrival-rate",
      rate: numberEnv("ARRIVAL_RATE", 1),
      timeUnit: __ENV.ARRIVAL_TIME_UNIT || "30s",
      duration: __ENV.ARRIVAL_DURATION || "5m",
      preAllocatedVUs: numberEnv("PRE_ALLOCATED_VUS", 5),
      maxVUs: numberEnv("MAX_VUS", 20),
    };
  }
  throw new Error(`Unsupported PROFILE: ${name}`);
}

function assertDistinctProjectCapacity(vus) {
  if ((__ENV.ALLOW_PROJECT_REUSE || "false") === "true") return;
  const distinctInputs = requestKind === "redeploy" ? sourceDeploymentIds : projectIds;
  if (distinctInputs.length < vus) {
    throw new Error(`${profile} requires at least ${vus} distinct inputs; set ALLOW_PROJECT_REUSE=true only for lock tests`);
  }
}

function submitUpload({ projectId, environmentId, target, tags }) {
  const body = {
    source: http.file(source, sourcePath.split("/").pop() || "source.zip", "application/zip"),
    project_id: projectId,
  };
  if (environmentId) body.environment_id = environmentId;
  else body.target = target;
  return http.post(`${apiBaseUrl}/deployments`, body, {
    headers: { Authorization: `Bearer ${apiToken}` },
    timeout: __ENV.REQUEST_TIMEOUT || "30s",
    tags: { ...tags, endpoint: "create_deployment" },
  });
}

function submitRedeploy({ sourceDeploymentId, environmentId, tags }) {
  return http.post(
    `${apiBaseUrl}/deployments/${sourceDeploymentId}/redeploy`,
    JSON.stringify(environmentId ? { targetEnvironmentId: environmentId } : {}),
    {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      timeout: __ENV.REQUEST_TIMEOUT || "30s",
      tags: { ...tags, endpoint: "redeploy" },
    },
  );
}

function csv(value) {
  return (value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function pick(values, index) {
  return values.length === 0 ? "" : values[index % values.length];
}

function numberEnv(name, fallback) {
  const parsed = Number(__ENV[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function safeJson(response, selector) {
  try {
    return response.json(selector);
  } catch {
    return null;
  }
}
