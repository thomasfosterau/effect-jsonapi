import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

/**
 * Input fingerprint for this package's cached tasks: auto tracking minus
 * node_modules bookkeeping churn (pnpm rewrites `.modules.yaml` on every
 * install), plus the library's own sources — the example resolves the package
 * to `src/`, so a change there must invalidate this package's check and test
 * runs — and the lockfile, so a dependency upgrade does too.
 */
const cacheInputs = [
  { auto: true },
  "!node_modules/**",
  { pattern: "!node_modules/**", base: "workspace" as const },
  { pattern: "src/**", base: "workspace" as const },
  { pattern: "pnpm-lock.yaml", base: "workspace" as const },
];

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the library to its source, exactly as the root config does, so
      // the example is tested against the live `src/`. The subpath entry must
      // come first: string aliases match by prefix, so the root entry would
      // otherwise swallow "@thomasfosterau/effect-jsonapi/schema".
      "@thomasfosterau/effect-jsonapi/schema": fileURLToPath(
        new URL("../../src/schema.ts", import.meta.url),
      ),
      "@thomasfosterau/effect-jsonapi": fileURLToPath(
        new URL("../../src/index.ts", import.meta.url),
      ),
    },
  },
  run: {
    tasks: {
      check: {
        command: "tsc -p tsconfig.json",
        cache: {
          input: cacheInputs,
          output: [],
        },
      },
      "test:unit": {
        command: "vp test run",
        cache: {
          env: ["VITEST_MAX_WORKERS", "NODE_OPTIONS"],
          input: cacheInputs,
          output: [],
        },
      },
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
