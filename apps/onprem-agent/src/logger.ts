type LogFields = Record<string, unknown>;
type LogSink = (line: string) => void;

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized === "environment" ||
    normalized === "stdin" ||
    normalized.includes("authorization") ||
    normalized.includes("credential") ||
    normalized.includes("password") ||
    normalized.includes("secret") ||
    normalized.includes("token")
  );
}

function redact(value: unknown, key = ""): unknown {
  if (isSensitiveKey(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, nestedValue]) => [
        nestedKey,
        redact(nestedValue, nestedKey),
      ]),
    );
  }
  return value;
}

function redactFields(fields: LogFields): LogFields {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, redact(value, key)]),
  );
}

export class StructuredLogger {
  constructor(private readonly sink: LogSink = (line) => process.stdout.write(`${line}\n`)) {}

  info(event: string, fields: LogFields = {}): void {
    this.write("info", event, fields);
  }

  warn(event: string, fields: LogFields = {}): void {
    this.write("warn", event, fields);
  }

  error(event: string, fields: LogFields = {}): void {
    this.write("error", event, fields);
  }

  private write(level: string, event: string, fields: LogFields): void {
    this.sink(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        event,
        ...redactFields(fields),
      }),
    );
  }
}
