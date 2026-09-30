/**
 * apps/api/src/services/profile-resolver.ts
 * POST /deployments 의 target (벤더) → 실제 profile ID 매핑.
 * MVP 는 defaultProfileFor(vendor) 로 1:1. P2 확장 여지로 ir 파라미터 열어둠.
 */
import { defaultProfileFor } from "@camellia/profiles";
import type { TargetVendor } from "@camellia/contracts";

export function resolveProfile(vendor: TargetVendor, _ir?: unknown): string {
  // TODO(P2): ir 기반 capabilities 매칭으로 후보 필터링 후 default 선택으로 확장
  return defaultProfileFor(vendor);
}
