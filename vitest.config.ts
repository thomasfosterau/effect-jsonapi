import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      // Lets examples and tests import the library by its package name,
      // exactly like user code does. The subpath entry must come first:
      // vitest matches string aliases by prefix, so the root entry would
      // otherwise swallow "@thomasfosterau/effect-jsonapi/schema".
      "@thomasfosterau/effect-jsonapi/schema": fileURLToPath(new URL("./src/schema.ts", import.meta.url)),
      "@thomasfosterau/effect-jsonapi": fileURLToPath(new URL("./src/index.ts", import.meta.url))
    }
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"]
  }
})
