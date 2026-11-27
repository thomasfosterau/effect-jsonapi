---
"@thomasfosterau/effect-jsonapi": minor
---

Add `memberNames` to `Resource.make` and `Resource.extend`: the names attributes and relationships carry on the wire, as a preset (`"kebab"`, `"snake"`, `"camel"`), a record from key to wire name, or a function. Everything on the wire uses the wire names (resource objects, create and update payloads, `createInput` / `updateInput`, atomic operations, the `fields`, `sort`, `filter` and `include` vocabularies, relationship routes, error pointers and OpenAPI), and everything decoded uses the keys, so handlers are unchanged. The presets and records are typed per key (`typeof R.Encoded` names `"created-at"`); a function's wire names are typed `string`. `Resource.memberNames(R)` reads the renamed members back. Without the option nothing changes.
