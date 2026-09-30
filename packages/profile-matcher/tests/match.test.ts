/**
 * packages/profile-matcher/tests/match.test.ts
 *
 * matchProfile / matchProfileById 11개 이상 테스트
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { IrSchema } from "@camellia/ir-schema";
import { awsEcsBasic, onpremDockerBasic } from "@camellia/profiles";
import { matchProfile, matchProfileById } from "../src/index.js";
import type { Ir } from "@camellia/ir-schema";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): Ir {
  const raw = readFileSync(join(__dirname, "fixtures", name), "utf-8");
  const parsed = yaml.load(raw);
  return IrSchema.parse(parsed);
}

const simpleHttp = loadFixture("simple-http.yaml");
const withPostgres = loadFixture("with-postgres.yaml");
const withRedis = loadFixture("with-redis.yaml");

// ---------------------------------------------------------------------------
// 1. simple-http + aws-ecs-basic → compatible=true, 빈 배열들
// ---------------------------------------------------------------------------
describe("simple-http + aws-ecs-basic", () => {
  it("compatible=true, missing_resources=[], warnings=[]", () => {
    const result = matchProfile(simpleHttp, awsEcsBasic);
    expect(result.compatible).toBe(true);
    expect(result.missing_resources).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. simple-http + onprem-docker-basic → compatible=true
// ---------------------------------------------------------------------------
describe("simple-http + onprem-docker-basic", () => {
  it("compatible=true", () => {
    const result = matchProfile(simpleHttp, onpremDockerBasic);
    expect(result.compatible).toBe(true);
    expect(result.missing_resources).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. with-postgres + aws-ecs-basic → compatible=true (postgres는 지원)
// ---------------------------------------------------------------------------
describe("with-postgres + aws-ecs-basic", () => {
  it("compatible=true, postgres가 resource_types에 있어서 missing 없음", () => {
    const result = matchProfile(withPostgres, awsEcsBasic);
    expect(result.compatible).toBe(true);
    expect(result.missing_resources).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. with-redis + aws-ecs-basic → compatible=false, missing_resources에 redis 1개
// ---------------------------------------------------------------------------
describe("with-redis + aws-ecs-basic", () => {
  it("compatible=false, missing_resources에 redis 1개", () => {
    const result = matchProfile(withRedis, awsEcsBasic);
    expect(result.compatible).toBe(false);
    expect(result.missing_resources).toHaveLength(1);
    expect(result.missing_resources[0].resource_name).toBe("cache");
    expect(result.missing_resources[0].resource_type).toBe("redis");
    expect(result.missing_resources[0].reason).toBe("not_in_capabilities");
    expect(result.missing_resources[0].suggestion).toBe("add_module");
  });
});

// ---------------------------------------------------------------------------
// 5. service type "static" — aws-ecs-basic은 static 미지원 → warning
// ---------------------------------------------------------------------------
describe("service type 미지원", () => {
  it('type="static"이고 aws-ecs-basic은 static 미지원 → service_type_unsupported warning', () => {
    const ir: Ir = IrSchema.parse({
      metadata: { name: "static-app", version: "1.0.0" },
      services: {
        web: { type: "static", size: "small", expose: "public" },
      },
      deploy: { profile: "aws-ecs-basic" },
    });
    const result = matchProfile(ir, awsEcsBasic);
    expect(result.compatible).toBe(true); // warning만이므로 compatible=true
    expect(result.warnings.some((w) => w.code === "service_type_unsupported")).toBe(true);
    const w = result.warnings.find((w) => w.code === "service_type_unsupported")!;
    expect(w.path).toBe("services.web.type");
  });
});

// ---------------------------------------------------------------------------
// 6. service size "large" — onprem-docker-basic은 large 미지원 → warning
// ---------------------------------------------------------------------------
describe("service size 미지원", () => {
  it('size="large"이고 onprem-docker-basic은 large 미지원 → size_unsupported warning', () => {
    const ir: Ir = IrSchema.parse({
      metadata: { name: "large-app", version: "1.0.0" },
      services: {
        api: { type: "http", port: 3000, size: "large", expose: "public" },
      },
      deploy: { profile: "onprem-docker-basic" },
    });
    const result = matchProfile(ir, onpremDockerBasic);
    expect(result.compatible).toBe(true);
    expect(result.warnings.some((w) => w.code === "size_unsupported")).toBe(true);
    const w = result.warnings.find((w) => w.code === "size_unsupported")!;
    expect(w.path).toBe("services.api.size");
  });
});

// ---------------------------------------------------------------------------
// 7. expose=public + supports_public_expose=false → expose_unsupported warning
// ---------------------------------------------------------------------------
describe("expose=public 미지원 프로필", () => {
  it("supports_public_expose=false 프로필에 expose=public 서비스 → expose_unsupported warning", () => {
    const noPublicProfile = {
      ...awsEcsBasic,
      id: "no-public-profile",
      capabilities: {
        ...awsEcsBasic.capabilities,
        supports_public_expose: false,
      },
    };
    const ir: Ir = IrSchema.parse({
      metadata: { name: "expose-test", version: "1.0.0" },
      services: {
        api: { type: "http", port: 3000, size: "small", expose: "public" },
      },
      deploy: { profile: "no-public-profile" },
    });
    const result = matchProfile(ir, noPublicProfile);
    expect(result.compatible).toBe(true);
    expect(result.warnings.some((w) => w.code === "expose_unsupported")).toBe(true);
    const w = result.warnings.find((w) => w.code === "expose_unsupported")!;
    expect(w.path).toBe("services.api.expose");
  });
});

// ---------------------------------------------------------------------------
// 8. max_services 초과 (services 20개 + onprem-docker-basic max=5) → warning
// ---------------------------------------------------------------------------
describe("max_services 초과", () => {
  it("서비스 6개 + onprem-docker-basic max=5 → max_services_exceeded warning", () => {
    const services: Record<string, { type: "http"; port: number; size: "small"; expose: "public" }> = {};
    for (let i = 1; i <= 6; i++) {
      services[`svc${i}`] = { type: "http", port: 3000 + i, size: "small", expose: "public" };
    }
    const ir: Ir = IrSchema.parse({
      metadata: { name: "many-services", version: "1.0.0" },
      services,
      deploy: { profile: "onprem-docker-basic" },
    });
    const result = matchProfile(ir, onpremDockerBasic);
    expect(result.compatible).toBe(true);
    expect(result.warnings.some((w) => w.code === "max_services_exceeded")).toBe(true);
    const w = result.warnings.find((w) => w.code === "max_services_exceeded")!;
    expect(w.path).toBe("services");
  });
});

// ---------------------------------------------------------------------------
// 9. matchProfileById("aws-ecs-basic", ir) 성공
// ---------------------------------------------------------------------------
describe("matchProfileById 성공", () => {
  it('matchProfileById(ir, "aws-ecs-basic") → 정상 MatchResult 반환', () => {
    const result = matchProfileById(simpleHttp, "aws-ecs-basic");
    expect(result).not.toBeNull();
    expect(result!.compatible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. matchProfileById("nonexistent", ir) → null
// ---------------------------------------------------------------------------
describe("matchProfileById 미존재 프로필", () => {
  it('matchProfileById(ir, "nonexistent") → null', () => {
    const result = matchProfileById(simpleHttp, "nonexistent");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 11. 여러 missing resources 동시 (redis + object_storage) 감지
// ---------------------------------------------------------------------------
describe("여러 missing resources 동시 감지", () => {
  it("redis + object_storage 모두 aws-ecs-basic capabilities에 없어서 2개 감지", () => {
    const ir: Ir = IrSchema.parse({
      metadata: { name: "multi-missing", version: "1.0.0" },
      services: {
        api: { type: "http", port: 3000, size: "small", expose: "public" },
      },
      resources: {
        cache: { type: "redis", plan: "dev" },
        files: { type: "object_storage" },
      },
      deploy: { profile: "aws-ecs-basic" },
    });
    const result = matchProfile(ir, awsEcsBasic);
    expect(result.compatible).toBe(false);
    expect(result.missing_resources).toHaveLength(2);
    const types = result.missing_resources.map((r) => r.resource_type);
    expect(types).toContain("redis");
    expect(types).toContain("object_storage");
  });
});

// ---------------------------------------------------------------------------
// 12. expose=internal + supports_internal_expose=false → expose_unsupported warning
// ---------------------------------------------------------------------------
describe("expose=internal 미지원 프로필", () => {
  it("supports_internal_expose=false 프로필에 expose=internal 서비스 → expose_unsupported warning", () => {
    const noInternalProfile = {
      ...awsEcsBasic,
      id: "no-internal-profile",
      capabilities: {
        ...awsEcsBasic.capabilities,
        supports_internal_expose: false,
      },
    };
    const ir: Ir = IrSchema.parse({
      metadata: { name: "internal-test", version: "1.0.0" },
      services: {
        worker: { type: "worker", port: 4000, size: "small", expose: "internal" },
      },
      deploy: { profile: "no-internal-profile" },
    });
    const result = matchProfile(ir, noInternalProfile);
    expect(result.warnings.some((w) => w.code === "expose_unsupported")).toBe(true);
    const w = result.warnings.find((w) => w.code === "expose_unsupported")!;
    expect(w.path).toBe("services.worker.expose");
  });
});

// ---------------------------------------------------------------------------
// 13. compatible=false 조건: missing_resources > 0
// ---------------------------------------------------------------------------
describe("compatible 판정", () => {
  it("missing_resources가 1개 이상이면 compatible=false", () => {
    const result = matchProfile(withRedis, awsEcsBasic);
    expect(result.compatible).toBe(false);
  });

  it("warning만 있고 missing_resources=0이면 compatible=true", () => {
    const ir: Ir = IrSchema.parse({
      metadata: { name: "warn-only", version: "1.0.0" },
      services: {
        api: { type: "static", size: "small", expose: "public" },
      },
      deploy: { profile: "aws-ecs-basic" },
    });
    const result = matchProfile(ir, awsEcsBasic);
    expect(result.missing_resources).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.compatible).toBe(true);
  });
});
