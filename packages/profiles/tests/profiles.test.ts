import { describe, it, expect } from "vitest";
import {
  ProfileSchema,
  awsEcsBasic,
  onpremDockerBasic,
  defaultProfileFor,
  getProfile,
  PROFILES,
} from "../src/index.js";

describe("ProfileSchema", () => {
  it("parses awsEcsBasic successfully", () => {
    const result = ProfileSchema.safeParse(awsEcsBasic);
    expect(result.success).toBe(true);
  });

  it("parses onpremDockerBasic successfully", () => {
    const result = ProfileSchema.safeParse(onpremDockerBasic);
    expect(result.success).toBe(true);
  });

  it("throws on invalid profile (missing required id)", () => {
    expect(() =>
      ProfileSchema.parse({
        cloud: "aws",
        description: "bad",
        version: "0.0.1",
        capabilities: {
          service_types: ["http"],
          resource_types: ["postgres"],
          sizes: ["small"],
          supports_public_expose: true,
          supports_internal_expose: false,
        },
      })
    ).toThrow();
  });

  it("throws on invalid cloud enum value", () => {
    expect(() =>
      ProfileSchema.parse({ ...awsEcsBasic, cloud: "unknown-cloud" })
    ).toThrow();
  });

  it("throws on invalid service_type enum value", () => {
    expect(() =>
      ProfileSchema.parse({
        ...awsEcsBasic,
        capabilities: {
          ...awsEcsBasic.capabilities,
          service_types: ["http", "invalid-type"],
        },
      })
    ).toThrow();
  });
});

describe("getProfile", () => {
  it("returns awsEcsBasic for 'aws-ecs-basic'", () => {
    expect(getProfile("aws-ecs-basic")).toBe(awsEcsBasic);
  });

  it("returns onpremDockerBasic for 'onprem-docker-basic'", () => {
    expect(getProfile("onprem-docker-basic")).toBe(onpremDockerBasic);
  });

  it("returns null for unknown id", () => {
    expect(getProfile("does-not-exist")).toBeNull();
  });
});

describe("defaultProfileFor", () => {
  it("returns the P0 AWS default profile", () => {
    expect(defaultProfileFor("aws")).toBe("aws-ecs-basic");
  });

  it("returns the P0 On-Prem default profile", () => {
    expect(defaultProfileFor("onprem")).toBe("onprem-docker-basic");
  });
});

describe("capabilities", () => {
  it("awsEcsBasic service_types includes 'http'", () => {
    expect(awsEcsBasic.capabilities.service_types).toContain("http");
  });

  it("awsEcsBasic resource_types includes 'postgres'", () => {
    expect(awsEcsBasic.capabilities.resource_types).toContain("postgres");
  });

  it("awsEcsBasic maps small to 0.25 vCPU and 512 MiB", () => {
    expect(awsEcsBasic.runtime.size_map.small).toEqual({
      vcpu: 0.25,
      memory_mib: 512,
    });
  });

  it("uses the confirmed P0 runtimes and ingress types", () => {
    expect(awsEcsBasic.runtime.type).toBe("ecs-fargate");
    expect(awsEcsBasic.ingress.type).toBe("alb");
    expect(onpremDockerBasic.runtime.type).toBe("docker-compose");
    expect(onpremDockerBasic.ingress.type).toBe("cloudflare-tunnel");
  });
});

describe("PROFILES map", () => {
  it("contains the container, serverless, static site, and on-prem profiles", () => {
    expect(Object.keys(PROFILES)).toEqual(
      expect.arrayContaining(["aws-ecs-basic", "aws-lambda-basic", "aws-static-basic", "onprem-docker-basic"]),
    );
    expect(PROFILES["aws-ecs-basic"]).toBe(awsEcsBasic);
    expect(PROFILES["onprem-docker-basic"]).toBe(onpremDockerBasic);
  });
});
