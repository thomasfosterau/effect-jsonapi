---
"@thomasfosterau/effect-jsonapi": minor
---

`Resource.make` and `Resource.extend` now enforce JSON:API 1.1 §Fields: an attribute or relationship named `type` or `id`, or a name declared as both an attribute and a relationship (including an extension's attribute over a base relationship, or the reverse), is a type error at the offending key and throws when the definition is built (#503). This is breaking for a definition that declared such a field: rename it.
