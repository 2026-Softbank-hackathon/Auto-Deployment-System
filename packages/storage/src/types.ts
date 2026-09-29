export type StorageBackend = "local" | "minio" | "s3";

export interface Storage {
  put(key: string, buffer: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  presignUrl(key: string, opts?: { expiresInSeconds?: number }): Promise<string>;
  listKeys(prefix: string): Promise<string[]>;
}

export type LocalStorageOptions = {
  rootDir: string;
  publicBaseUrl?: string;
};
