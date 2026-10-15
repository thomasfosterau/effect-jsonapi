---
"@thomasfosterau/effect-jsonapi": minor
---

**Every module is now published as a subpath export of its own (#385)**, as `effect` publishes `effect/Schema`: `@thomasfosterau/effect-jsonapi/Resource`, `…/Endpoint`, `…/Group`, `…/Client` and so on, one for each of the 24 namespaces the package root exports. A subpath is the same module as the root's namespace, not a copy, so its values (`Resource.make`, the `ApiError` classes, …) are identical whichever way they are imported, and the schema-tier subpaths (`Document`, `Filter`, `FlatQuery`, `Include`, `Relationship`, `Resource`, `Sort`) depend on `effect` alone, as `./schema` does. The root and `./schema` imports are unchanged.

Each subpath ships its module's own declaration file, so declaration emit can always name a type through it. A project compiling with `declaration: true` can now export an endpoint, a group or a client built over resources **defined in another file** without an annotation, where before it failed with TS2883 (`cannot be named without a reference to 'Resource' from '…/dist/media-<hash>'`); the `satisfies Resource.Any` workaround is no longer needed.

The 23 type-only aliases added at the package root for declaration emit in 0.17.0 (`QuerySchema`, `ContentNegotiation`, `ApiErrorWire`, `BadRequest`, `CollectionDocument`, …) are deprecated in favour of the subpaths: write `Query.QuerySchema`, or import it from `@thomasfosterau/effect-jsonapi/Query`. They are still exported.

The layout of `dist/` changes with this: one JavaScript entry per export with shared code in hashed chunks, and one `.d.ts` per source module (the declarations are no longer bundled). Only the `exports` map is public; a deep import of a `dist/` file was never supported.
