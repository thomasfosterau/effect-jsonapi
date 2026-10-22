---
"@thomasfosterau/effect-jsonapi": patch
---

The full-linkage walk now starts from the primary identifiers when a document's primary data is resource linkage (a relationship document), as JSON:API 1.1 §Compound Documents requires. `Handlers.buildIncluded` given a relationship document's identifiers as `primary`, the conformance kit's `spec/document/full-linkage` rule and the endpoint middleware's post-encode check no longer report an `included` member reachable only through a primary identifier, and `Handlers.buildIncluded` no longer drops an identified resource's `included` object as a duplicate of its identifier. `Handlers.data` and `Handlers.collection` are unchanged.
