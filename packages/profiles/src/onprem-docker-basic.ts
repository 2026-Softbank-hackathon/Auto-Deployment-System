import type { Profile } from "./types.js";

export const onpremDockerBasic: Profile = {
  id: "onprem-docker-basic",
  cloud: "onprem",
  description: "Intel Mac VM + Docker Compose + Cloudflare Tunnel",
  version: "0.1.0",
  capabilities: {
    service_types: ["http", "worker", "job"],
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
