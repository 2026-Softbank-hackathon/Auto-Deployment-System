import { z } from "zod";

export const ProfileCapabilitiesSchema = z.object({
  service_types: z.array(z.enum(["http", "worker", "static", "job"])),
  resource_types: z.array(z.enum(["postgres", "mysql", "redis", "object_storage"])),
  sizes: z.array(z.enum(["small", "medium", "large"])),
  supports_public_expose: z.boolean(),
  supports_internal_expose: z.boolean(),
  max_services: z.number().int().positive().optional(),
});

export const ComputeSizeSchema = z.object({
  vcpu: z.number().positive(),
  memory_mib: z.number().int().positive(),
});

export const RuntimeProfileSchema = z.object({
  type: z.enum(["ecs-fargate", "docker-compose", "lambda"]),
  replicas: z.number().int().positive(),
  size_map: z.record(
    z.enum(["small", "medium", "large"]),
    ComputeSizeSchema
  ),
});

export const IngressProfileSchema = z.object({
  type: z.enum(["alb", "cloudflare-tunnel"]),
  https: z.boolean(),
});

export const ProfileSchema = z.object({
  id: z.string().min(1),
  cloud: z.enum(["aws", "gcp", "azure", "onprem"]),
  description: z.string(),
  version: z.string(),
  capabilities: ProfileCapabilitiesSchema,
  runtime: RuntimeProfileSchema,
  ingress: IngressProfileSchema,
  default_region: z.string().optional(),
  terraform_module_ref: z.string().optional(),
});

export type Profile = z.infer<typeof ProfileSchema>;
export type ProfileCapabilities = z.infer<typeof ProfileCapabilitiesSchema>;
export type ComputeSize = z.infer<typeof ComputeSizeSchema>;
export type RuntimeProfile = z.infer<typeof RuntimeProfileSchema>;
export type IngressProfile = z.infer<typeof IngressProfileSchema>;
