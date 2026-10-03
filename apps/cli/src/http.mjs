import { baseUrl, token } from "./config.mjs";

export class CliError extends Error {
  constructor(message, exitCode = 1, code = null) {
    super(message);
    this.exitCode = exitCode;
    this.code = code;
  }
}

/** 서버 오류 본문 { error: { code, message, hint } } 을 한 덩어리 문구로 */
function describe(status, body) {
  const error = body && typeof body === "object" ? body.error : null;
  if (error && typeof error.message === "string") {
    const hint = typeof error.hint === "string" && error.hint ? `\n  ${error.hint}` : "";
    return { message: `${error.message}${error.code ? ` (${error.code})` : ""}${hint}`, code: error.code ?? null };
  }
  return { message: `Request failed (HTTP ${status})`, code: null };
}

/**
 * /api/v1 아래 경로를 부른다. raw 면 Response 를 그대로, 아니면 JSON(본문이 없으면 null).
 * 인증은 Bearer 토큰 — 콘솔 앞단의 Basic Auth 를 건너뛰고 API 가 토큰을 직접 확인한다.
 */
export async function api(path, { method = "GET", body, form, raw = false, auth = true } = {}) {
  const headers = { accept: "application/json" };
  if (auth) {
    const value = token();
    if (!value) throw new CliError("Login required. Run `camellia login` first.", 2);
    headers.authorization = `Bearer ${value}`;
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  let response;
  try {
    response = await fetch(`${baseUrl()}/api/v1${path}`, {
      method, headers, body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch (error) {
    throw new CliError(`Cannot reach the server (${baseUrl()}): ${error?.cause?.message ?? error?.message ?? error}`);
  }
  if (response.status === 401) throw new CliError("Your login expired or is invalid. Run `camellia login` again.", 2);
  if (!response.ok) {
    const parsed = describe(response.status, await response.json().catch(() => null));
    throw new CliError(parsed.message, 1, parsed.code);
  }
  if (raw) return response;
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
