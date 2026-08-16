---
"@thomasfosterau/effect-jsonapi": minor
---

**`payloadMediaType` option on `Endpoint.create` / `Endpoint.update`.** Both constructors wrapped
their `payload` — the override included — in the JSON:API media type, so the router's _request_
registration was always `application/vnd.api+json` with no way out. Effect's router answers 415 on a
mismatched request `Content-Type`, so a host that enforces §6 at its own seam and then dispatches
writes to the router relabelled `application/json` had every package-built write rejected before a
handler saw it.

Both now take an optional `payloadMediaType`, defaulting to today's `application/vnd.api+json`, and
it is threaded through `Endpoint.resource` / `Group.resource`'s per-endpoint `create` / `update`
config:

```ts
Endpoint.create(Article, { payload: Article.createInput, payloadMediaType: "application/json" })

Group.resource(Article, {
  endpoints: { create: { payloadMediaType: "application/json" } }
})
```

Only the request registration moves: the payload schema, the response media type, path, params,
errors and middleware are untouched. Pair it with `Middleware.layerHostNegotiated` — the counterpart
for the negotiation half — so the package's own §5 check doesn't reject what the host admitted.
