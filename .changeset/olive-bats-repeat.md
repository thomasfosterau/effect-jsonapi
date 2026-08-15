---
"@thomasfosterau/effect-jsonapi": minor
---

**Constrainable `include` paths.** `Query.Include` derived the resource's whole relationship graph
to a depth of 2, and `include` was a boolean over that set — so an endpoint advertised every path
the graph reaches, including ones its resolver was never written for. Advertising an unresolvable
path answers 200 with an empty `included`, which is strictly worse than the 400 an unknown path
already produces.

`Query.Include` now takes an options object — `paths` (an explicit allow-list) and/or `depth`
(`1` / `2` / `3`; `paths` wins when both are given) — and the same object may be passed as `include`
wherever a boolean was accepted: `Endpoint.get` / `list` / `related` / `collection` /
`polymorphic`, `Query.schema`, and `Endpoint.resource` / `Group.resource` both top-level and per
endpoint. The literal path type narrows with the runtime set, so an unlisted path fails to compile
as well as to decode. `include: true` still means today's full-graph depth-2 derivation, and the
relationship endpoints — whose paths are their target's graph, not the configured resource's —
inherit only that `include` is on.

Adds `Resource.IncludeDepth` and `Resource.IncludePathsTo<R, Depth>` (the type-level mirror of
`Resource.includePaths`' `maxDepth`), plus `Query.IncludeOptions` / `Query.IncludeOption` /
`Query.IncludePathsOf`. `Query.Include<R>` gains a second, defaulted type parameter for its path
set; `Endpoint.GetConfig<Meta>` gains a second, defaulted parameter for the resource it configures.
