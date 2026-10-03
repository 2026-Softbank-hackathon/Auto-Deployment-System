import { api, CliError } from "./http.mjs";
import { confirm } from "./prompt.mjs";
import { renderPath } from "./template.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 플랫폼이 다시 배포되는 동안(502 · 연결 끊김) 기다려 주는 최대 시간 */
const OUTAGE_LIMIT_MS = 5 * 60_000;

function elapsed(startedAt) {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

async function decide(spec, id, gate, decision, note) {
  try {
    await api(renderPath(spec.approvals, { id }), { method: "POST", body: { gate, decision, note } });
  } catch (error) {
    // 다른 곳(웹 콘솔 · 서버)이 먼저 처리했으면 그대로 이어 간다
    if (error instanceof CliError && error.code === "APPROVAL_GATE_NOT_PENDING") return;
    throw error;
  }
}

/**
 * 배포를 끝날 때까지 따라간다. 서버가 준 follower 정의(상태 이름 · 자동 승인 · 물어볼 승인)대로 움직인다.
 * Ctrl+C 로 멈춰도 배포는 서버에서 계속된다.
 */
export async function followDeployment(spec, id, { yes = false, json = false } = {}) {
  const startedAt = Date.now();
  const handled = new Set();
  let last = null;
  let outageSince = null;
  if (!json) console.log(`Watching deployment ${id} (Ctrl+C stops watching; the deployment keeps going)`);
  for (;;) {
    let deployment;
    try {
      deployment = await api(renderPath(spec.status, { id }));
    } catch (error) {
      // 플랫폼이 잠깐 내려가도 배포는 서버에서 계속된다 — 다시 붙을 때까지 기다린다
      if (!(error instanceof CliError && error.transient)) throw error;
      if (outageSince === null) {
        outageSince = Date.now();
        if (!json) console.log(`  [${elapsed(startedAt)}] Server unavailable, retrying... (${error.message.split("\n")[0]})`);
      }
      if (Date.now() - outageSince > OUTAGE_LIMIT_MS) throw error;
      await sleep(spec.intervalMs * 2);
      continue;
    }
    if (outageSince !== null) {
      outageSince = null;
      if (!json) console.log(`  [${elapsed(startedAt)}] Server is back`);
    }
    const status = deployment.status;
    if (status !== last) {
      if (!json) console.log(`  [${elapsed(startedAt)}] ${spec.labels[status] ?? status} (${status})`);
      last = status;
    }

    if (spec.succeeded.includes(status)) {
      if (json) console.log(JSON.stringify(deployment, null, 2));
      else console.log(`Succeeded. URL: ${deployment.publicUrl ?? "-"}`);
      return 0;
    }
    if (spec.failed.includes(status)) {
      if (json) console.log(JSON.stringify(deployment, null, 2));
      else {
        console.error(`Deployment ended as ${spec.labels[status] ?? status}.${deployment.error ? ` Error: ${deployment.error}` : ""}`);
        console.error(`  Diagnosis: camellia diagnosis ${id}   Logs: camellia logs ${id} --step build`);
      }
      return 3;
    }

    const key = `${status}`;
    if (!handled.has(key)) {
      const autoGate = spec.autoApprove[status];
      const askSpec = spec.ask[status];
      if (autoGate) {
        handled.add(key);
        await decide(spec, id, autoGate, "approve", "auto-approved by CLI");
      } else if (askSpec) {
        handled.add(key);
        const approve = yes || (await confirm(`  ${askSpec.question}`));
        await decide(spec, id, askSpec.gate, approve ? "approve" : "reject", approve ? "approved in CLI" : "rejected in CLI");
        if (!json) console.log(`  ${approve ? "Approved" : "Skipped; continuing with the original source"}`);
      }
    }
    await sleep(spec.intervalMs);
  }
}
