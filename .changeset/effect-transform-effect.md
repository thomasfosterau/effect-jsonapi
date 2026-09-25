---
"@thomasfosterau/effect-jsonapi": minor
---

Build against Effect `4.0.0-rc.113` and later, and raise the published `effect` peer floor to `>=4.0.0-rc.113`.

Effect `4.0.0-rc.113` renamed `SchemaTransformation.transformOrFail` to `SchemaTransformation.transformEffect`. The options are unchanged. The filter grammar (`Query.Filter`), the combined query schema's `filter[...]` routing (`Query.schema`) and the filter-literal codecs now call `transformEffect`. Decoding, encoding and error output do not change. Before this, every `effect` release from `rc.113` up was inside the declared range but failed to compile.

No Effect release has both names, so one range cannot cover `rc.112` and `rc.113+`. This release therefore publishes `>=4.0.0-rc.113`, still open at the top as the shared Effect-floor policy requires. It supersedes the `>=4.0.0-rc.112` floor in the other peer-floor entry of this release, which never reached npm. **This is breaking for consumers on `effect@4.0.0-rc.112`**: move Effect to `rc.113` or later (the applications' `rc.115` lockstep qualifies), or stay on `effect-jsonapi@0.14.x`.
