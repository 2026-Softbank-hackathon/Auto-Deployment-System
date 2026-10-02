import type { Profile } from "./types.js";

export const onpremDockerBasic: Profile = {
  id: "onprem-docker-basic",
  cloud: "onprem",
  description: "Intel Mac VM + Docker Compose + Cloudflare Tunnel",
  version: "0.1.0",
  capabilities: {
    // static: 정적 파일을 담은 nginx 이미지를 http 컨테이너로 실행 (#273)
    service_types: ["http", "worker", "job", "static"],
    resource_types: ["postgres"],
    sizes: ["small", "medium"],
    supports_public_expose: true,
    supports_internal_expose: true,
    max_services: 5,
  },
  runtime: {
    type: "docker-compose",
    replicas: 1,
    size_map: {
      small: { vcpu: 0.25, memory_mib: 512 },
      medium: { vcpu: 0.5, memory_mib: 1024 },
    },
  },
  ingress: {
    type: "cloudflare-tunnel",
    https: true,
  },
  default_region: "local",
};
