/**
 * apps/worker/src/profile-sync.ts
 *
 * IR 기반 프로필 자동 선택 (#273). 배포를 만들 때는 IR 을 몰라 벤더 기본 프로필을 넣어 두고,
 * 분석이 끝나 IR 을 알게 되면 profiles 카탈로그 규칙(resolveProfileAfterAnalysis)으로 다시 골라
 * deployments.target_profile 을 갱신한다. IR 의 deploy.profile 은 호출자가 반환값으로 맞춘다.
 */
import type { Pool } from "@camellia/db";
import { resolveProfileAfterAnalysis } from "@camellia/profiles";

export async function syncTargetProfile(
  pool: Pick<Pool, "query">,
  deploymentId: number,
  currentProfile: string | null | undefined,
  ir: unknown,
): Promise<{ profile: string | null; changed: boolean }> {
  if (!currentProfile) return { profile: currentProfile ?? null, changed: false };
  const profile = resolveProfileAfterAnalysis(currentProfile, ir);
  if (profile === currentProfile) return { profile, changed: false };
  await pool.query(
    "UPDATE deployments SET target_profile = $1, updated_at = NOW() WHERE id = $2",
    [profile, deploymentId],
  );
  return { profile, changed: true };
}

/** IR(JSON) 의 deploy.profile 을 바꾼 사본 */
export function withDeployProfile(
  ir: Record<string, unknown>,
  profile: string,
): Record<string, unknown> {
  const deploy = (ir["deploy"] ?? {}) as Record<string, unknown>;
  return { ...ir, deploy: { ...deploy, profile } };
}
