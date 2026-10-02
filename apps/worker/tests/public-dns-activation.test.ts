import { describe, expect, it, vi } from "vitest";
import {
  AuthoritativeDnsResolver,
  PublicDnsActivationChecker,
} from "../src/public-dns-activation.js";

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

describe("AuthoritativeDnsResolver", () => {
  const notFound = () =>
    Object.assign(new Error("not found"), { code: "ENODATA" });

  it("zone 의 권한 네임서버에 직접 묻고 네임서버 주소는 재사용한다", async () => {
    const bootstrap = {
      resolveNs: vi.fn(async (name: string) => {
        if (name === "example.com") return ["a.ns.example.net", "b.ns.example.net"];
        throw notFound();
      }),
      resolve4: vi.fn(async (name: string) =>
        name === "a.ns.example.net" ? ["192.0.2.1"] : ["192.0.2.2"]
      ),
    };
    const authoritative = { resolve4: vi.fn(async () => ["104.21.8.198"]) };
    const createResolver = vi.fn(() => authoritative);
    const resolver = new AuthoritativeDnsResolver({ bootstrap, createResolver });

    await expect(resolver.resolve4("service-24.example.com")).resolves.toEqual(["104.21.8.198"]);
    await expect(resolver.resolve4("service-25.example.com")).resolves.toEqual(["104.21.8.198"]);

    expect(bootstrap.resolveNs).toHaveBeenCalledTimes(1);
    expect(bootstrap.resolveNs).toHaveBeenCalledWith("example.com");
    expect(createResolver).toHaveBeenCalledWith(["192.0.2.1", "192.0.2.2"]);
    expect(authoritative.resolve4).toHaveBeenCalledWith("service-24.example.com");
    expect(bootstrap.resolve4).not.toHaveBeenCalledWith("service-24.example.com");
  });

  it("상위 이름으로 올라가며 zone 을 찾는다", async () => {
    const bootstrap = {
      resolveNs: vi.fn(async (name: string) => {
        if (name === "example.com") return ["a.ns.example.net"];
        throw notFound();
      }),
      resolve4: vi.fn(async () => ["192.0.2.1"]),
    };
    const createResolver = vi.fn(() => ({ resolve4: vi.fn(async () => ["198.51.100.1"]) }));
    const resolver = new AuthoritativeDnsResolver({ bootstrap, createResolver });

    await resolver.resolve4("app.team.example.com");

    expect(bootstrap.resolveNs.mock.calls).toEqual([["team.example.com"], ["example.com"]]);
    expect(createResolver).toHaveBeenCalledWith(["192.0.2.1"]);
  });

  it("네임서버를 찾지 못하면 Cloudflare 공개 resolver 로 묻는다", async () => {
    const bootstrap = {
      resolveNs: vi.fn(async () => { throw notFound(); }),
      resolve4: vi.fn(async () => ["192.0.2.1"]),
    };
    const createResolver = vi.fn(() => ({ resolve4: vi.fn(async () => ["198.51.100.1"]) }));
    const resolver = new AuthoritativeDnsResolver({ bootstrap, createResolver });

    await expect(resolver.resolve4("service-24.example.com")).resolves.toEqual(["198.51.100.1"]);
    expect(createResolver).toHaveBeenCalledWith(["1.1.1.1", "1.0.0.1"]);
  });
});
