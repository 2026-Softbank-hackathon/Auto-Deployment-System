import { z } from "zod";

export const ProfileCapabilitiesSchema = z.object({
  service_types: z.array(z.enum(["http", "worker", "static", "job"])),
  resource_types: z.array(z.enum(["postgres", "mysql", "redis", "object_storage"])),
  sizes: z.array(z.enum(["small", "medium", "large"])),
  supports_public_expose: z.boolean(),
  supports_internal_expose: z.boolean(),
  max_services: z.number().int().positive().optional(),
});

export const ProfileSchema = z.object({
  id: z.string().min(1),
  cloud: z.enum(["aws", "gcp", "azure", "onprem"]),
  description: z.string(),
  version: z.string(),
  capabilities: ProfileCapabilitiesSchema,
  default_region: z.string().optional(),
  terraform_module_ref: z.string().optional(),
});

export type Profile = z.infer<typeof ProfileSchema>;
export type ProfileCapabilities = z.infer<typeof ProfileCapabilitiesSchema>;
