import type { Ir } from "@camellia/ir-schema";
import type { Profile } from "@camellia/profiles";
import { AdapterError } from "./errors.js";
import type { CommonDeploymentPlan, ResourcePlan, RoutePlan } from "./types.js";

export type CommonPlanOptions = {
  /** 이 환경이 직접 만들어 주는 관리형 리소스 종류 (예: AWS 의 postgres) */
  managedResourceTypes?: readonly string[];
};

export function createCommonPlan(
  ir: Ir,
  profile: Profile,
  options: CommonPlanOptions = {},
): CommonDeploymentPlan {
  const services = Object.entries(ir.services);
  if (services.length !== 1 || services[0]?.[1].type !== "http") {
    throw new AdapterError(
      "P0_SINGLE_HTTP_SERVICE_REQUIRED",
      "P0 Adapter는 단일 HTTP 서비스만 지원합니다.",
    );
  }

  // 환경이 만들어 주지 못하는 리소스라도 앱에 로컬 대체 저장소(local_fallback)가 있으면
  // 접속 정보 없이 실행한다 — 온프레미스의 SQLite 유지 (#276)
  const resources: ResourcePlan[] = Object.entries(ir.resources ?? {}).map(
    ([name, resource]) => ({
      name,
      type: resource.type,
      ...(resource.connection_env ? { connectionEnv: resource.connection_env } : {}),
      ...(resource.local_fallback ? { localFallback: resource.local_fallback } : {}),
    }),
  );
  const managed = new Set(options.managedResourceTypes ?? []);
  if (resources.some((resource) => !managed.has(resource.type) && !resource.localFallback)) {
    throw new AdapterError(
      "P0_RESOURCES_UNSUPPORTED",
      "P0 Adapter는 관리형 리소스를 지원하지 않습니다.",
    );
  }
  // 리소스 접속 정보는 사용자가 등록하는 환경변수가 아니다 — 리소스를 만드는 환경이 주입한다
  const resourceEnvNames = new Set(
    resources.flatMap((resource) => (resource.connectionEnv ? [resource.connectionEnv] : [])),
  );

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
      environmentNames: (service.env ?? []).filter((name) => !resourceEnvNames.has(name)),
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
    resources,
  };
}
