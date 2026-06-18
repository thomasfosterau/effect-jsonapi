import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      // Lets examples and tests import the library by its package name,
      // exactly like user code does.
      "@thomasfosterau/effect-jsonapi": fileURLToPath(new URL("./src/index.ts", import.meta.url))
    }
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"]
  }
})
