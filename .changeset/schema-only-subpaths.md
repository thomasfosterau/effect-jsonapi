---
"@thomasfosterau/effect-jsonapi": minor
---

**Subpath exports, so the `Schema`-only modules are reachable without the HTTP surface.** The
package had a single `.` export, and `src/ApiError.ts` imports `effect/unstable/httpapi` — so a
client decoding documents, a consumer mapping them into something else, or a non-HTTP producer
(a CLI, a code generator, a test fixture) resolved the whole server surface to get at wire types.
The module graph never required it. While `effect/unstable/*` is pre-stable an unnecessary
dependency on it is a version-compatibility surface, and tree-shaking cannot help with that: a
bundler may drop the code, it cannot drop the peer.

Every module is now also published at its own subpath, named exactly after the module:

```ts
import { Document } from "@thomasfosterau/effect-jsonapi" // unchanged: the whole library
import * as Document from "@thomasfosterau/effect-jsonapi/Document" // just this module
```

Ten of the fourteen — `Atomic`, `Client`, `Document`, `Filter`, `Handlers`, `Lid`, `Query`,
`Relationship`, `Resource` and `Sort` — resolve `effect` and nothing else. `ApiError`, `Endpoint`,
`Group` and `Middleware` are the HTTP tier. Both entry points resolve to the same file, so a
resource imported through one is referentially identical to the same resource imported through the
other — `Relationship.one(() => Resource)` keeps working across the two.

`Atomic` is in the schema-only tier because `src/internal/media.ts` split in two: the spec's
media-type constants (which `Atomic` wanted) now have no dependencies at all, and the
`HttpApiSchema` combinators that needed `effect/unstable/httpapi` moved to `src/internal/body.ts`.
`src/internal/` remains unexported.

**The root export is unchanged and no existing import breaks.** The subpaths are a packaging
detail, not a second API: the README and the API docs still present one library.

Also in this change, from the same packaging pass:

- `sideEffects: false` is declared, so a bundler can drop the modules a consumer doesn't reach
  through the root barrel. Every module is pure, so the declaration is accurate.
- `pnpm run check:packaging` runs `publint`, `arethetypeswrong` (the `esm-only` profile — the
  package is ESM-only by design) and a set of bundler assertions over the real tarball, in CI.
  `test/module-graph.test.ts` pins the tier table and asserts it in both directions, so a module
  changing tier fails the test rather than drifting.
- `files` keeps `src/`, now with the reason recorded in `PUBLISHING.md`: the build emits
  `declarationMap` and `sourceMap` pointing at `../src/*.ts`, so the sources are what make "go to
  definition" and debugger stack traces resolve.
- `repository.url` is a full `git+https://` URL, and the CI matrix adds Node 24 so
  `engines.node: ">=20.0.0"` reflects what is actually tested.
