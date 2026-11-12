---
"@thomasfosterau/effect-jsonapi": minor
---

The error funnel can be overridden, and an `ApiError.make` error no longer repeats its `detail` in `meta` (#565).

- **New `ServerErrors.RespondOptions.override`.** These are mapping arms `ServerErrors.respond` consults **before** `fromTaggedError`, so an application can render a cause the package already maps (an `ApiError.Conflict` in its own wording, say) its own way. `none` hands the cause on to `fromTaggedError` and then to `materialise`, which are unchanged.
- **Breaking wire change: a `detail` field is encoded only as the error object's top-level `detail`, never also as `meta.detail`.** `new ApiError.Conflict({ detail: "id mismatch" })` now encodes as `{ status: "409", code: "conflict", title: "Conflict", detail: "id mismatch" }`, and every `BadRequest` the `SchemaErrors` middleware answers loses its `meta: { detail: "Request query failed validation" }` the same way. Other fields still go to `meta`.
- **No empty `meta`.** An `ApiError.make` error whose fields are all optional and absent (or only the `detail` field) no longer carries `meta: {}`: `new ApiError.Conflict({})` encodes as `{ status: "409", code: "conflict", title: "Conflict" }`.
- Decoding is unchanged: a `detail` field already falls back to the error object's `detail`, so typed clients and the round trip are unaffected.

**Migration** (website, gardeneria, preferenceflow, in-the-dark, and any other consumer): code that reads `errors[].meta.detail` reads `errors[].detail` instead, and tests that match an error body exactly drop `meta.detail` (and `meta: {}`) from the expected body.
