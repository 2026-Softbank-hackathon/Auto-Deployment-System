import type { TerraformBackendConfig } from "./terraform-cli.js";

export function loadTerraformBackendConfig(
  env: NodeJS.ProcessEnv = process.env,
): TerraformBackendConfig | undefined {
  const bucket = env["TERRAFORM_STATE_BUCKET"]?.trim();
  const region = env["TERRAFORM_STATE_REGION"]?.trim();
  const kmsKeyId = env["TERRAFORM_STATE_KMS_KEY_ID"]?.trim();
  const configured = [bucket, region, kmsKeyId].filter(Boolean).length;

  if (configured === 0) return undefined;
  if (configured !== 3) {
    throw new Error("TERRAFORM_BACKEND_CONFIG_INCOMPLETE");
  }

  return { bucket: bucket!, region: region!, kmsKeyId: kmsKeyId! };
}
