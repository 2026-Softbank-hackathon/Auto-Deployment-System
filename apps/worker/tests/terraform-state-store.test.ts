import { DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { S3TerraformStateStore } from "../src/terraform-state-store.js";

const location = {
  bucket: "camellia-terraform-state",
  region: "ap-northeast-2",
  key: "projects/24/environments/5/terraform.tfstate",
  credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
};

describe("S3TerraformStateStore (#247)", () => {
  it("대상 연결의 자격 증명 · backend region 으로 state 를 확인하고 지운다", async () => {
    const send = vi.fn(async () => ({}));
    const createClient = vi.fn(() => ({ send }));
    const store = new S3TerraformStateStore(createClient as never);

    await expect(store.exists(location)).resolves.toBe(true);
    await store.delete(location);

    expect(createClient).toHaveBeenCalledWith("ap-northeast-2", location.credentials);
    const [head, del] = send.mock.calls.map((call) => (call as unknown as [unknown])[0]);
    expect(head).toBeInstanceOf(HeadObjectCommand);
    expect((head as HeadObjectCommand).input).toEqual({ Bucket: location.bucket, Key: location.key });
    expect(del).toBeInstanceOf(DeleteObjectCommand);
    expect((del as DeleteObjectCommand).input).toEqual({ Bucket: location.bucket, Key: location.key });
  });

  it("state 가 없으면 false, 다른 오류(권한 등)는 그대로 던진다", async () => {
    const notFound = new S3TerraformStateStore(() => ({
      send: vi.fn(async () => { throw Object.assign(new Error("nf"), { name: "NotFound" }); }),
    }) as never);
    await expect(notFound.exists(location)).resolves.toBe(false);

    const denied = new S3TerraformStateStore(() => ({
      send: vi.fn(async () => { throw Object.assign(new Error("denied"), { name: "Forbidden" }); }),
    }) as never);
    await expect(denied.exists(location)).rejects.toThrow("denied");
  });
});
