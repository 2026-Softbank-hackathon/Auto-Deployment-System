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
  default_region: "ap-northeast-2",
  terraform_module_ref: "TODO(은영): packages/profiles/terraform/aws-ecs-basic",
};
