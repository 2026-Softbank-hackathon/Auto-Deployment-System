import type { OnpremAgentJob } from "../src/contracts.js";

export function createJob(
  overrides: Partial<OnpremAgentJob> = {},
): OnpremAgentJob {
  return {
    jobId: "job-001",
    attempt: 1,
    deploymentId: 42,
    environmentId: "env-onprem-1",
    plan: {
      schemaVersion: "0.1.0",
      profile: { id: "onprem-docker-basic", version: "1.0.0" },
      application: { name: "demo-app", version: "1.0.0" },
      build: { context: ".", dockerfile: "Dockerfile" },
      service: {
        name: "web",
        type: "http",
        command: ["node", "server.js"],
        containerPort: 3000,
        environmentNames: ["APP_MESSAGE"],
        secretNames: [],
        compute: { vcpu: 0.25, memoryMiB: 512 },
      },
      health: { path: "/health", expectedStatus: 200, timeoutSeconds: 3 },
      ingress: {
        enabled: true,
        exposure: "public",
        type: "cloudflare-tunnel",
        tls: true,
        routes: [{ path: "/", service: "web", port: 3000 }],
      },
      target: "onprem",
      runtime: {
        type: "docker-compose",
        cpus: 0.25,
        memoryMiB: 512,
        replicas: 1,
      },
      provisioning: {
        engine: "docker-compose",
        projectName: "demo-app",
      },
    },
    image: {
      repositoryUri:
        "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/camellia/demo",
      digest: `sha256:${"a".repeat(64)}`,
      platform: "linux/amd64",
      registryType: "ecr",
      region: "ap-northeast-2",
    },
    environment: { APP_MESSAGE: "do-not-log-this" },
    ...overrides,
  };
}
