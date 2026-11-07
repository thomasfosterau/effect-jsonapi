---
"@thomasfosterau/effect-jsonapi": minor
---

The error funnel can be overridden, and an empty `meta` is left out (#565).

- **New `ServerErrors.RespondOptions.override`.** These are mapping arms `ServerErrors.respond` consults **before** `fromTaggedError`, so an application can render a cause the package already maps (an `ApiError.Conflict` in its own wording, say) its own way. `none` hands the cause on to `fromTaggedError` and then to `materialise`, which are unchanged.
- **An `ApiError.make` error whose fields are all optional and absent no longer carries `meta: {}`.** `new ApiError.Conflict({})` now encodes as `{ status: "409", code: "conflict", title: "Conflict" }`, and likewise for `BadRequest`. Decoding is unchanged: a document without `meta` already decoded.
