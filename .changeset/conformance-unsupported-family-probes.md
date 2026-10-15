---
"@thomasfosterau/effect-jsonapi": minor
---

`Conformance` gains seven spec-tier rules that send an endpoint a parameter of a family JSON:API defines that the endpoint does not declare, so the kit now guards the 400 `Middleware.SchemaErrors` answers there. Each rests on JSON:API 1.1 §Implementation-Specific Query Parameters: "If a server encounters a query parameter that does not follow the naming conventions above, or the server does not know how to process it as a query parameter from this specification, it **MUST** return `400 Bad Request`."

- `spec/query/fields-unsupported-endpoint` sends `fields[TYPE]` for a type the endpoint's response shows but its query does not declare (ignoring it would also break §Sparse Fieldsets' **MUST NOT**).
- `spec/query/page-unsupported-endpoint` and `spec/query/filter-unsupported-endpoint` send `page[limit]` / `filter[…]` to an endpoint that declares neither family.
- `spec/query/page-undeclared-member` and `spec/query/filter-undeclared-member` send a member derived from a declared one (`page[offset_x]`, `filter[status_x]`) to an endpoint that declares its members by name; an open `filter[…]` grammar is not probed.
- `spec/query/include-bracketed` and `spec/query/sort-bracketed` send `include[]` / `sort[]` to an endpoint that supports the bare parameter.

Each probes only an endpoint whose baseline request answered 2xx, never a name the endpoint declares, and sends at most 20 requests. A status other than 400, a server error included (a server that answers 5xx to a parameter it does not support mishandled it), or a 400 whose `source.parameter` names only other parameters, fails the rule; a probe answered by a rate limit (`429`), a request timeout (`408`) or nothing at all says nothing of whether the server refuses the parameter, and leaves it not decided. A server that silently ignored any of these parameters, and passed every rule before, now fails one.

The two existing refusal rules, `spec/query/include-unsupported-endpoint` and `spec/query/sort-unsupported-endpoint`, now share that driver and its cap: each sends at most 20 requests, redirects included, and skips, naming the endpoints it left untried, where it used to try a baseline on every candidate endpoint until one answered 2xx. They settle a probe's answer as the seven do.
