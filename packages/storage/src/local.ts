import fs from "node:fs/promises";
import path from "node:path";
import type { Storage, LocalStorageOptions } from "./types.js";

export class LocalStorage implements Storage {
  private readonly rootDir: string;
  private readonly publicBaseUrl: string;

  constructor(options: LocalStorageOptions) {
    this.rootDir = options.rootDir;
    this.publicBaseUrl = options.publicBaseUrl ?? "http://localhost:3000/storage";
  }

  private resolvePath(key: string): string {
    if (key.includes("..")) {
      throw new Error(`Path traversal detected in key: "${key}"`);
    }
    const resolved = path.resolve(this.rootDir, key);
    if (!resolved.startsWith(path.resolve(this.rootDir))) {
      throw new Error(`Path traversal detected in key: "${key}"`);
    }
    return resolved;
  }

  async put(key: string, buffer: Buffer, _contentType?: string): Promise<void> {
    const filePath = this.resolvePath(key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, buffer);
  }

  async get(key: string): Promise<Buffer> {
    const filePath = this.resolvePath(key);
    const data = await fs.readFile(filePath);
    return Buffer.from(data);
  }

  async exists(key: string): Promise<boolean> {
    const filePath = this.resolvePath(key);
    try {
      await fs.stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    const filePath = this.resolvePath(key);
    await fs.rm(filePath);
  }

  async presignUrl(key: string, _opts?: { expiresInSeconds?: number }): Promise<string> {
    this.resolvePath(key); // validate key
    return `${this.publicBaseUrl}/${key}`;
  }

  async listKeys(prefix: string): Promise<string[]> {
    const results: string[] = [];
    await this.scan(this.rootDir, prefix, results);
    return results;
  }

  private async scan(dir: string, prefix: string, results: string[]): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name as string);
      // 스토리지 키는 OS 와 무관하게 "/" 구분 (Windows 의 path.relative 는 역슬래시를 쓴다)
      const relKey = path.relative(this.rootDir, fullPath).split(path.sep).join("/");

      if (entry.isDirectory()) {
        await this.scan(fullPath, prefix, results);
      } else if (entry.isFile()) {
        if (relKey.startsWith(prefix)) {
          results.push(relKey);
        }
      }
    }
  }
}
