/**
 * packages/ir-schema/tests/schema.test.ts
 *
 * IR 스키마 v0.1.0 검증 테스트
 * vitest + js-yaml 로 YAML fixture → IrSchema.parse 흐름을 end-to-end 검증한다.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import yaml from "js-yaml";
import { z } from "zod";
import { IrSchema, IR_SCHEMA_VERSION } from "../src/schema.js";

type Ir = z.infer<typeof IrSchema>;

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): unknown {
  const raw = readFileSync(join(__dirname, "fixtures", name), "utf-8");
  return yaml.load(raw);
}

// ---------------------------------------------------------------------------
// Group 1: YAML 예시 파싱 성공
// ---------------------------------------------------------------------------

describe("IrSchema — YAML 예시 파싱 성공", () => {
  it("예시 1 (todo-app): 최소 단일 http 서비스 파싱 성공", () => {
    const data = loadFixture("todo-app.yaml");
    const result: Ir = IrSchema.parse(data);

    expect(result.metadata.name).toBe("todo-app");
    expect(result.services["api"].type).toBe("http");
    expect(result.services["api"].expose).toBe("public");
    expect(result.services["api"].size).toBe("small");
    expect(result.$ir_version).toBe("0.1.0");
  });

  it("예시 2 (blog-api): postgres 리소스 + overrides 파싱 성공", () => {
    const data = loadFixture("blog-api.yaml");
    const result: Ir = IrSchema.parse(data);

    expect(result.resources?.["db"].type).toBe("postgres");
    expect(result.resources?.["db"].version).toBe("16");

    const awsOverride = result.overrides?.["aws-ecs-basic"] as {
      services: { api: { size: string } };
    };
    expect(awsOverride.services.api.size).toBe("large");
    expect(result.metadata.name).toBe("blog-api");
  });

  it("예시 3 (order-system): MSA 다중 서비스, depends_on, expose:internal 파싱 성공", () => {
    const data = loadFixture("order-system.yaml");
    const result: Ir = IrSchema.parse(data);

    const serviceKeys = Object.keys(result.services);
    expect(serviceKeys).toHaveLength(2);
    expect(serviceKeys).toContain("api");
    expect(serviceKeys).toContain("order-worker");

    expect(result.services["order-worker"].depends_on).toEqual(["api"]);
    expect(result.services["order-worker"].expose).toBe("internal");
    expect(result.services["api"].expose).toBe("public");
  });

  it("YAML 로딩: js-yaml로 실제 YAML 문자열 → IrSchema.parse 까지 파이프라인 동작", () => {
    const yamlStr = `
$ir_version: "0.1.0"
metadata:
  name: yaml-load-test
  version: 1.0.0
services:
  api:
    type: http
deploy:
  profile: onprem-docker-basic
`;
    const data = yaml.load(yamlStr);
    const result: Ir = IrSchema.parse(data);

    expect(result.metadata.name).toBe("yaml-load-test");
    expect(result.services["api"].type).toBe("http");
  });
});

// ---------------------------------------------------------------------------
// Group 2: 기본값 / optional
// ---------------------------------------------------------------------------

describe("IrSchema — 기본값/optional", () => {
  const minimal = {
    metadata: { name: "defaults-test", version: "1.0.0" },
    services: { api: { type: "http" } },
    deploy: { profile: "onprem-docker-basic" },
  };

  it("$ir_version 미지정 시 기본값 '0.1.0' 채워짐", () => {
    const input = { ...minimal };
    const result: Ir = IrSchema.parse(input);

    expect(result.$ir_version).toBe(IR_SCHEMA_VERSION);
    expect(result.$ir_version).toBe("0.1.0");
  });

  it("services.*.expose 미지정 시 기본값 'public'", () => {
    const result: Ir = IrSchema.parse(minimal);

    expect(result.services["api"].expose).toBe("public");
  });

  it("services.*.size 미지정 시 기본값 'small'", () => {
    const result: Ir = IrSchema.parse(minimal);

    expect(result.services["api"].size).toBe("small");
  });

  it("services.*.health 미지정 시 기본값 { path: '/health', expected_status: 200, timeout_seconds: 3 }", () => {
    const result: Ir = IrSchema.parse(minimal);
    const health = result.services["api"].health;

    expect(health.path).toBe("/health");
    expect(health.expected_status).toBe(200);
    expect(health.timeout_seconds).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Group 3: 유효성 실패
// ---------------------------------------------------------------------------

describe("IrSchema — 유효성 실패", () => {
  it("metadata.version 이 semver 아님 ('v1') → ZodError (path: metadata.version)", () => {
    const bad = {
      metadata: { name: "test", version: "v1" },
      services: { api: { type: "http" } },
      deploy: { profile: "onprem-docker-basic" },
    };

    expect(() => IrSchema.parse(bad)).toThrow(z.ZodError);

    try {
      IrSchema.parse(bad);
    } catch (err) {
      expect(err).toBeInstanceOf(z.ZodError);
      const zodErr = err as z.ZodError;
      const paths = zodErr.issues.map((i) => i.path.join("."));
      expect(paths.some((p) => p.includes("metadata") && p.includes("version"))).toBe(true);
    }
  });

  it("services.*.type 이 enum 벗어남 ('grpc') → ZodError", () => {
    const bad = {
      metadata: { name: "test", version: "1.0.0" },
      services: { api: { type: "grpc" } },
      deploy: { profile: "onprem-docker-basic" },
    };

    expect(() => IrSchema.parse(bad)).toThrow(z.ZodError);

    try {
      IrSchema.parse(bad);
    } catch (err) {
      expect(err).toBeInstanceOf(z.ZodError);
      const zodErr = err as z.ZodError;
      const paths = zodErr.issues.map((i) => i.path.join("."));
      expect(paths.some((p) => p.includes("type"))).toBe(true);
    }
  });

  it("services.*.type 이 enum 벗어남 ('grpc') → ZodError (type path 포함)", () => {
    const bad = {
      metadata: { name: "test", version: "1.0.0" },
      services: { worker: { type: "grpc" } },
      deploy: { profile: "onprem-docker-basic" },
    };

    expect(() => IrSchema.parse(bad)).toThrow(z.ZodError);
  });

  it("resources.*.type 이 enum 벗어남 ('mongodb') → ZodError (P0 지원 유형 밖)", () => {
    const bad = {
      metadata: { name: "test", version: "1.0.0" },
      services: { api: { type: "http" } },
      resources: { cache: { type: "mongodb" } },
      deploy: { profile: "onprem-docker-basic" },
    };

    expect(() => IrSchema.parse(bad)).toThrow(z.ZodError);

    try {
      IrSchema.parse(bad);
    } catch (err) {
      expect(err).toBeInstanceOf(z.ZodError);
      const zodErr = err as z.ZodError;
      const paths = zodErr.issues.map((i) => i.path.join("."));
      expect(paths.some((p) => p.includes("type"))).toBe(true);
    }
  });

  it("expose.paths[].port 가 범위 밖 (70000) → ZodError", () => {
    const bad = {
      metadata: { name: "test", version: "1.0.0" },
      services: { api: { type: "http" } },
      deploy: { profile: "onprem-docker-basic" },
      expose: {
        tls: true,
        paths: [{ path: "/", service: "api", port: 70000 }],
      },
    };

    expect(() => IrSchema.parse(bad)).toThrow(z.ZodError);

    try {
      IrSchema.parse(bad);
    } catch (err) {
      expect(err).toBeInstanceOf(z.ZodError);
      const zodErr = err as z.ZodError;
      const paths = zodErr.issues.map((i) => i.path.join("."));
      expect(paths.some((p) => p.includes("port"))).toBe(true);
    }
  });

  it("missing_resources_decisions[].decided_at 이 ISO 8601 형식 아님 ('어제') → ZodError", () => {
    const bad = {
      metadata: { name: "test", version: "1.0.0" },
      services: { api: { type: "http" } },
      deploy: { profile: "onprem-docker-basic" },
      missing_resources_decisions: [
        {
          resource_name: "db",
          decision: "exclude",
          decided_at: "어제",
        },
      ],
    };

    expect(() => IrSchema.parse(bad)).toThrow(z.ZodError);

    try {
      IrSchema.parse(bad);
    } catch (err) {
      expect(err).toBeInstanceOf(z.ZodError);
      const zodErr = err as z.ZodError;
      const paths = zodErr.issues.map((i) => i.path.join("."));
      expect(paths.some((p) => p.includes("decided_at"))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Group 4: missing_resources_decisions
// ---------------------------------------------------------------------------

describe("IrSchema — missing_resources_decisions", () => {
  const base = {
    metadata: { name: "decision-test", version: "1.0.0" },
    services: { api: { type: "http" } },
    deploy: { profile: "aws-ecs-basic" },
  };

  it("decision: 'add_module' + module_id 지정 → 파싱 성공", () => {
    const input = {
      ...base,
      missing_resources_decisions: [
        {
          resource_name: "db",
          decision: "add_module",
          module_id: "aws-rds-postgres-16",
          decided_at: "2026-09-30T03:00:00.000Z",
        },
      ],
    };

    const result: Ir = IrSchema.parse(input);

    expect(result.missing_resources_decisions).toHaveLength(1);
    expect(result.missing_resources_decisions?.[0].decision).toBe("add_module");
    expect(result.missing_resources_decisions?.[0].module_id).toBe("aws-rds-postgres-16");
  });

  it("decision: 'exclude' + module_id 생략 → 파싱 성공 (module_id는 optional)", () => {
    const input = {
      ...base,
      missing_resources_decisions: [
        {
          resource_name: "db",
          decision: "exclude",
          decided_at: "2026-09-30T03:00:00.000Z",
        },
      ],
    };

    const result: Ir = IrSchema.parse(input);

    expect(result.missing_resources_decisions).toHaveLength(1);
    expect(result.missing_resources_decisions?.[0].decision).toBe("exclude");
    expect(result.missing_resources_decisions?.[0].module_id).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Group: resources 연결 정보 (DB 추가 모듈, #276)
// ---------------------------------------------------------------------------

describe("IrSchema — resources 연결 환경변수 · 로컬 대체 저장소", () => {
  const base = {
    metadata: { name: "guestbook", version: "1.0.0" },
    services: { web: { type: "http", port: 3000 } },
    deploy: { profile: "aws-ecs-basic" },
  };

  it("connection_env · local_fallback 을 그대로 파싱한다", () => {
    const result: Ir = IrSchema.parse({
      ...base,
      resources: {
        db: { type: "postgres", connection_env: "DATABASE_URL", local_fallback: "sqlite" },
      },
    });

    expect(result.resources?.["db"].connection_env).toBe("DATABASE_URL");
    expect(result.resources?.["db"].local_fallback).toBe("sqlite");
  });

  it("connection_env 가 환경변수 이름 형식이 아니면 실패", () => {
    expect(() =>
      IrSchema.parse({
        ...base,
        resources: { db: { type: "postgres", connection_env: "database url" } },
      }),
    ).toThrow(z.ZodError);
  });

  it("local_fallback 은 sqlite 만 허용", () => {
    expect(() =>
      IrSchema.parse({
        ...base,
        resources: { db: { type: "postgres", local_fallback: "mysql" } },
      }),
    ).toThrow(z.ZodError);
  });
});
