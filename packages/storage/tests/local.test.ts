import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LocalStorage } from "../src/local.js";

let tmpDir: string;
let storage: LocalStorage;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `storage-test-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  storage = new LocalStorage({ rootDir: tmpDir, publicBaseUrl: "http://localhost:3000/storage" });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("LocalStorage", () => {
  it("put + get roundtrip returns identical Buffer", async () => {
    const data = Buffer.from("hello storage");
    await storage.put("hello.txt", data);
    const result = await storage.get("hello.txt");
    expect(result).toEqual(data);
  });

  it("exists returns true for existing file", async () => {
    await storage.put("exist.txt", Buffer.from("x"));
    expect(await storage.exists("exist.txt")).toBe(true);
  });

  it("exists returns false for missing file", async () => {
    expect(await storage.exists("nope.txt")).toBe(false);
  });

  it("delete removes the file and exists returns false", async () => {
    await storage.put("bye.txt", Buffer.from("data"));
    await storage.delete("bye.txt");
    expect(await storage.exists("bye.txt")).toBe(false);
  });

  it("put with path traversal (..) throws", async () => {
    await expect(storage.put("../../etc/passwd", Buffer.from("x"))).rejects.toThrow(
      /path traversal/i
    );
  });

  it("presignUrl returns publicBaseUrl + key", async () => {
    const url = await storage.presignUrl("images/photo.png");
    expect(url).toBe("http://localhost:3000/storage/images/photo.png");
  });

  it("listKeys returns only keys matching prefix", async () => {
    await storage.put("a/file1.txt", Buffer.from("1"));
    await storage.put("a/file2.txt", Buffer.from("2"));
    await storage.put("b/file3.txt", Buffer.from("3"));

    const keys = await storage.listKeys("a/");
    expect(keys.sort()).toEqual(["a/file1.txt", "a/file2.txt"]);
  });

  it("put creates subdirectories automatically", async () => {
    await storage.put("deep/nested/dir/file.txt", Buffer.from("nested"));
    const data = await storage.get("deep/nested/dir/file.txt");
    expect(data.toString()).toBe("nested");
  });

  it("put + get roundtrip for 1MB file", async () => {
    const big = Buffer.alloc(1024 * 1024, 0xab);
    await storage.put("big.bin", big);
    const result = await storage.get("big.bin");
    expect(result.length).toBe(1024 * 1024);
    expect(result.equals(big)).toBe(true);
  });
});
