---
"@thomasfosterau/effect-jsonapi": minor
---

The resource id can be declared filterable (#556). Pipe the schema passed as `Resource.make`'s `id` option through `Filter.able` — `id: Schema.String.pipe(Filter.able(["eq", "in"]))` — and `Resource.filterable` reports it under the key `id`, with the id schema as its literal codec, so `filter[id]=…`, `filter[id][in]=…` and the group form decode and encode through `Query.schema(R, { filter: true })` / `Query.Filter(R)`. `Resource.FilterableKeys`, `FilterOperators` and `Filterable` name it at the type level.

This restores what an `id` attribute declared before 0.19.0, now that JSON:API's reserved field names are refused: an attribute named `id` is still an error. The default derived id is not filterable, and nothing changes for a resource whose id schema carries no declaration. `Resource.extend` with `inheritId: true` inherits the base id's declaration, at runtime and in the types.
