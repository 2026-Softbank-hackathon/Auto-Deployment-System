import { IrSchema } from "@camellia/ir-schema";

export function createSimpleHttpIr(
  profile: "aws-ecs-basic" | "onprem-docker-basic",
  size: "small" | "medium" | "large" = "small",
) {
  return IrSchema.parse({
    $ir_version: "0.1.0",
    metadata: {
      name: "demo-app",
      version: "1.0.0",
    },
    services: {
      web: {
        type: "http",
        build: {
          context: ".",
          buildpack: "railpack",
        },
        command: ["node", "server.js"],
        port: 3000,
        health: {
          path: "/health",
          expected_status: 200,
          timeout_seconds: 3,
        },
        env: ["NODE_ENV"],
        expose: "public",
        size,
      },
    },
    deploy: {
      profile,
    },
    expose: {
      tls: true,
    },
  });
}
