---
"@thomasfosterau/effect-jsonapi": patch
---

`Conformance`: `spec/status/create-client-id-unsupported` now requires the 403 to a create under an unsupported client-generated id to carry an error whose `source.pointer` is the resource object's id, `/data/id`, as `spec/atomic/add-client-id-unsupported` requires the operation's. A 403 with no pointer fails the rule, as does one that names only some other member.
