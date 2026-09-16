---
"@thomasfosterau/effect-jsonapi": minor
---

**The client surface: content negotiation and error-document decoding, which every consumer was
hand-rolling.** `Client.ts` contained exactly one thing — `narrowIncluded` — and left a JSON:API
client the two pieces without which a generated `HttpApiClient` cannot talk to this package's own
server.

**Negotiation.** `HttpApiClient.make` sends `Accept: application/json` and
`Content-Type: application/json`, which `Middleware.ContentNegotiationLive` refuses. Now:

- `Client.make(api, options?)` — `HttpApiClient.make` with the negotiation transform pre-applied,
  plus the `ext` / `profile` parameters to advertise. A `transformClient` of your own still runs, and
  runs after ours, so it can override a header if it means to.
- `Client.transform(client, options?)` — the `HttpClient` transform on its own.
- `Client.jsonApiHeaders(request, options?)` — the per-request function: `Accept` on every request,
  `Content-Type` on the mutating ones, body bytes untouched.
- `Client.isMutatingMethod(method)` — the POST/PUT/PATCH/DELETE predicate, public because it is a
  correctness detail rather than sugar. `DELETE` is in the list: a JSON:API `DELETE` may carry a body
  and a bodyless one still declares what it would send, and a client, a façade and a server that
  disagree about which requests are mutating disagree about which requests negotiate.

The media type with its parameters is now built in one place, shared by the client that emits it and
the middleware that parses it, so the two cannot drift.

**Error documents.**

- `Document.decodeErrorDocument(body)` — best-effort decode of any body into a JSON:API error
  document, returning `Option` and **never throwing**. A network fault's empty body, an opaque 5xx,
  an HTML page from a proxy, a truncated response: all `None`.
- `Document.errorMessage(document)` — the first error's `detail`, else `title`, else a fallback.
- `Client.errorDocument(cause)` — the same, recovered from a failed call's `HttpClientError`, as an
  `Effect` that never fails.

The decoding pair lives in `Document`, not `Client`, so it is reachable with `effect` as its only
peer: a façade that synthesises a failure locally from a replica never has an `HttpClientError`, and
should not need the HTTP surface to render one the same way the network does. `Client` moves to the
HTTP tier accordingly — see `PUBLISHING.md`.

`examples/blog/client.ts` is the worked example: a generated client negotiating through the blog
server's own middleware in memory, and a 404 round-tripping back as a decoded error document.
