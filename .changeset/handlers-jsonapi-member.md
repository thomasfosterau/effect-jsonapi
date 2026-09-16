---
"@thomasfosterau/effect-jsonapi": minor
---

**`Handlers.data` / `Handlers.collection` / `Handlers.linkage` accept a `jsonapi` option.**

`Handlers.DocumentValue` declared an optional top-level `jsonapi?: JsonApiObjectValue` member, but
no builder accepted or emitted it — the type promised a member the implementation could never
produce, so the only way to attach the top-level `jsonapi` object to a built document was a cast
(#103).

```ts
Handlers.data(article, { jsonapi: Document.v1_1, self: `/articles/${article.id}` })
Handlers.collection(items, { jsonapi: Document.v1_1, links, meta })
```

`data` / `collection` / `linkage` now each take a `jsonapi` option and stamp it onto the built
document, with the return type narrowing on whether the option was passed: `jsonapi` is present
(and required, not merely optional) when you pass one, and absent from the type entirely when you
don't — reading `.jsonapi` back off the result needs no cast in either direction. This follows the
same conditional-generic pattern the builders already use for `included` and `meta`, adding a
fourth type parameter (`J extends JsonApiObjectValue = never`) to `DocumentValue` — an additive
change to a type most callers only accept from a builder's return value, not one they parameterize
by hand.

**Not emitted by default.** A JSON:API 1.1 server arguably should advertise the version it
implements on every document, but defaulting it here would silently add a `jsonapi` member to
every response body every existing caller of `Handlers.data` / `Handlers.collection` /
`Handlers.linkage` already produces — a behavioural change riding along on a bug fix, not
something a type/implementation mismatch fix should decide on a consumer's behalf. Advertising the
version stays opt-in: pass `jsonapi: Document.v1_1` (or `Atomic.jsonapi` under the atomic-operations
extension) on the responses where you want it.
