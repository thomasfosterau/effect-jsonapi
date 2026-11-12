---
"@thomasfosterau/effect-jsonapi": minor
---

**Breaking:** the `effect` peer is now `^4.1.0` (was `^4.0.0`). The published declarations need effect 4.1's HttpApi types: on effect 4.0.6 a `Group.resource` endpoint's `~Success` resolves to `any`, so a typed `Client.make` consumer loses every response type without a compile error at the declaration. Migration: move the application to `effect` >= 4.1.0 (website, gardeneria, preferenceflow, in-the-dark) before bumping this package. A new CI job (`vp run typecheck:floor`) compiles a typed `Client.make` consumer against the packed package and effect 4.1.0 exactly, so the floor cannot drift again (#586).
