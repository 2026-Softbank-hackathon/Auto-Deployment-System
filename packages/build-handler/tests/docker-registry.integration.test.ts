import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BuildHandler, NodeCommandRunner } from "../src/index.js";

const packageDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(packageDirectory, "../../..");
const samplePath = path.join(repositoryRoot, "apps/samples/monolith");
const registry = process.env["BUILD_TEST_REGISTRY"] ?? "localhost:5000";

describe("Docker Registry integration", () => {
  it("builds, pushes, and returns a linux/amd64 image digest", async () => {
    const tag = `integration-${Date.now()}`;
    const result = await new BuildHandler().build({
      workspacePath: samplePath,
      plan: { context: ".", dockerfile: "Dockerfile" },
      image: {
        repository: `${registry}/camellia/monolith`,
        tag,
      },
    });

    expect(result.strategy).toBe("dockerfile");
    expect(result.platform).toBe("linux/amd64");
    expect(result.image.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.image.immutableRef).toBe(
      `${registry}/camellia/monolith@${result.image.digest}`,
    );

    const inspected = await new NodeCommandRunner().run({
      command: "docker",
      args: ["buildx", "imagetools", "inspect", result.image.taggedRef],
      cwd: samplePath,
    });
    expect(inspected.stdout).toContain(`Digest:    ${result.image.digest}`);
  });
});
