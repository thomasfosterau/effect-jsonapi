---
"@thomasfosterau/effect-jsonapi": patch
---

Give the published `Schema.TaggedError` classes (`NotFound`, `Unauthorized`, `Forbidden`, `Redirect`, `HttpError`, `ValidationFailure`, `JsonapiError`, `UnknownFamily`, `FamilyMismatch`, `ErrorResponse`, `ContractViolation`, `DomainMismatch`, `InvalidAllowedQueryParameter`) a nominal brand, so a structurally compatible object is no longer assignable where one of these instances is expected. Instances built with `new` are unaffected.
