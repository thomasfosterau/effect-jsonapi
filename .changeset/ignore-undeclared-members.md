---
"@thomasfosterau/effect-jsonapi": minor
---

`Resource.make` and `Resource.extend` take `undeclaredMembers: "reject" | "ignore"`. `"ignore"` drops attributes and relationships a write body doesn't declare instead of answering 400; `"reject"` stays the default.
