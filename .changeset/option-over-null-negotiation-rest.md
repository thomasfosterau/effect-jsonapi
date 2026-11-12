---
"@thomasfosterau/effect-jsonapi": minor
---

**Breaking:** `Negotiation.Options`' `onExplicitRefusal` and `extensions` are `readonly x?: T`, like the rest of its members (`effect/prefer-option-over-null`, 6 of 6, #533): they were `?: T | undefined`, so under `exactOptionalPropertyTypes` they no longer accept an explicit `undefined`.

Migration for the apps: leave the key out rather than set it to `undefined`. With a maybe-undefined value, spread one `definedMember("extensions", extensions)` (the helper the 4-of-6 changeset gives) into the options object instead of writing `extensions: extensions`; a conditional empty-object spread is rejected by `effect/no-conditional-empty-object-spread`.
