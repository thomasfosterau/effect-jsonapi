---
"@thomasfosterau/effect-jsonapi": patch
---

Struct-level checks render the same way under every `effect` 4.x (#530). The development pin moves to `effect` 4.1.2; the `effect` peer range stays `^4.0.0`.

- **`Middleware.schemaErrorDocument` / the `SchemaErrors` middleware:** a check on a request part's struct that names a `message` of its own and points its failure at a property is now a 400 naming that property's wire parameter in `source.parameter`, with the check's message as `detail` (for example `source: { parameter: "page[size]" }, detail: "not nine"`). Before, it was reported whole as the generic `Request query failed validation`. This follows effect 4.1's formatter, which carries a check's message down to the property it points to, and it now holds under effect 4.0.x as well. A check that rejects the whole value is unchanged.
- **`ServerErrors.schemaIssueToErrors`:** the `detail` of a struct-level check that points at a field is the check's message alone. Under effect 4.1 it would otherwise end with the path (`Passwords must match\n  at ["confirm"]`), which the error already carries as `source.pointer`.
