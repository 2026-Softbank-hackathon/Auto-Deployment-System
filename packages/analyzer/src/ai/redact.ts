/**
 * packages/analyzer/src/ai/redact.ts
 *
 * 프롬프트로 넘길 payload에서 시크릿 값을 redact한다 (D-50).
 * 실제 secret 값이 AI에 전송되지 않도록 보호.
 *
 * 감지 패턴:
 *   1. AWS Access Key ID     — AKIA[A-Z0-9]{16}
 *   2. AWS Secret Access Key — 40자 base64 문자열 (= 뒤에 오는 긴 값)
 *   3. Bearer 토큰           — Bearer <token>
 *   4. PEM private key 블록  — -----BEGIN ... PRIVATE KEY-----
 *   5. Generic password=     — password=<value>, passwd=<value>
 */

const REDACTED = "[REDACTED]";

/**
 * redact 규칙 목록.
 * 각 규칙은 { pattern, replacement } 형태.
 */
const REDACT_RULES: Array<{ pattern: RegExp; replacement: string | ((match: string) => string) }> = [
  // AWS Access Key ID (AKIA + 16 alphanumeric)
  {
    pattern: /\bAKIA[A-Z0-9]{16}\b/g,
    replacement: REDACTED,
  },
  // AWS Secret Access Key: 40-char base64 after common key names
  {
    pattern: /(?:aws_secret_access_key|SecretAccessKey)\s*[=:]\s*["']?[A-Za-z0-9/+]{40}["']?/gi,
    replacement: `aws_secret_access_key=${REDACTED}`,
  },
  // Bearer token
  {
    pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/g,
    replacement: `Bearer ${REDACTED}`,
  },
  // PEM private key block (entire block)
  {
    pattern: /-----BEGIN[A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END[A-Z ]+ PRIVATE KEY-----/g,
    replacement: `-----BEGIN PRIVATE KEY-----\n${REDACTED}\n-----END PRIVATE KEY-----`,
  },
  // password= or passwd= assignments
  {
    pattern: /\b(password|passwd|secret|token)\s*[=:]\s*["']?[^\s"',}\]]{4,}["']?/gi,
    replacement: (match: string) => {
      const key = match.split(/[=:]/)[0];
      return `${key}=${REDACTED}`;
    },
  },
];

/**
 * 문자열에서 시크릿 패턴을 마스킹한다.
 * 일반 문자열은 그대로 반환한다.
 */
export function redact(input: string): string {
  let result = input;
  for (const rule of REDACT_RULES) {
    if (typeof rule.replacement === "string") {
      result = result.replace(rule.pattern, rule.replacement);
    } else {
      result = result.replace(rule.pattern, rule.replacement);
    }
  }
  return result;
}

/**
 * 객체를 JSON 직렬화 후 redact한다.
 * 프롬프트 payload 전처리에 사용.
 */
export function redactPayload(payload: unknown): string {
  const json = JSON.stringify(payload, null, 2);
  return redact(json);
}
