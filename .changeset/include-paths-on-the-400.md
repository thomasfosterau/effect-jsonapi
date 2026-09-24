---
"@thomasfosterau/effect-jsonapi": minor
---

Publish the legal vocabulary on the 400 for a rejected `?include=` path or `?sort=` field, and ship the adoption guide for the 0.14 surfaces.

A request naming an include path outside the endpoint's declared surface (or a sort field outside its sortable set) was already answered with a spec-compliant 400 whose `source.parameter` named the offending key — but not with what the endpoint _does_ accept, so a caller that guessed wrong had to guess again. The include and sort literal schemas now carry that set as error `meta`, and `Middleware.schemaErrorDocument` copies it onto the error object: `meta.includablePaths` (the same set `ApiError.UnsupportedIncludePath` publishes) and `meta.sortableFields`. Error objects for schemas that publish nothing are unchanged — no `meta` member appears.

`docs/guides/adopting-0.14.md` walks an existing consumer from its own include spec, include walk, fieldset projection, error-document decoder and Accept parser to `Include.make`, `Handlers.resolveIncluded`, `Handlers.compose(project, withMeta)`, `Client.errorDocument` and `Middleware.negotiate`, with before/after code taken from a consuming application; every "after" snippet is executed by `test/guides/adopting-0.14.test.ts`.
