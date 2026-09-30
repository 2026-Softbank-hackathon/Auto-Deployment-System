/**
 * tests/e2e/vitest.config.ts
 *
 * e2e 전용 vitest 설정.
 * globalSetup으로 Postgres 준비, testTimeout 60s.
 */

import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname ?? __dirname, "../..");

export default defineConfig({
  resolve: {
    // Allow importing .ts files with .js extension (TypeScript ESM convention)
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    alias: [
      // subpath entries must come before parent package entries
      { find: "@camellia/analyzer/stager", replacement: resolve(ROOT, "packages/analyzer/src/stager.ts") },
      { find: "@camellia/analyzer", replacement: resolve(ROOT, "packages/analyzer/src/index.ts") },
      { find: "@camellia/db", replacement: resolve(ROOT, "packages/db/src/index.ts") },
      { find: "@camellia/storage", replacement: resolve(ROOT, "packages/storage/src/index.ts") },
      { find: "@camellia/ir-schema", replacement: resolve(ROOT, "packages/ir-schema/src/schema.ts") },
      { find: "@camellia/contracts", replacement: resolve(ROOT, "packages/contracts/src/index.ts") },
    ],
  },
  test: {
    globals: true,
    environment: "node",
    testTimeout: 60000,
    hookTimeout: 30000,
    globalSetup: ["./tests/e2e/setup.ts"],
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    include: ["tests/e2e/**/*.test.ts"],
    // Force CJS packages through native Node require (no vite ESM wrapping)
    deps: {
      optimizer: {
        ssr: {
          exclude: [
            "pg",
            "pg-boss",
            "pg-native",
            "pino",
            "pino-pretty",
          ],
        },
      },
    },
  },
});
