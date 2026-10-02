/**
 * apps/worker/src/handlers/address-change.ts
 *
 * 앱 주소 변경 (#301) — PATCH /projects/:id/subdomain 이 넣은 address-change 잡.
 * 1. 새 주소를 지금 서비스 중인 origin 에 연결 (ALB CNAME · 온프레미스 Tunnel ingress + CNAME). 예전 주소는 그대로
 * 2. 새 주소를 배포 때와 같은 최종 URL 검증(앱 헬스체크)으로 확인
 * 3. 성공: projects.subdomain 을 바꾸고 예전 주소 레코드 · ingress 를 지운다 (정리 실패는 경고만)
 *    실패: 새 주소만 지우고 예전 주소를 그대로 둔다 → address_change_status=failed + 이유
 * 정적 사이트(S3)는 버킷 이름이 주소와 같아야 해서 지원하지 않는다 (API 가 먼저 막고, 여기서도 확인).
 * 주소 변경 중에는 API 가 배포 · 앱 삭제를 막으므로 그 사이 origin 이 바뀌지 않는다.
 */

import { createDeploymentPlan } from "@camellia/adapters";
import { projectSubdomain } from "@camellia/contracts";
import { IrSchema } from "@camellia/ir-schema";
import type { WorkerDeps } from "../deps.js";
import { OriginActivationError, type ServiceAliasReceipt } from "../origin-activation.js";
import type { VerifyJobPayload, VerifyRuntime } from "./verify.js";

export type AddressChangeJobPayload = {
  project_id: number | string;
};

type ProjectRow = {
  id: number | string;
  subdomain: string | null;
  address_change_status: string | null;
  address_change_to: string | null;
};

type LiveDeploymentRow = {
  id: number | string;
  target_profile: string | null;
  target_environment_id: number | string | null;
  ir_json: unknown;
};

/** IR 을 읽지 못한 옛 배포 — 플랫폼 기본 헬스체크 */
const FALLBACK_HEALTH: VerifyJobPayload["health"] = { path: "/health", expectedStatus: 200, timeoutMs: 5000 };

class AddressChangeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AddressChangeError";
  }
}

