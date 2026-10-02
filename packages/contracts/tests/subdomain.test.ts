import { describe, expect, it } from "vitest";
import {
  CreateProjectBodySchema,
  SubdomainAvailabilitySchema,
  defaultSubdomain,
  projectSubdomain,
  serviceHostname,
  servicePublicUrl,
  subdomainProblem,
} from "../src/index.js";

describe("앱 주소(subdomain) 규칙 (#300)", () => {
  it("소문자 · 숫자 · 하이픈 3~40자를 받는다", () => {
    for (const name of ["abc", "monolith-seohyeon", "app2", "a1b", "x".repeat(40)]) {
      expect(subdomainProblem(name), name).toBeNull();
    }
  });

  it("형식이 틀리면 format", () => {
    for (const name of [
      "", "ab", "x".repeat(41), "-abc", "abc-", "ab--cd", "Abc", "ab_c", "ab.c", "한글주소", "a b c",
    ]) {
      expect(subdomainProblem(name), name).toBe("format");
    }
  });

  it("플랫폼이 쓰는 이름 · 시스템 기본 주소 · 온프레미스 검증 주소는 reserved", () => {
    for (const name of [
      "console", "www", "api", "admin", "app", "apps", "mail", "verify",
      "verify-d42", "verify-anything", "service-1", "service-12345",
    ]) {
      expect(subdomainProblem(name), name).toBe("reserved");
    }
    // service- 뒤가 숫자만이 아니면 사용자 주소로 쓸 수 있다
    expect(subdomainProblem("service-shop")).toBeNull();
  });

  it("subdomain 이 없는 예전 프로젝트는 service-{id}", () => {
    expect(defaultSubdomain(7)).toBe("service-7");
    expect(projectSubdomain(null, "7")).toBe("service-7");
    expect(projectSubdomain(undefined, 7)).toBe("service-7");
    expect(projectSubdomain("shop", 7)).toBe("shop");
  });

  it("공개 호스트 이름 · URL 을 만든다 (도메인 끝 점 · 대소문자 정리)", () => {
    expect(serviceHostname("shop", "Camellia-Deploy.app.")).toBe("shop.camellia-deploy.app");
    expect(servicePublicUrl("shop", "camellia-deploy.app")).toBe("https://shop.camellia-deploy.app");
    expect(servicePublicUrl("shop", undefined)).toBeNull();
    expect(servicePublicUrl("shop", "  ")).toBeNull();
  });

  it("프로젝트 생성 요청의 subdomain 은 앞뒤 공백 · 대문자를 정리해서 검증한다", () => {
    expect(CreateProjectBodySchema.parse({ name: "a", subdomain: " Shop-1 " }).subdomain).toBe("shop-1");
    expect(CreateProjectBodySchema.safeParse({ name: "a", subdomain: "console" }).success).toBe(false);
    expect(CreateProjectBodySchema.safeParse({ name: "a", subdomain: "a_b" }).success).toBe(false);
    expect(CreateProjectBodySchema.parse({ name: "a" }).subdomain).toBeUndefined();
  });

  it("주소 확인 응답 계약", () => {
    expect(SubdomainAvailabilitySchema.parse({ name: "shop", available: true, reason: null })).toBeTruthy();
    expect(SubdomainAvailabilitySchema.safeParse({ name: "shop", available: false, reason: "nope" }).success)
      .toBe(false);
  });
});
