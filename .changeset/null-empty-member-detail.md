---
"@thomasfosterau/effect-jsonapi": patch
---

A `null` write-body `attributes` or `relationships` member that declares no fields now answers its 400 with the detail `Expected object`, as a member that declares fields does, instead of `Expected object | array` (#286). The status and `source.pointer` are unchanged, and so is the generated OpenAPI document.