const defaultRuntime: VerifyRuntime = {
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export async function handleAddressChange(
  job: { data: AddressChangeJobPayload },
  deps: WorkerDeps,
  runtime: VerifyRuntime = defaultRuntime,
): Promise<void> {
  const projectId = Number(job.data.project_id);
  if (!Number.isSafeInteger(projectId) || projectId < 1) {
    deps.log?.error({ project_id: job.data.project_id }, "address-change: invalid project id");
    return;
  }

  const projectResult = await deps.pool.query<ProjectRow>(
    `SELECT id, subdomain, address_change_status, address_change_to FROM projects WHERE id = $1`,
    [projectId],
  );
  const project = projectResult.rows[0];
  // 지워졌거나 이미 끝난 요청(중복 잡)이면 할 일이 없다
  if (!project || project.address_change_status !== "changing" || !project.address_change_to) {
    deps.log?.info({ project_id: projectId }, "address-change: no address change in progress — skipped");
    return;
  }
  const from = projectSubdomain(project.subdomain, projectId);
  const to = project.address_change_to;

  let alias: ServiceAliasReceipt | null = null;
  try {
    const { originActivator, finalUrlVerifier } = deps;
    if (!originActivator || !finalUrlVerifier) throw new AddressChangeError("ADDRESS_CHANGE_DEPENDENCY_MISSING");

    const live = await loadLiveDeployment(deps, projectId);
    if (!live) {
      // 연결된 주소가 없다 — 바꾸기만 한다 (API 가 보통 바로 처리하지만 그 사이 상황이 바뀐 경우)
      await applyNewSubdomain(deps, projectId, to);
      return;
    }
    if (live.target_profile === "aws-static-basic") throw new AddressChangeError("ADDRESS_CHANGE_STATIC_UNSUPPORTED");

    alias = await originActivator.addServiceAlias({ projectId, fromSubdomain: from, toSubdomain: to });
    deps.log?.info({ project_id: projectId, hostname: alias.hostname, origin: alias.origin }, "address-change: new address connected");

    let verifyFailure: string | null = null;
    try {
      const result = await finalUrlVerifier.verify(
        {
          deploymentId: Number(live.id),
          environmentId: String(live.target_environment_id ?? ""),
          serviceHostname: alias.hostname,
          health: healthFor(live),
        },
        runtime,
      );
      if (result.status !== "passed") verifyFailure = result.failureReason ?? "max_attempts_exceeded";
    } catch (error) {
      deps.log?.warn({ project_id: projectId, err: error }, "address-change: final URL verification error");
      verifyFailure = "verify_error";
    }
    if (verifyFailure) throw new AddressChangeError(`ADDRESS_VERIFY_FAILED\n${verifyFailure}`);

    if (!(await applyNewSubdomain(deps, projectId, to))) {
      // 검증하는 사이 요청이 취소 · 교체됐다 — 이번 새 주소는 쓰지 않는다
      await removeAlias(deps, projectId, alias);
      return;
    }
    alias = null;
    const failures = await originActivator.removeServiceHostname({ projectId, subdomain: from });
    if (failures.length > 0) {
      deps.log?.warn({ project_id: projectId, failures }, "address-change: 예전 주소를 일부 정리하지 못했습니다");
    }
    deps.log?.info({ project_id: projectId, from, to }, "address-change: succeeded");
  } catch (error) {
    const code = normalizeFailure(error);
    deps.log?.error({ project_id: projectId, error_code: code, err: error }, "address-change failed");
    if (alias) await removeAlias(deps, projectId, alias);
    await deps.pool.query(
      `UPDATE projects SET address_change_status = 'failed', address_change_error = $2,
              address_change_finished_at = NOW()
       WHERE id = $1 AND address_change_status = 'changing'`,
      [projectId, code],
    );
  }
}

/** 지금 프로젝트 주소로 서비스 중인 배포 = 가장 최근에 성공한 배포 (project-service 와 같은 규칙) */
async function loadLiveDeployment(deps: WorkerDeps, projectId: number): Promise<LiveDeploymentRow | null> {
  const result = await deps.pool.query<LiveDeploymentRow>(
    `SELECT d.id, d.target_profile, d.target_environment_id, ir.ir_json
     FROM deployments d
     LEFT JOIN LATERAL (
       SELECT ir_json FROM ir_versions WHERE deployment_id = d.id ORDER BY id DESC LIMIT 1
     ) ir ON TRUE
     WHERE d.id = (
       SELECT ld.id FROM deployments ld
       WHERE ld.project_id = $1 AND ld.status = 'succeeded'
       ORDER BY ld.succeeded_at DESC NULLS LAST, ld.id DESC
       LIMIT 1
     )`,
    [projectId],
  );
  return result.rows[0] ?? null;
}

/** 배포 때 최종 URL 검증과 같은 헬스체크 — 서비스 중인 배포의 IR · 프로필로 만든 plan 의 health */
function healthFor(live: LiveDeploymentRow): VerifyJobPayload["health"] {
  try {
    const plan = createDeploymentPlan(IrSchema.parse(live.ir_json), live.target_profile ?? "");
    return {
      path: plan.health.path,
      expectedStatus: plan.health.expectedStatus,
      timeoutMs: plan.health.timeoutSeconds * 1000,
    };
  } catch {
    return FALLBACK_HEALTH;
  }
}

/** 요청이 그대로일 때만 바꾼다. 바꿨으면 true */
async function applyNewSubdomain(deps: WorkerDeps, projectId: number, to: string): Promise<boolean> {
  const result = await deps.pool.query(
    `UPDATE projects SET subdomain = $2, address_change_status = 'succeeded', address_change_error = NULL,
            address_change_finished_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND address_change_status = 'changing' AND address_change_to = $2
     RETURNING id`,
    [projectId, to],
  );
  return result.rows.length > 0;
}

async function removeAlias(deps: WorkerDeps, projectId: number, alias: ServiceAliasReceipt): Promise<void> {
  try {
    await deps.originActivator?.removeServiceAlias(alias);
  } catch (error) {
    deps.log?.warn({ project_id: projectId, hostname: alias.hostname, err: error }, "address-change: 새 주소를 지우지 못했습니다");
  }
}

function normalizeFailure(error: unknown): string {
  if (error instanceof AddressChangeError || error instanceof OriginActivationError) return error.code;
  if (error instanceof Error && (error as { code?: string }).code === "23505") return "SUBDOMAIN_TAKEN";
  return "ADDRESS_CHANGE_FAILED";
}
