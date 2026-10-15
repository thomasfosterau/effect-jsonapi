---
"@thomasfosterau/effect-jsonapi": patch
---

`Conformance` gains seven spec-tier rules that send an endpoint a parameter of a family JSON:API defines that the endpoint does not declare, so the kit now guards the 400 `Middleware.SchemaErrors` answers there. Each rests on JSON:API 1.1 §Implementation-Specific Query Parameters: "If a server encounters a query parameter that does not follow the naming conventions above, or the server does not know how to process it as a query parameter from this specification, it **MUST** return `400 Bad Request`."

- `spec/query/fields-unsupported-endpoint` sends `fields[TYPE]` for a type the endpoint's response shows but its query does not declare (ignoring it would also break §Sparse Fieldsets' **MUST NOT**).
- `spec/query/page-unsupported-endpoint` and `spec/query/filter-unsupported-endpoint` send `page[limit]` / `filter[…]` to an endpoint that declares neither family.
- `spec/query/page-undeclared-member` and `spec/query/filter-undeclared-member` send a member derived from a declared one (`page[offset_x]`, `filter[status_x]`) to an endpoint that declares its members by name; an open `filter[…]` grammar is not probed.
- `spec/query/include-bracketed` and `spec/query/sort-bracketed` send `include[]` / `sort[]` to an endpoint that supports the bare parameter.

Each probes only an endpoint whose baseline request answered 2xx, never a name the endpoint declares, and sends at most 20 requests. A status other than 400, or a 400 whose `source.parameter` names only other parameters, fails the rule; a probe answered by a server error, a rate limit, a request timeout or nothing at all leaves it not decided. A server that silently ignored any of these parameters, and passed every rule before, now fails one.
