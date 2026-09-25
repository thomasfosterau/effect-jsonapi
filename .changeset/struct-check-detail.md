---
"@thomasfosterau/effect-jsonapi": patch
---

`ServerErrors.schemaIssueToErrors` now uses a struct-level check's `message` annotation as the `detail` for each field the check points its failure at. Before, those fields' `detail` read `Expected a valid value`. For example, a `makeFilter(..., { message: "Passwords must match" })` on a struct that returns `{ path: ["confirm"], issue: new SchemaIssue.InvalidValue(undefined) }`, or an array of such issues, now gives `Passwords must match` at `/data/attributes/confirm`, which matches what Effect's own formatter renders. A pointed issue that carries its own `message` keeps it. `status`, `code`, `source.pointer` and the error count are unchanged.
