---
"@thomasfosterau/effect-jsonapi": minor
---

**Raise the published `effect` peer floor to `>=4.0.0-rc.112`.** The package peered
`>=4.0.0-beta.104`, a range far wider than anything it is built or tested against: the dev
dependency, every example workspace and CI all pin `4.0.0-rc.112` exactly, so every version
between `beta.104` and `rc.112` was an untested compatibility claim. The floor now matches the
lowest version the package actually verifies against.

This is a **breaking change for consumers below the new floor** — they must upgrade `effect` to
`4.0.0-rc.112` or later. It is released as a `minor` because the package is pre-1.0, where the
repo's convention carries breaking changes in the minor position.

No source changes accompany it: the library compiles unmodified across the whole span the old
floor admitted, so the bump is a declaration change only, not a behavioural one. The dev
dependency stays an exact pin (`4.0.0-rc.112`); only the published peer range is open.
