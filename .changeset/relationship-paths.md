---
"@thomasfosterau/effect-jsonapi": minor
---

Add relationship-path filters and sorts. A to-one relationship declared `Relationship.one(ref, { traverse: true })` (or `optional`) exposes its target's own filterable and sortable fields as dotted paths: `filter[author.name]=Ada`, `sort=-author.name`. The paths join `Resource.filterable` / `Resource.sortable` and `Resource.FilterableKeys` / `SortableKeys` (new: `TraversableKeys`, `FilterPathKeys`, `SortPathKeys`) with the target's operators and literal codec, one hop deep. `sort` allow-lists on `Query.schema`, `Endpoint` and `Group` accept them (`Resource.SortKeys`). The `One` / `Optional` descriptors gain a `traverse` member and type parameter, defaulting to `false`.
