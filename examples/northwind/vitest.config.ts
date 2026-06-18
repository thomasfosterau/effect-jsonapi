import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the library to its source, exactly as the root config does, so
      // the example is type-checked and tested against the live `src/`.
      "@thomasfosterau/effect-jsonapi": fileURLToPath(new URL("../../src/index.ts", import.meta.url))
    }
  },
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"]
  }
})
