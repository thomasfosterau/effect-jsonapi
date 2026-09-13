---
"@thomasfosterau/effect-jsonapi": minor
---

Make `asJsonApi` and `asMediaType` public via new `MediaType` namespace module

Expose media type annotation combinators as a public `MediaType` module for developers writing hand-rolled endpoints with `HttpApiEndpoint`. Previously only available as `@internal` functions, `asJsonApi` marks schemas as JSON:API bodies and `asMediaType` marks them with arbitrary media types — the same annotations the package's own `Endpoint` constructors use internally.

The `asJsonApiAtomic` combinator remains internal as it is specialized to the atomic operations extension.
