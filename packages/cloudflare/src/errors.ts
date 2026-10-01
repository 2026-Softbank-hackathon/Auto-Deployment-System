export type CloudflareErrorCode =
  | "CLOUDFLARE_INVALID_ARGUMENT"
  | "CLOUDFLARE_API_FAILURE"
  | "CLOUDFLARE_INVALID_RESPONSE";

export class CloudflareApiError extends Error {
  readonly code: CloudflareErrorCode;
  readonly status?: number;
  readonly cloudflareCode?: number;

  constructor(
    code: CloudflareErrorCode,
    message: string,
    details: { status?: number; cloudflareCode?: number } = {},
  ) {
    super(message);
    this.name = "CloudflareApiError";
    this.code = code;
    this.status = details.status;
    this.cloudflareCode = details.cloudflareCode;
  }
}
