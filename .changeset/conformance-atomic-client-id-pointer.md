---
"@thomasfosterau/effect-jsonapi": patch
---

`Conformance`: `spec/atomic/add-client-id-unsupported` now requires the 403 to an atomic `add` under an unsupported client-generated id to carry an error whose `source.pointer` is the operation's id, `/atomic:operations/N/data/id`. A 403 with no pointer fails the rule, as does one that names only the operation or `/data/id`.
