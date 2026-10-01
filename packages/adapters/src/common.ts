import type { Ir } from "@camellia/ir-schema";
import type { Profile } from "@camellia/profiles";
import { AdapterError } from "./errors.js";
import type { CommonDeploymentPlan, RoutePlan } from "./types.js";

export function createCommonPlan(
  ir: Ir,
  profile: Profile,
): CommonDeploymentPlan {
  const services = Object.entries(ir.services);
  if (services.length !== 1 || services[0]?.[1].type !== "http") {
    throw new AdapterError(
      "P0_SINGLE_HTTP_SERVICE_REQUIRED",
      "P0 Adapter는 단일 HTTP 서비스만 지원합니다.",
    );
  }

  if (ir.resources && Object.keys(ir.resources).length > 0) {
    throw new AdapterError(
      "P0_RESOURCES_UNSUPPORTED",
      "P0 Adapter는 관리형 리소스를 지원하지 않습니다.",
    );
  }

  const [serviceName, service] = services[0];
  if (service.port === undefined) {
    throw new AdapterError(
      "SERVICE_PORT_REQUIRED",
      `HTTP 서비스 "${serviceName}"에 port가 필요합니다.`,
    );
  }

  const compute = profile.runtime.size_map[service.size];
  if (!compute) {
    throw new AdapterError(
      "SIZE_MAPPING_NOT_FOUND",
      `프로필 "${profile.id}"에 size "${service.size}" 매핑이 없습니다.`,
    );
  }

  const routes: RoutePlan[] = ir.expose?.paths
    ? ir.expose.paths.map((route) => {
        const targetService = ir.services[route.service];
        const port = route.port ?? targetService?.port;
        if (!targetService || port === undefined) {
          throw new AdapterError(
            "ROUTE_TARGET_INVALID",
            `라우팅 대상 서비스 "${route.service}" 또는 port를 확인할 수 없습니다.`,
          );
        }
        return {
          path: route.path,
          service: route.service,
          port,
        };
      })
    : [
        {
          path: "/",
          service: serviceName,
          port: service.port,
        },
      ];

  return {
    schemaVersion: "0.1.0",
    profile: {
      id: profile.id,
      version: profile.version,
    },
    application: {
      name: ir.metadata.name,
      version: ir.metadata.version,
    },
    build: {
      context: service.build?.context ?? ".",
      dockerfile: service.build?.dockerfile,
      buildpack:
        service.build?.buildpack ??
        (service.build?.dockerfile === undefined ? "railpack" : undefined),
    },
    service: {
      name: serviceName,
      type: service.type,
      command: service.command,
      containerPort: service.port,
      environmentNames: service.env ?? [],
      environmentDefaults: service.env_defaults ?? {},
      secretNames: service.secrets ?? [],
      compute: {
        vcpu: compute.vcpu,
        memoryMiB: compute.memory_mib,
      },
    },
    health: {
      path: service.health.path,
      expectedStatus: service.health.expected_status,
      timeoutSeconds: service.health.timeout_seconds,
    },
    ingress: {
      enabled: service.expose !== "none",
      exposure: service.expose,
      type: profile.ingress.type,
      tls: ir.expose?.tls ?? profile.ingress.https,
      domain: ir.expose?.domain,
      routes,
    },
  };
}
