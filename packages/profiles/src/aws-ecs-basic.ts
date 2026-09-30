import type { Profile } from "./types.js";

export const awsEcsBasic: Profile = {
  id: "aws-ecs-basic",
  cloud: "aws",
  description: "AWS ECS Fargate + ALB + (P1) RDS 최소 프로필",
  version: "0.1.0",
  capabilities: {
    service_types: ["http", "worker", "job"],
    resource_types: ["postgres"],
    sizes: ["small", "medium", "large"],
    supports_public_expose: true,
    supports_internal_expose: true,
    max_services: 10,
  },
  runtime: {
    type: "ecs-fargate",
    replicas: 1,
    size_map: {
      small: { vcpu: 0.25, memory_mib: 512 },
      medium: { vcpu: 0.5, memory_mib: 1024 },
      large: { vcpu: 1, memory_mib: 2048 },
    },
  },
  ingress: {
    type: "alb",
    https: true,
  },
  default_region: "ap-northeast-2",
  terraform_module_ref: "infra/terraform/profiles/aws-ecs-basic",
};
