---
"@thomasfosterau/effect-jsonapi": minor
---

Add `Query.Page.offset` (bounded, defaulted, optional plain-number) factory.

`Query.Page.offset(options?)` returns the same `{ offset, limit }` field-map as the constant `Query.Page.Offset`, but configurable:

- **Bounded** — `maxLimit` caps `limit` (a DoS guard); `minLimit` (default 1) floors it.
- **Defaulted** — `defaultLimit` / `defaultOffset` fill in concrete values on decode when the wire key is absent; omit one to leave that field optional.
- **Coercion-flexible** — `fromString: false` builds the fields from plain `Schema.Number` (encoded = number) instead of `FiniteFromString` (encoded = string), so the same schema works both as a numeric call-site input and behind a transport that coerces query strings (raw `HttpApiEndpoint` wrapped in `Schema.toCodecStringTree`).

A page-number twin, `Query.Page.number(options?)`, applies the same bounds/defaults to the `size` field (1-based `number`). The existing `Page.Offset` / `Page.Number` / `Page.Cursor` constants are unchanged.

```ts
Endpoint.list(Article, { page: Query.Page.offset({ maxLimit: 100, defaultLimit: 25 }) })
```
