---
"@thomasfosterau/effect-jsonapi": minor
---

**Breaking:** require `effect@>=4.0.0-rc.118` (was `>=4.0.0-rc.113`) and build against `4.0.0-rc.118`.

Effect rc.118 removed every `effect/unstable/*` import path with no compatibility export: `effect/unstable/http` is now `effect/http`, `effect/unstable/httpapi` is now `effect/http-api`, and the published declarations import the new paths. No earlier `effect` release resolves them, so the peer floor moves with the paths. A consumer on rc.117 or below must upgrade `effect` and every `@effect/*` companion to rc.118 together, and must resolve a single `effect` copy.

The public API of this package is unchanged: every export, signature and wire behaviour is the same, and `Middleware`, `ServerErrors`, `Registry`, `Negotiation`, `Query`, `Assemble` and `Group` keep their shapes. What rc.118 forced:

- Import paths in the emitted `.d.ts` and `.js` (`effect/http`, `effect/http-api`), as above.
- `Schema.isLengthBetween` was renamed `Schema.isBetweenLength` in rc.118. `FlatQuery.slug` uses the new name; its accepted values and messages are unchanged, but the internal check identifier a `SchemaRepresentation` or JSON Schema document records for the length check is now the rc.118 one, so regenerate any stored representation of a `slug` schema.
- Effect's own `HttpApi` type identifiers and service keys now read `http-api` rather than `httpapi`. Code that matches those strings, such as a snapshot or an SSE client keyed on the reserved failure event name, needs the new spelling. This package matches none of them.
- `/schema` still resolves `effect` alone. Its entry-point tests now assert that it reaches none of Effect's HTTP surface (`effect/http`, `effect/http-api`) rather than the removed `effect/unstable/*` namespace.
