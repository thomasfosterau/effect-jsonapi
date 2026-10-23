---
"@thomasfosterau/effect-jsonapi": patch
---

The conformance kit's `spec/status/update-read-back`, `spec/atomic/lid-resolution` and `spec/atomic/all-or-nothing` rules now compare a write fixture's members as the JSON its request carried, so a fixture attribute whose JSON differs from its runtime value (a `Date`, sent as its ISO string) no longer reads back as a difference.
