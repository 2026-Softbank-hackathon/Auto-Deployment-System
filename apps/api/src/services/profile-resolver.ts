/**
 * apps/api/src/services/profile-resolver.ts
 * POST /deployments 의 target (벤더) · IR · 배포 형태 → 실제 profile ID 매핑.
 * 규칙은 프로필 카탈로그(@camellia/profiles)의 resolveProfile 한 곳에 둔다.
 */
import {
  resolveProfile as resolveCatalogProfile,
  type ResolveProfileOptions,
} from "@camellia/profiles";
import type { TargetVendor } from "@camellia/contracts";

export function resolveProfile(
  vendor: TargetVendor,
  ir?: unknown,
  options?: ResolveProfileOptions,
): string {
  return resolveCatalogProfile(vendor, ir, options);
}
