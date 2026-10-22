---
"@thomasfosterau/effect-jsonapi": minor
---

`Endpoint.collection` and `Endpoint.polymorphic` under a declared `Include.Surface` now derive their default success document's `included` union from the surface's own `included`, exactly as `Endpoint.get` / `list` / `related` do (#336), in its type and in the runtime schema. The paths the endpoint advertises and the resources its document admits now come from one declaration, so a surface with a depth-2 path such as `comments.author` can be answered: the `people` it brings in type-check and encode, where before they were rejected (a 500 on encode).

This narrows the union: it admits exactly what the surface names, so a member's non-`paginated` direct target the surface leaves out (say `companies` behind `Person.employer` on a search over `[Article, Person]` whose surface only declares `comments.author`) is no longer admitted in `included`. A handler that returned such a resource must add it to the surface, or override `success`. With `fields: true`, each of the surface's members a fieldset names admits any subset of its attributes. `Include.included(members, { include: surface })` already returned the surface's union, and now matches what these endpoints bind; an `include` that may be a surface or not (`which ? surface : true`) is typed as either union.
