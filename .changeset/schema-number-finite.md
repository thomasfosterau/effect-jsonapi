---
"@thomasfosterau/effect-jsonapi": minor
---

**Breaking:** the schemas this package publishes no longer use `Schema.Number`, which accepts `NaN`, `Infinity` and `-Infinity`. Each is now `Schema.Finite` or, where the value is a count, status or index, `Schema.Int` (both also reject the non-finite values). Decoding or constructing a value with `NaN` or an infinity now fails with a schema error, and the emitted declarations name `Schema.Finite` / `Schema.Int` where they named `Schema.Number`. The accepted values narrowed for:

- `Query.Page.offset(...)` and `Query.Page.number(...)` with `fromString: false`: the `offset`, `limit`, `number` and `size` leaves build on `Schema.Finite` instead of `Schema.Number` (they were already integer-checked and bounded). The default `fromString: true` path already decoded through `FiniteFromString`, so the wire strings `NaN`, `Infinity` and `-Infinity` were already refused and the error messages for wire input are unchanged.
- `FlatQuery.PageOffset`, `FlatQuery.pageLimit(...)`, `FlatQuery.pagination(...)` and the `DefaultedPagination` / `RequiredPagination` types: now typed `Schema.Finite` (the runtime schemas from `effect-ext`'s `Bounded` already were).
- `ServerErrors.Redirect.status`, `ServerErrors.HttpError.status` and `ServerErrors.JsonapiError.status`: now `Schema.Int`, so a fractional status is refused too.
- `ServerErrors.ValidationFailure` issue `path` segments given as numbers: now `Schema.Int` (array indices).
- `ApiError.UnsupportedIncludeDepth` `maxDepth` field: now `Schema.Int`.
- `Client.ErrorResponse.status`: now `Schema.Int`.
- `Conformance.ContractViolation.remaining`: now `Schema.Int`.

Migration: a handler or client that builds one of these errors or a `fromString: false` page query from a computed number must pass a finite value (an integer for the `Schema.Int` fields); `Number.isFinite` or `Math.trunc` at the boundary is enough. Code that annotated these schemas as `Schema.Number` (for example `const page: Schema.Number = FlatQuery.PageOffset`) should say `Schema.Finite`. Attribute and meta schemas you declare yourself are unaffected; consider `Schema.Finite` over `Schema.Number` there as well.
