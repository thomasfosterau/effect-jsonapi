---
"@thomasfosterau/effect-jsonapi": minor
---

Add a per-resource transform pass to the document builders, so sparse fieldsets and computed `meta` apply uniformly to primary data and `included`.

`Handlers.data`, `Handlers.collection`, `Handlers.linkage` and `Handlers.buildIncluded` now take an `onResource` transform, applied **once per resource** to every slot the document has: the primary `data`, every deduplicated `included` member, and a linkage document's resource identifiers. It runs after dedup (so a transform runs once per distinct resource, not once per occurrence) and before the full-linkage check (so the check sees what the document actually emits). A resource reached in two slots is shaped once and reused, so it cannot come out two ways.

Three transforms ship with it, plus an escape hatch:

- `Handlers.project(fields)` / `Handlers.project(resource, fields)` — sparse fieldsets. A type with no requested set is returned unchanged (the spec's "every field", not "no field"), and only `attributes` is projected; `relationships`, `links` and `meta` are left alone. Relationship fields (`?fields[articles]=author`) are out of scope.
- `Handlers.withMeta(compute)` — computed per-resource `meta`, merged over whatever the resource carries. An empty merged result emits **no** `meta` member rather than `{}`.
- `Handlers.compose(first, second)` — one pass doing both.
- `Handlers.transform<Lambda>(f)` — any other per-resource processing.

A transform's effect stays visible in the document's type rather than widening to `ResourceValue`: `Handlers.data(article, { included, onResource: Handlers.project({ articles: ["title"] }) })` types both `data.attributes` and the included articles' `attributes` as `{ title: string }`. This is carried by a type-level function (`Handlers.TransformLambda` / `Handlers.Transformed`), since one transform is applied at several types in a single document. A plain function is still accepted and is checked against `Handlers.IdentityLambda` — it must return the resource's own type.

`Handlers.DocumentValue`'s `Included` parameter is no longer constrained to `ResourceValue`, so it can name a transform's output type.
