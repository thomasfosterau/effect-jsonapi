---
"@thomasfosterau/effect-jsonapi": minor
---

Add a schema-only entry point: `@thomasfosterau/effect-jsonapi/schema`

The package had a single `"."` export, so every consumer reached every module through one barrel
that imports `effect/unstable/httpapi`. A client decoding documents, or a consumer mapping them into
something else, resolved the whole server surface to get at schemas that never needed it.

`@thomasfosterau/effect-jsonapi/schema` re-exports the modules whose import graph is `effect` alone —
`Client`, `Document`, `Filter`, `Relationship`, `Resource`, `Sort` and `MEDIA_TYPE`:

```ts
import { Document, Resource } from "@thomasfosterau/effect-jsonapi/schema"
```

Error _documents_ are still reachable, since `Document.ErrorDocument` and `Document.ErrorObject` are
document schemas; it is `ApiError`'s error _classes_ that carry HTTP status and content-type
annotations.

This is about the dependency, not the bytes. `effect/unstable/*` is pre-stable, so every unnecessary
dependency on it is a version-compatibility surface — tree-shaking may drop the code, but it cannot
drop the dependency.

The root export is unchanged: it still exports every namespace, every symbol is the same object under
both entry points, and no existing import is affected. The subpath is a packaging seam, not a second
API — the generated docs are unchanged.

Internally, `internal/media.ts` was reduced to the media type constants, with no imports at all; the
annotation helpers it re-exported from the public `MediaType` module moved to `internal/httpMedia.ts`
alongside `asJsonApiAtomic`. `MediaType` now takes `MEDIA_TYPE` from `internal/media.ts` instead of
redefining it. No public behaviour changes.

`Query`, `Handlers`, `Lid` and `Atomic` read as schema-only but are outside the tier: constraining
include paths fails with `ApiError.UnsupportedIncludePath` / `UnsupportedIncludeDepth`, which are
`HttpApi`-bound error classes, and the other three reach `Query`. Including them would mean
separating `ApiError`'s error classes from their wire annotations — a change to a public module
rather than a packaging one.

The property is enforced mechanically by `test/entry-points.test.ts`, which walks the real import
graph from the entry point (AST-based, counting type-only imports), pins the tier membership, repeats
the check on the built artifact, and loads the published subpath in a child process where
`effect/unstable/*` is unresolvable. Each check is paired with a control asserting it still detects a
violation via the root barrel, so it cannot rot into a tautology.
