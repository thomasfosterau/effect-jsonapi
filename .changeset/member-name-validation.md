---
"@thomasfosterau/effect-jsonapi": minor
---

`Resource.make`, `Resource.extend` and `Resource.family` now throw a `DeclarationError` for a type, attribute or relationship name that isn't a legal JSON:API member name (JSON:API 1.1 §7.10: `"bad type!"`, `"a.b"`, `"x,y"`, `"_hidden"`), and for an attribute whose encoded value is or holds an object with a `links` or `relationships` member, which §7.2.2.1 reserves. A `.` or `,` in a field name also broke include paths, `fields[TYPE]` and `sort`.
