/**
 * apps/worker/src/terraform-state-store.ts
 *
 * Terraform S3 backend 의 state 파일 확인 · 삭제 (앱 삭제, #247).
 * Terraform 이 backend 에 쓰는 자격 증명(대상 연결의 AWS 키)을 그대로 쓴다.
 */

import {
  DeleteObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { TerraformAwsCredentials } from "./terraform-cli.js";

export type TerraformStateLocation = {
  bucket: string;
  region: string;
  key: string;
  credentials: TerraformAwsCredentials;
};

export interface TerraformStateStore {
  exists(location: TerraformStateLocation): Promise<boolean>;
  delete(location: TerraformStateLocation): Promise<void>;
}

type S3ClientLike = Pick<S3Client, "send">;

export class S3TerraformStateStore implements TerraformStateStore {
  constructor(
    private readonly createClient: (
      region: string,
      credentials: TerraformAwsCredentials,
    ) => S3ClientLike = (region, credentials) => new S3Client({ region, credentials }),
  ) {}

  async exists(location: TerraformStateLocation): Promise<boolean> {
    const client = this.createClient(location.region, location.credentials);
    try {
      await client.send(new HeadObjectCommand({ Bucket: location.bucket, Key: location.key }));
      return true;
    } catch (error) {
      const name = (error as { name?: unknown } | null)?.name;
      if (name === "NotFound" || name === "NoSuchKey") return false;
      throw error;
    }
  }

  async delete(location: TerraformStateLocation): Promise<void> {
    const client = this.createClient(location.region, location.credentials);
    await client.send(new DeleteObjectCommand({ Bucket: location.bucket, Key: location.key }));
  }
}
