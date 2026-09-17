---
"@thomasfosterau/effect-jsonapi": minor
---

Add a client-side surface to `Client`: content negotiation and best-effort error-document decoding.

A client derived by `HttpApiClient.make` sends no `Accept` header, and no `Content-Type` on a
bodyless mutation such as `DELETE` — so it does not meet JSON:API's client responsibilities, and a
host serving HTML and JSON:API on one origin has nothing to select on. Turning a failed call into
the error document it carries was left to the consumer too. Both are now the package's.

**Negotiation**

- `Client.make(api, options)` — `HttpApiClient.make` with the JSON:API request transform
  pre-applied. The common case needs no `transformClient`, and an api using extensions takes the
  same `extensions` value as the server's `Middleware.layerWith`.
- `Client.transform` / `Client.transformWith(options)` — the same transform over an existing
  `HttpClient`, for a custom transport or `HttpApiClient.makeWith`.
- `Client.jsonApiHeaders` / `Client.jsonApiHeadersWith(options)` — the transform over one request:
  `Accept` on every request, `Content-Type` on every mutating one. Only the label changes: the body
  bytes are untouched, and a request that already declares a genuinely different representation
  (`multipart/form-data`) keeps its `Content-Type`.
- `Client.isMutatingMethod(method)` — the `POST` / `PATCH` / `PUT` / `DELETE` predicate, exported
  because it is a correctness detail rather than sugar: a bodyless `DELETE` still carries the label,
  and a façade and a server that both call this cannot disagree about which requests do.
- `Client.mediaType(options)` — the media type with its `ext` parameter, built from the same
  definition the server's response annotations and §5 parser use, so client and server cannot drift.

**Error documents**

- `Client.decodeErrorDocument(body)` — a supported entry point, not an implementation detail: it
  takes a body rather than a response, so a façade that synthesises responses locally and never
  holds an `HttpClientError` decodes through the same seam as the network transport. Genuinely
  best-effort — HTML from a proxy, a truncated payload, an opaque 502, an empty body all yield
  `Option.none()` rather than throwing a second error inside the error path.
- `Client.errorDocument(cause)` — the same decode reached from a failed call's `HttpClientError`.
  Never fails, never throws.
- `Client.errorMessage(document)` / `Client.DEFAULT_ERROR_MESSAGE` — the first `detail`, else
  `title`, else a constant.
- `Client.ErrorDocument` — the decoded document type.

**`Client` moves to the HTTP tier**

`Client.make` and the negotiation transform reach `HttpApiClient` and `HttpClient`, so `Client` now
resolves `effect/unstable/httpapi` and is no longer re-exported from the schema-only
`@thomasfosterau/effect-jsonapi/schema` entry point. It is unchanged on the package root. The two
members that would still fit that tier — `narrowIncluded`, a type-level operation with no runtime,
and `decodeErrorDocument`, which decodes through `Document`'s error schemas alone — go with it,
because a namespace exported from both entry points has to be the same module object.

A worked client is included as `examples/blog/client.ts`, round-tripping documents and errors
against the blog example server.
