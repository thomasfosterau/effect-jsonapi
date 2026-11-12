---
"@thomasfosterau/effect-jsonapi": minor
---

**Breaking (types only):** the published `Schema.TaggedError` classes (`NotFound`, `Unauthorized`, `Forbidden`, `Redirect`, `HttpError`, `ValidationFailure`, `JsonapiError`, `UnknownFamily`, `FamilyMismatch`, `ErrorResponse`, `ContractViolation`, `DomainMismatch`, `InvalidAllowedQueryParameter`) carry a nominal brand, so a structurally compatible object literal is no longer assignable where one of these instances is expected. Instances built with `new`, and `_tag` / `instanceof` narrowing, are unaffected. Migration: construct the error with `new` (for example `new ServerErrors.NotFound({ … })`) instead of writing an object literal of its shape.
