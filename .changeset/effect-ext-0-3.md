---
"@thomasfosterau/effect-jsonapi": patch
---

The `@thomasfosterau/effect-ext` dependency range widens from `^0.2.0` to `^0.2.0 || ^0.3.0`, so an application already on effect-ext 0.3 gets one copy instead of a second, nested 0.2. The effect-ext modules this package uses (`Bounded`, `Ids`, `Issues`, `TriState`) are unchanged in 0.3.0 apart from `TriState.suppliedValue` taking `field?: Option<A>`, which every existing call satisfies. The test suite now runs against 0.3.0. No published type or behaviour changes.
