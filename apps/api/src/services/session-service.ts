/**
 * API-01 — API Key → 단기 세션 토큰 교환
 */

import { createHash } from "node:crypto";
import type { SessionResponse } from "@camellia/contracts";
import { ApiError } from "../plugins/error-handler.js";
import {
  sessionExpiresAt,
  sessionSigningKey,
  signSessionToken,
  stableUserId,
} from "../lib/session-token.js";

export class SessionService {
  constructor(
    private readonly apiKey: string,
    private readonly ttlSec: number,
  ) {}

  create(apiKey: string): SessionResponse {
    if (apiKey !== this.apiKey) {
      throw new ApiError(
        401,
        "UNAUTHORIZED",
        "유효하지 않은 API Key입니다.",
        "POST /auth/session 에 올바른 apiKey를 전달하세요.",
      );
    }

    return this.issue(this.ttlSec);
  }

  /**
   * CLI 로그인용 장기 토큰 (UI-02). 이미 인증된 요청(콘솔 로그인 · API Key)만 부를 수 있어 API Key 를 다시 받지 않는다.
   * 사용자는 비밀번호 대신 이 토큰만 자기 PC 에 둔다.
   */
  issue(ttlSec: number): SessionResponse {
    const userId = stableUserId(this.apiKey);
    const { exp, expiresAt } = sessionExpiresAt(ttlSec);
    const token = signSessionToken({ sub: userId, exp }, sessionSigningKey(this.apiKey));

    return { token, expiresAt, userId };
  }
}

/** 세션 발급 rate limit (IP당 분당 최대 요청) */
const SESSION_RATE_WINDOW_MS = 60_000;
const SESSION_RATE_MAX = 30;

export class SessionRateLimiter {
  private readonly hits = new Map<string, { count: number; windowStart: number }>();

  check(clientKey: string): void {
    const now = Date.now();
    const entry = this.hits.get(clientKey);
    if (!entry || now - entry.windowStart >= SESSION_RATE_WINDOW_MS) {
      this.hits.set(clientKey, { count: 1, windowStart: now });
      return;
    }
    entry.count += 1;
    if (entry.count > SESSION_RATE_MAX) {
      throw new ApiError(
        429,
        "RATE_LIMITED",
        "세션 발급 요청이 너무 많습니다.",
        "잠시 후 다시 시도하세요.",
      );
    }
  }
}

export function clientRateLimitKey(ip: string | undefined): string {
  const raw = ip?.trim() || "unknown";
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}
