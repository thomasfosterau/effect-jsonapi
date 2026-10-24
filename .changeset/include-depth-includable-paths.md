---
"@thomasfosterau/effect-jsonapi": minor
---

`ApiError.UnsupportedIncludeDepth` now carries the endpoint's legal include paths as `meta.includablePaths`, as `UnsupportedIncludePath` already does, so a caller that over-nested a `?include=` path learns which paths it may retry with (#512). `Query.validateIncludePaths` — and so `Assemble`, `ResourceHandlers` and `Handlers.resolveIncluded` — fills it from the `includable` set it already receives, and the error's `detail` now ends with the supported paths.

**Breaking for direct construction:** `new ApiError.UnsupportedIncludeDepth({ path, maxDepth })` now requires `includablePaths: ReadonlyArray<string>`. Pass the same allow-list you validated against (or `[]`). On the wire the change is additive: `meta` gains one member.
