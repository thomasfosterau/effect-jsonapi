---
"@thomasfosterau/effect-jsonapi": patch
---

`Query.schema(…, { fields: true })`: when two resource definitions sharing a wire type are reachable from one endpoint, `fields[TYPE]` now accepts the union of their attributes, as the decoded type already did. Previously only the attributes of the definition reached last were accepted, so a fieldset that type-checked could be rejected with a 400 depending on relationship declaration order (#362).
