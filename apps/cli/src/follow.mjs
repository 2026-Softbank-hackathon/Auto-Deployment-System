import { api, CliError } from "./http.mjs";
import { confirm } from "./prompt.mjs";
import { renderPath } from "./template.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  if (!json) console.log(`배포 ${id} 진행을 지켜봐요 (Ctrl+C 로 멈춰도 배포는 계속돼요)`);
  for (;;) {
    const deployment = await api(renderPath(spec.status, { id }));
    const status = deployment.status;
    if (status !== last) {
      if (!json) console.log(`  [${elapsed(startedAt)}] ${spec.labels[status] ?? status} (${status})`);
      last = status;
    }

    if (spec.succeeded.includes(status)) {
      if (json) console.log(JSON.stringify(deployment, null, 2));
      else console.log(`성공했어요. 주소: ${deployment.publicUrl ?? "-"}`);
      return 0;
    }
    if (spec.failed.includes(status)) {
      if (json) console.log(JSON.stringify(deployment, null, 2));
      else {
        console.error(`배포가 ${spec.labels[status] ?? status} 상태로 끝났어요.${deployment.error ? ` 오류: ${deployment.error}` : ""}`);
        console.error(`  원인 보기: camellia diagnosis ${id}  ·  로그: camellia logs ${id} --step build`);
      }
      return 3;
    }

    const key = `${status}`;
    if (!handled.has(key)) {
      const autoGate = spec.autoApprove[status];
      const askSpec = spec.ask[status];
      if (autoGate) {
        handled.add(key);
        await decide(spec, id, autoGate, "approve", "CLI 자동 승인");
      } else if (askSpec) {
        handled.add(key);
        const approve = yes || (await confirm(`  ${askSpec.question}`));
        await decide(spec, id, askSpec.gate, approve ? "approve" : "reject", approve ? "CLI 에서 승인" : "CLI 에서 거절");
        if (!json) console.log(`  ${approve ? "승인했어요" : "적용하지 않고 원래 소스로 이어 가요"}`);
      }
    }
    await sleep(spec.intervalMs);
  }
}
