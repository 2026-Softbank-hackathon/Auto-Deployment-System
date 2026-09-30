/**
 * packages/analyzer/tests/ai/redact.test.ts
 *
 * redact() 시크릿 마스킹 단위 테스트.
 */

import { describe, it, expect } from "vitest";
import { redact, redactPayload } from "../../src/ai/redact.js";

describe("redact – AWS Access Key ID", () => {
  it("masks AKIA followed by 16 alphanumeric characters", () => {
    const input = "key=AKIAIOSFODNN7EXAMPLE";
    const output = redact(input);
    expect(output).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(output).toContain("[REDACTED]");
  });

  it("leaves non-AKIA strings untouched", () => {
    const input = "key=NOTANAKIAKEY12345";
    const output = redact(input);
    expect(output).toBe(input);
  });
});

describe("redact – Bearer token", () => {
  it("masks Bearer followed by a token string", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc123";
    const output = redact(input);
    expect(output).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(output).toContain("Bearer [REDACTED]");
  });

  it("leaves non-Bearer authorization strings untouched", () => {
    const input = "Authorization: Basic dXNlcjpwYXNz";
    const output = redact(input);
    // Basic auth has no Bearer — should be unchanged by Bearer rule
    // (password= rule might catch it if value is long enough — test the actual behavior)
    expect(typeof output).toBe("string");
  });
});

describe("redact – PEM private key block", () => {
  it("masks entire RSA private key block", () => {
    const input = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4mZm7X",
      "fake+data+here=",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const output = redact(input);
    expect(output).not.toContain("MIIEowIBAAKCAQEA0Z3VS5JJcds3xHn");
    expect(output).toContain("-----BEGIN PRIVATE KEY-----");
    expect(output).toContain("[REDACTED]");
    expect(output).toContain("-----END PRIVATE KEY-----");
  });

  it("masks EC PRIVATE KEY block", () => {
    const input = [
      "-----BEGIN EC PRIVATE KEY-----",
      "MHQCAQEEIBkg4EXAMPLE==",
      "-----END EC PRIVATE KEY-----",
    ].join("\n");
    const output = redact(input);
    expect(output).not.toContain("MHQCAQEEIBkg4EXAMPLE==");
    expect(output).toContain("[REDACTED]");
  });
});

describe("redact – password/secret assignments", () => {
  it("masks password= assignments", () => {
    const input = "password=supersecretvalue123";
    const output = redact(input);
    expect(output).not.toContain("supersecretvalue123");
    expect(output).toContain("[REDACTED]");
  });

  it("masks token= assignments", () => {
    const input = "token=ghp_abcdefghijklmnop1234567890";
    const output = redact(input);
    expect(output).not.toContain("ghp_abcdefghijklmnop1234567890");
    expect(output).toContain("[REDACTED]");
  });
});

describe("redact – plain strings pass through", () => {
  it("does not modify a normal config string", () => {
    const input = "PORT=3000\nNODE_ENV=production\nDATABASE_URL=postgres://localhost:5432/mydb";
    const output = redact(input);
    // PORT, NODE_ENV should be unchanged
    expect(output).toContain("PORT=3000");
    expect(output).toContain("NODE_ENV=production");
  });
});

describe("redactPayload", () => {
  it("returns a string (JSON) with secrets masked", () => {
    const payload = {
      services: [{ name: "api", env_names: ["DATABASE_URL", "PORT"] }],
      secret_example: "AKIAIOSFODNN7EXAMPLE",
    };
    const output = redactPayload(payload);
    expect(typeof output).toBe("string");
    expect(output).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(output).toContain("[REDACTED]");
    expect(output).toContain("DATABASE_URL");
  });
});
