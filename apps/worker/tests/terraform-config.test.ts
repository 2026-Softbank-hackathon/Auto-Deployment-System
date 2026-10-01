import { describe, expect, it } from "vitest";
import { loadTerraformBackendConfig } from "../src/terraform-config.js";

describe("loadTerraformBackendConfig", () => {
  it("설정이 없으면 AWS-only 개발 실행을 위해 undefined를 반환한다", () => {
    expect(loadTerraformBackendConfig({})).toBeUndefined();
  });

  it("S3 bucket, region, KMS key가 모두 설정되면 backend config를 반환한다", () => {
    expect(
      loadTerraformBackendConfig({
        TERRAFORM_STATE_BUCKET: "camellia-state",
        TERRAFORM_STATE_REGION: "ap-northeast-2",
        TERRAFORM_STATE_KMS_KEY_ID: "arn:aws:kms:ap-northeast-2:123:key/example",
      }),
    ).toEqual({
      bucket: "camellia-state",
      region: "ap-northeast-2",
      kmsKeyId: "arn:aws:kms:ap-northeast-2:123:key/example",
    });
  });

  it("일부 설정만 있으면 시작 시점을 분명한 오류로 거부한다", () => {
    expect(() =>
      loadTerraformBackendConfig({ TERRAFORM_STATE_BUCKET: "camellia-state" }),
    ).toThrow("TERRAFORM_BACKEND_CONFIG_INCOMPLETE");
  });
});
