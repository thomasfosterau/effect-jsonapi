---
"@thomasfosterau/effect-jsonapi": minor
---

Migrate off `Schema.TaggedErrorClass`, which effect removed in `4.0.0-beta.104` (renamed to
`Schema.TaggedError`). The peer dependency requirement moves accordingly:
`peerDependencies.effect` is now `>=4.0.0-beta.104` — a breaking change for consumers on
effect `<= 4.0.0-beta.103`, who should stay on `effect-jsonapi@0.7.x`.

`ApiError.make`'s runtime behavior and public types are unchanged; only the underlying effect
call site moved. A handful of other effect API renames landed in the same range and are adapted
here too: `HttpApiEndpoint.Any` → `HttpApiEndpoint.Top`, and the `HttpApiSchemaError` a
`SchemaErrors` middleware handles can now carry a `"ResponseHeaders"` kind (a server-side response
schema failure), which is now re-raised rather than mislabeled as a client 400.

Also: effect's `Schema` values (including this package's `Resource` definitions) are now callable
at runtime, so `Resource.Ref` and `Resource.isFamily` no longer rely on `typeof value === "function"`
/ `typeof value === "object"` to tell a resource from a lazy thunk — both public functions still
behave the same for callers.
