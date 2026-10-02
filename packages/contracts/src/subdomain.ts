/**
 * packages/contracts/src/subdomain.ts
 * 앱 주소(https://{subdomain}.{플랫폼 도메인})의 subdomain 규칙과 공개 주소 계산 (#300).
 * API(응답 publicUrl) · 워커(Cloudflare 레코드 · Tunnel ingress · 정적 사이트 버킷 · 최종 검증)가 모두 이 함수로 주소를 만든다.
 *
 *   GET   /projects/subdomain-availability?name=  → 200 SubdomainAvailability
 */

import { z } from "zod";

export const SUBDOMAIN_MIN_LENGTH = 3;
export const SUBDOMAIN_MAX_LENGTH = 40;

/**
 * 사용자가 고를 수 없는 이름 — 플랫폼 콘솔(console) · 흔한 서비스 이름.
 * 접두사 규칙(RESERVED_SUBDOMAIN_PATTERNS)과 함께 본다.
 */
export const RESERVED_SUBDOMAINS = [
  "console",
  "www",
  "api",
  "admin",
  "app",
  "apps",
  "mail",
  "verify",
  "dashboard",
  "docs",
  "status",
  "static",
  "cdn",
  "agent",
  "agents",
  "tunnel",
  "camellia",
] as const;

/**
 * verify-*: 온프레미스 배포 검증 주소(verify-d{배포 ID}).
 * service-{숫자}: 주소를 고르지 않은 앱의 기본 주소 — 시스템만 붙인다 (다른 앱 ID 와 겹치지 않게).
 */
const RESERVED_SUBDOMAIN_PATTERNS = [/^verify-/, /^service-\d+$/];

/** 소문자 · 숫자 · 하이픈, 처음과 끝은 하이픈 불가, 하이픈 연속 불가(xn-- 같은 IDN 표기 방지) */
const SUBDOMAIN_FORMAT = /^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$/;

export type SubdomainProblem = "format" | "reserved";

/** 사용할 수 없는 이유. 쓸 수 있으면 null (다른 앱이 쓰는지는 DB 로 따로 본다) */
export function subdomainProblem(name: string): SubdomainProblem | null {
  if (
    name.length < SUBDOMAIN_MIN_LENGTH ||
    name.length > SUBDOMAIN_MAX_LENGTH ||
    !SUBDOMAIN_FORMAT.test(name)
  ) {
    return "format";
  }
  if (
    (RESERVED_SUBDOMAINS as readonly string[]).includes(name) ||
    RESERVED_SUBDOMAIN_PATTERNS.some((pattern) => pattern.test(name))
  ) {
    return "reserved";
  }
  return null;
}

/** 주소를 고르지 않은 앱 · 이 기능 전에 만든 앱의 주소 */
export function defaultSubdomain(projectId: number | string): string {
  return `service-${projectId}`;
}

/** DB projects.subdomain 이 비어 있으면(예전 row) service-{id} */
export function projectSubdomain(
  subdomain: string | null | undefined,
  projectId: number | string,
): string {
  return subdomain ? subdomain : defaultSubdomain(projectId);
}

function normalizePlatformDomain(platformDomain: string): string {
  return platformDomain.trim().replace(/\.$/, "").toLowerCase();
}

/** 앱 공개 호스트 이름 — {subdomain}.{플랫폼 도메인} */
export function serviceHostname(subdomain: string, platformDomain: string): string {
  return `${subdomain}.${normalizePlatformDomain(platformDomain)}`;
}

/** 앱 공개 주소. 플랫폼 도메인 설정이 없으면 null */
export function servicePublicUrl(subdomain: string, platformDomain: string | undefined): string | null {
  if (!platformDomain || !normalizePlatformDomain(platformDomain)) return null;
  return `https://${serviceHostname(subdomain, platformDomain)}`;
}

/** 요청으로 받는 subdomain — 앞뒤 공백 · 대문자를 정리한 뒤 규칙을 검사한다 */
export const SubdomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .superRefine((value, ctx) => {
    const problem = subdomainProblem(value);
    if (problem === "format") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `주소는 소문자 · 숫자 · 하이픈 ${SUBDOMAIN_MIN_LENGTH}~${SUBDOMAIN_MAX_LENGTH}자여야 하고 하이픈으로 시작하거나 끝날 수 없습니다.`,
      });
    } else if (problem === "reserved") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${value}" 는 예약된 주소라 쓸 수 없습니다.` });
    }
  });

export const SubdomainAvailabilityQuerySchema = z.object({
  name: z.string().max(100),
});
export type SubdomainAvailabilityQuery = z.input<typeof SubdomainAvailabilityQuerySchema>;

/** format: 형식 오류, reserved: 예약어, taken: 다른 앱이 쓰는 중(주소 변경 중인 새 주소 포함) */
export const SUBDOMAIN_UNAVAILABLE_REASONS = ["format", "reserved", "taken"] as const;
export const SubdomainUnavailableReasonSchema = z.enum(SUBDOMAIN_UNAVAILABLE_REASONS);
export type SubdomainUnavailableReason = z.infer<typeof SubdomainUnavailableReasonSchema>;

export const SubdomainAvailabilitySchema = z
  .object({
    /** 정리한(소문자 · 공백 제거) 이름 */
    name: z.string(),
    available: z.boolean(),
    /** available=true 면 null */
    reason: SubdomainUnavailableReasonSchema.nullable(),
  })
  .strict();
export type SubdomainAvailability = z.infer<typeof SubdomainAvailabilitySchema>;
