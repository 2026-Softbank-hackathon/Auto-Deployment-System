export type { Storage, StorageBackend, LocalStorageOptions } from "./types.js";
export { LocalStorage } from "./local.js";

import { LocalStorage } from "./local.js";
import type { Storage, LocalStorageOptions } from "./types.js";

export type CreateStorageOptions = LocalStorageOptions & {
  type?: "local";
};

export function createStorage(options: CreateStorageOptions): Storage {
  const type = options.type ?? "local";
  if (type === "local") {
    return new LocalStorage(options);
  }
  throw new Error(`Unsupported storage type: "${type}"`);
}
