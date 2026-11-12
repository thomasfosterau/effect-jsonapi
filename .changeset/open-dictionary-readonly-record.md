---
"@thomasfosterau/effect-jsonapi": patch
---

The open `meta`, `attributes`, `relationships` and `links` objects of the wire-shape types (`Assemble.WireResource`, `Assemble.ResourceDocument`, `Handlers.MetaValue`, `Client` create/update inputs, `Client.readTotalCount`, …) and `Filter.FieldTypes` are now spelled `ReadonlyRecord<string, unknown>` from `effect/Record` instead of a hand-written index signature. The types are identical, so no migration is needed; `Filter.FieldTypes` is now a type alias rather than an interface.
