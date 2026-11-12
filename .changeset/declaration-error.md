---
"@thomasfosterau/effect-jsonapi": patch
---

The declaration helpers' construction-time errors are now tagged. An invalid resource, attribute, relationship, include path, filter or `Query.schema` option still throws synchronously with the same message, but the thrown value is an internal `DeclarationError` (a `Schema.TaggedError`, so `instanceof Error` still holds) with `name` and `_tag` `"DeclarationError"`, instead of a bare `Error`. `Handlers` and `ApiError.toDocument` misuse errors and `Endpoint.getRelationship`'s unknown-relationship error are tagged the same way. No class is exported; match on `message` as before.
