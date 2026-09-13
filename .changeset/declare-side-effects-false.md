---
"@thomasfosterau/effect-jsonapi": minor
---

Declare `sideEffects: false` in package.json for better bundler tree-shaking. Remove `src/` from published files — the package now only ships `dist/`, `README.md`, and `LICENSE`, matching the structure of sibling libraries. Disable declaration maps and source maps in `tsconfig.json` to avoid references to unpublished source files.
