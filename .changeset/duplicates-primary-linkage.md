---
"@thomasfosterau/effect-jsonapi": patch
---

The conformance kit's `spec/document/no-duplicate-resources` rule no longer counts a relationship document's primary identifiers as resource objects, so a relationship document whose `included` carries the full resource for one of its identifiers is no longer reported as a duplicate. Two `included` members with the same `(type, id)` are still reported.
