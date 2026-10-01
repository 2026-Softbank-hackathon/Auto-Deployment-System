/**
 * packages/analyzer/src/ir-builder.ts
 *
 * 감지 결과 → 부분 IR 조립.
 * IrSchema로 최종 검증하고 실패 시 unresolved에 기록한다.
 *
 * 근거: D-35 (IR = 앱 요구만), D-47 (규칙 기반 + AI는 빈칸만)
 */

import { IrSchema } from "@camellia/ir-schema";
import type { Ir, IrService, IrResource } from "@camellia/ir-schema";
import type {
  AnalysisResult,
  ServiceCandidate,
  ResourceCandidate,
  Warning,
  UnresolvedField,
} from "./types.js";

export type IrBuildInput = {
  appName: string;
  appVersion: string;
  services: ServiceCandidate[];
  resources: ResourceCandidate[];
  warnings: Warning[];
  unresolved: UnresolvedField[];
};

export type IrBuildResult = {
  ir_draft: Partial<Ir>;
  ir_valid: boolean;
  ir_errors?: string[];
  unresolved: UnresolvedField[];
};

/**
 * 감지 결과를 IR 초안으로 조립한다.
 * deploy.profile = "aws-ecs-basic" 기본값, unresolved에도 기록 (오케스트레이터가 덮어씀).
 */
export function buildIr(input: IrBuildInput): IrBuildResult {
  const unresolved: UnresolvedField[] = [...input.unresolved];

  // ------------------------------------------------------------------
  // metadata
  // ------------------------------------------------------------------
  const metadata = {
    name: sanitizeName(input.appName),
    version: input.appVersion || "0.0.1",
  };

  // ------------------------------------------------------------------
  // services map
  // ------------------------------------------------------------------
  const servicesMap: Record<string, IrService> = {};

  for (const svc of input.services) {
    const serviceName = sanitizeName(svc.name);

    // type: map "unknown" → "http" with unresolved note
    let serviceType: IrService["type"] = "http";
    if (svc.type === "http" || svc.type === "worker" || svc.type === "static" || svc.type === "job") {
      serviceType = svc.type;
    } else {
      unresolved.push({
        path: `services.${serviceName}.type`,
        reason: "Service type could not be determined from rules; defaulting to http",
      });
    }

    const serviceEntry: IrService = {
      type: serviceType,
      expose: "public",
      size: "small",
      health: { path: "/health", expected_status: 200, timeout_seconds: 3 },
    };

    // build
    if (svc.dockerfile) {
      serviceEntry.build = { dockerfile: svc.dockerfile };
    }

    // command
    if (svc.command && svc.command.length > 0) {
      serviceEntry.command = svc.command;
    } else {
      unresolved.push({
        path: `services.${serviceName}.command`,
        reason: "No start command found in package.json scripts.start, main field, or Dockerfile CMD",
      });
    }

    // port
    if (svc.port !== undefined) {
      serviceEntry.port = svc.port;
    }

    // env
    if (svc.env_names.length > 0) {
      serviceEntry.env = svc.env_names;
    }

    servicesMap[serviceName] = serviceEntry;
  }

  // If no services were detected, create a placeholder
  if (Object.keys(servicesMap).length === 0) {
    unresolved.push({
      path: "services",
      reason: "No services detected; IR will fail schema validation",
    });
  }

  // ------------------------------------------------------------------
  // resources map
  // ------------------------------------------------------------------
  const resourcesMap: Record<string, IrResource> = {};
  for (const res of input.resources) {
    if (res.type === "unknown") continue; // skip unknown
    if (res.type === "postgres" || res.type === "mysql" || res.type === "redis" || res.type === "object_storage") {
      resourcesMap[res.name] = { type: res.type };
    }
  }

  // ------------------------------------------------------------------
  // deploy — default profile, mark unresolved for orchestrator override
  // ------------------------------------------------------------------
  const deploy = { profile: "aws-ecs-basic" };
  unresolved.push({
    path: "deploy.profile",
    reason: "Default profile 'aws-ecs-basic' applied; orchestrator will prompt user to confirm or change",
  });

  // ------------------------------------------------------------------
  // Assemble draft
  // ------------------------------------------------------------------
  const draft: Partial<Ir> = {
    $ir_version: "0.1.0",
    metadata,
    services: Object.keys(servicesMap).length > 0 ? servicesMap : undefined,
    resources: Object.keys(resourcesMap).length > 0 ? resourcesMap : undefined,
    deploy,
  };

  // ------------------------------------------------------------------
  // Validate with IrSchema
  // ------------------------------------------------------------------
  const parseResult = IrSchema.safeParse(draft);

  if (parseResult.success) {
    return {
      ir_draft: parseResult.data,
      ir_valid: true,
      unresolved,
    };
  }

  const ir_errors = parseResult.error.errors.map(
    (e) => `${e.path.join(".")}: ${e.message}`
  );

  return {
    ir_draft: draft,
    ir_valid: false,
    ir_errors,
    unresolved,
  };
}

/**
 * 서비스/앱 이름을 IR에 사용 가능한 소문자-하이픈 형식으로 정규화.
 */
export function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "app";
}
