import { describe, it, expect } from "vitest";
import {
  ProfileSchema,
  awsEcsBasic,
  onpremDockerBasic,
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

describe("capabilities", () => {
  it("awsEcsBasic service_types includes 'http'", () => {
    expect(awsEcsBasic.capabilities.service_types).toContain("http");
  });

  it("awsEcsBasic resource_types includes 'postgres'", () => {
    expect(awsEcsBasic.capabilities.resource_types).toContain("postgres");
  });
});

describe("PROFILES map", () => {
  it("contains both profiles", () => {
    expect(Object.keys(PROFILES)).toHaveLength(2);
    expect(PROFILES["aws-ecs-basic"]).toBe(awsEcsBasic);
    expect(PROFILES["onprem-docker-basic"]).toBe(onpremDockerBasic);
  });
});
