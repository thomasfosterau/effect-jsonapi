---
"@thomasfosterau/effect-jsonapi": minor
---

**Breaking:** `Client.IncludedIndex` (what `Client.indexIncluded` returns and `Hydrated.index` carries) and `Include.Surface`'s `targets` member are now an effect `HashMap` keyed the same way, no longer a native `ReadonlyMap`. `Client.related`, `Client.walk` and `Client.hydrate` take and return them unchanged, so code that only passes the index along is unaffected. Migration: read an entry with `HashMap.get(index, key)` (an `Option`) instead of `index.get(key)`, test for one with `HashMap.has(index, key)` instead of `index.has(key)`, and count them with `HashMap.size(index)` instead of `index.size`; the same for `surface.targets`. An index you built yourself from a `Map` becomes `HashMap.fromIterable(entries)`.
