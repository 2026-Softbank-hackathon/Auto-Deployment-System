/**
 * HMAC-SHA256 세션 토큰 (JWT 유사, 외부 의존성 없음).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface SessionPayload {
  sub: string;
  exp: number;
}

const DEFAULT_TTL_SEC = 3600;

export function sessionSigningKey(apiKey: string): Buffer {
  return createHmac("sha256", apiKey).update("camellia-session-v1").digest();
}

function b64urlEncode(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return buf.toString("base64url");
}

function b64urlDecode(str: string): Buffer {
  return Buffer.from(str, "base64url");
}

export function signSessionToken(
  payload: SessionPayload,
  signingKey: Buffer,
): string {
  const header = b64urlEncode(JSON.stringify({ alg: "HS256", typ: "SESSION" }));
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = createHmac("sha256", signingKey)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${sig}`;
}

export function verifySessionToken(
  token: string,
  signingKey: Buffer,
): SessionPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  if (!header || !body || !sig) return null;
  const expected = createHmac("sha256", signingKey)
    .update(`${header}.${body}`)
    .digest("base64url");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(b64urlDecode(body).toString("utf8")) as SessionPayload;
    if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp * 1000 <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function sessionExpiresAt(ttlSec: number = DEFAULT_TTL_SEC): {
  exp: number;
  expiresAt: string;
} {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return { exp, expiresAt: new Date(exp * 1000).toISOString() };
}

export function stableUserId(apiKey: string): string {
  return `usr_${createHmac("sha256", "camellia-user-id").update(apiKey).digest("hex").slice(0, 16)}`;
}
