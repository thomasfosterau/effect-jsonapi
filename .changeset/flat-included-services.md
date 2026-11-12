---
"@thomasfosterau/effect-jsonapi": patch
---

`Group.flat` / `Group.flatReadOnly` keep their include surface's `included` union in the endpoints' success schemas (#595). It was inferred while the surface type was still generic, which widened it to `Schema.Top`: every endpoint's decoding services became `unknown`, so a typed `Client.make` method required `unknown` and `effect/cli` commands built on one failed to type-check. Applications that worked around it with a `Schema.Codec<…, never, never>` cast can drop the cast.
