---
"@thomasfosterau/effect-jsonapi": minor
---

**Breaking:** `Resource.make` and `Resource.extend` now enforce JSON:API 1.1 §Fields, under which a resource's attributes and relationships share one namespace with each other and with `type` and `id`. An attribute or relationship named `type` or `id`, or a name declared as both an attribute and a relationship (including an extension's attribute over a base relationship, or the reverse), is a type error at the offending key and throws when the definition is built, naming the field and the call (#503). Migration: rename the field. Before, such a definition was accepted and produced a resource object the specification forbids (an `id` attribute was silently shadowed by the resource id in `updateInput`).
