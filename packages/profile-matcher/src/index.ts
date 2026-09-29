/**
 * packages/profile-matcher/src/index.ts
 *
 * IR과 Profile을 대조해서 missing_resources·warnings 반환.
 *
 * 대조 규칙:
 *   1. resources: IR.resources의 각 type이 profile.capabilities.resource_types에 포함
 *   2. services.type: 각 서비스 type이 profile.capabilities.service_types에 포함
 *   3. services.size: 각 서비스 size가 profile.capabilities.sizes에 포함
 *   4. services.expose: "public" → supports_public_expose, "internal" → supports_internal_expose
 *   5. max_services: 초과 시 warning
 *
 * 근거: D-36 (프로필 capabilities), D-37 (빠진 요소 결정), D-46 (원클릭 원칙)
 */

import type { Ir } from "@camellia/ir-schema";
import type { Profile } from "@camellia/profiles";
import { getProfile } from "@camellia/profiles";

export type MissingResource = {
  resource_name: string;
  resource_type: string;
  reason: "not_in_capabilities";
  suggestion?: "add_module" | "exclude";
};

export type ProfileWarning = {
  code: string;
  message: string;
  path: string;
};

export type MatchResult = {
  compatible: boolean;
  missing_resources: MissingResource[];
  warnings: ProfileWarning[];
};

/**
 * IR과 Profile을 대조해 MatchResult를 반환한다.
 *
 * compatible = missing_resources 0개 AND "critical_" 접두사 warning 0개.
 * 규칙 2~5 위반은 non-critical warning으로 처리 (원클릭 원칙, D-46).
 */
export function matchProfile(ir: Ir, profile: Profile): MatchResult {
  const missing_resources: MissingResource[] = [];
  const warnings: ProfileWarning[] = [];

  // Rule 1: resources 대조
  if (ir.resources) {
    for (const [name, resource] of Object.entries(ir.resources)) {
      if (!profile.capabilities.resource_types.includes(resource.type)) {
        missing_resources.push({
          resource_name: name,
          resource_type: resource.type,
          reason: "not_in_capabilities",
          suggestion: "add_module",
        });
      }
    }
  }

  // Rules 2-5: services 대조
  for (const [serviceName, service] of Object.entries(ir.services)) {
    // Rule 2: service_types
    if (!profile.capabilities.service_types.includes(service.type)) {
      warnings.push({
        code: "service_type_unsupported",
        message: `서비스 "${serviceName}"의 type "${service.type}"은 프로필 "${profile.id}"에서 지원하지 않습니다.`,
        path: `services.${serviceName}.type`,
      });
    }

    // Rule 3: sizes
    if (!profile.capabilities.sizes.includes(service.size)) {
      warnings.push({
        code: "size_unsupported",
        message: `서비스 "${serviceName}"의 size "${service.size}"은 프로필 "${profile.id}"에서 지원하지 않습니다.`,
        path: `services.${serviceName}.size`,
      });
    }

    // Rule 4: expose
    if (service.expose === "public" && !profile.capabilities.supports_public_expose) {
      warnings.push({
        code: "expose_unsupported",
        message: `서비스 "${serviceName}"의 expose "public"은 프로필 "${profile.id}"에서 지원하지 않습니다.`,
        path: `services.${serviceName}.expose`,
      });
    } else if (service.expose === "internal" && !profile.capabilities.supports_internal_expose) {
      warnings.push({
        code: "expose_unsupported",
        message: `서비스 "${serviceName}"의 expose "internal"은 프로필 "${profile.id}"에서 지원하지 않습니다.`,
        path: `services.${serviceName}.expose`,
      });
    }
  }

  // Rule 5: max_services
  if (
    profile.capabilities.max_services !== undefined &&
    Object.keys(ir.services).length > profile.capabilities.max_services
  ) {
    warnings.push({
      code: "max_services_exceeded",
      message: `IR 서비스 수(${Object.keys(ir.services).length})가 프로필 "${profile.id}"의 최대 서비스 수(${profile.capabilities.max_services})를 초과합니다.`,
      path: "services",
    });
  }

  const hasCriticalWarning = warnings.some((w) => w.code.startsWith("critical_"));
  const compatible = missing_resources.length === 0 && !hasCriticalWarning;

  return { compatible, missing_resources, warnings };
}

/**
 * profileId로 프로필을 조회한 뒤 matchProfile을 실행한다.
 * 프로필이 존재하지 않으면 null 반환.
 */
export function matchProfileById(ir: Ir, profileId: string): MatchResult | null {
  const profile = getProfile(profileId);
  if (profile === null) {
    return null;
  }
  return matchProfile(ir, profile);
}
