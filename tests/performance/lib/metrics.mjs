export function percentile(values, ratio) {
  const numbers = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (numbers.length === 0) return null;
  if (numbers.length === 1) return numbers[0];

  const position = (numbers.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return Math.round(numbers[lower] + (numbers[upper] - numbers[lower]) * weight);
}

export function extractDeploymentEvents(raw) {
  const deployments = new Map();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let point;
    try {
      point = JSON.parse(line);
    } catch {
      continue;
    }
    if (point?.type !== "Point" || point?.metric !== "camellia_deployment_created") continue;
    const tags = point.data?.tags ?? {};
    const deploymentId = stringValue(tags.deployment_id);
    if (!deploymentId || deployments.has(deploymentId)) continue;
    deployments.set(deploymentId, {
      deploymentId,
      projectId: stringValue(tags.project_id),
      target: stringValue(tags.target),
      environmentId: stringValue(tags.environment_id),
      acceptedAt: stringValue(point.data?.time),
      testRunId: stringValue(tags.test_run_id),
    });
  }
  return [...deployments.values()];
}

export function buildPhaseStats(phases) {
  const grouped = new Map();
  for (const phase of phases) {
    if (!phase?.name) continue;
    const current = grouped.get(phase.name) ?? { queue: [], execution: [] };
    if (Number.isFinite(phase.queueWaitMs)) current.queue.push(phase.queueWaitMs);
    if (Number.isFinite(phase.executionMs)) current.execution.push(phase.executionMs);
    grouped.set(phase.name, current);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, values]) => ({
      name,
      count: Math.max(values.queue.length, values.execution.length),
      queueWaitMedianMs: percentile(values.queue, 0.5),
      queueWaitP95Ms: percentile(values.queue, 0.95),
      executionMedianMs: percentile(values.execution, 0.5),
      executionP95Ms: percentile(values.execution, 0.95),
    }));
}

export function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function durationMs(start, end) {
  const startMs = Date.parse(start ?? "");
  const endMs = Date.parse(end ?? "");
  return Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null;
}

function stringValue(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
