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
  default_region: "local",
  terraform_module_ref: "TODO(은영): 온프레미스는 Compose 렌더러라 Terraform 아님",
};
