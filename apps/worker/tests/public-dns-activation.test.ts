import { describe, expect, it, vi } from "vitest";
import { PublicDnsActivationChecker } from "../src/public-dns-activation.js";

describe("PublicDnsActivationChecker", () => {
  it("기본 resolver 대신 지정한 public resolver가 응답할 때까지 짧게 재시도한다", async () => {
    const resolver = {
      resolve4: vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error("not found"), { code: "ENOTFOUND" }))
        .mockRejectedValueOnce(Object.assign(new Error("not found"), { code: "ENOTFOUND" }))
        .mockResolvedValueOnce(["104.21.8.198"]),
    };
    const sleep = vi.fn(async () => undefined);
    const checker = new PublicDnsActivationChecker({
      attempts: 5,
      intervalMs: 250,
      resolver,
      sleep,
    });

    await expect(checker.waitUntilResolvable("verify-d42.example.com")).resolves.toBe(true);
    expect(resolver.resolve4).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250, undefined);
  });

  it("상한 안에 public DNS가 활성화되지 않으면 false를 반환한다", async () => {
    const resolver = {
      resolve4: vi.fn(async () => {
        throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      }),
    };
    const checker = new PublicDnsActivationChecker({
      attempts: 3,
      intervalMs: 250,
      resolver,
      sleep: vi.fn(async () => undefined),
    });

    await expect(checker.waitUntilResolvable("verify-d42.example.com")).resolves.toBe(false);
    expect(resolver.resolve4).toHaveBeenCalledTimes(3);
  });

  it("취소 신호를 받으면 추가 DNS 조회 없이 중단한다", async () => {
    const controller = new AbortController();
    controller.abort();
    const resolver = { resolve4: vi.fn(async () => ["104.21.8.198"]) };
    const checker = new PublicDnsActivationChecker({ resolver });

    await expect(
      checker.waitUntilResolvable("verify-d42.example.com", controller.signal),
    ).resolves.toBe(false);
    expect(resolver.resolve4).not.toHaveBeenCalled();
  });
});
