---
"@thomasfosterau/effect-jsonapi": minor
---

**Repeated `?include=` keys, and a `query` override on `Endpoint.get`.** Two halves of the same gap
on the read path.

`Query.schema` declared `include`'s wire form as `Schema.optionalKey(Schema.String)`, so the
repeated-key spelling — `?include=a&include=b`, which `UrlParams.toRecord` decodes to an **array** —
failed to decode and answered 400, where the comma form `?include=a,b` denoting the same set answered 200. Both spellings are now accepted and decode identically; encoding still emits the single comma
form, so nothing a client is handed changes shape, and an unknown or unlisted path is still the 400
it was in either spelling. No opt-in: this is a widening of the parameter the package composes.

`Endpoint.get` also gains the `query` override `Endpoint.list` has carried since 0.9.0 — any
`Schema.Top`, defaulting to today's `include` / `fields` composition, with those options ignored once
it is given — threaded through `Endpoint.resource` / `Group.resource`'s per-endpoint `get` config,
and `GetConfig` gains the matching `query` field:

```ts
Endpoint.get(Article, {
  query: Schema.Struct({
    include: Schema.optionalKey(Schema.String),
    includeDeleted: Schema.optionalKey(Schema.Literals(["true", "false"]))
  })
})

Group.resource(Article, { endpoints: { get: { query: GetArticle } } })
```

Only the query changes; the `:id` path param, success document, errors and middleware are untouched.
`Endpoint.get`'s type parameter list gains `QuerySchema` before `Success`, mirroring `list` — visible
only to code that instantiates `typeof Endpoint.get<…>` explicitly, never to a normal call site.
