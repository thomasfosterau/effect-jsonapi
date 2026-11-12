---
"@thomasfosterau/effect-jsonapi": patch
---

The `@thomasfosterau/effect-ext` dependency range widens from `^0.1.0` to `^0.1.0 || ^0.2.0` (#585), so an application already on effect-ext 0.2 no longer gets a second, nested 0.1 copy under this package. Nothing this package imports from effect-ext changed incompatibly in 0.2.0, and the test suite now runs against 0.2.0.
