---
"@thomasfosterau/effect-jsonapi": patch
---

`Handlers.project` reads an empty `?fields[TYPE]=` as "no fields", as JSON:API 1.1 §Sparse Fieldsets requires ("An empty value indicates that no fields should be returned"), and projects that type's `attributes` to `{}`. It used to read it as the absent parameter and return every attribute. `Handlers.Projected` types an empty literal set (`{ articles: [] }`) as no attributes. `relationships` is still kept under every set, so the full-linkage checks keep passing (#488). The conformance kit gains `spec/query/sparse-fieldsets-empty`, which checks that an empty `fields[TYPE]=` returns no attributes.
