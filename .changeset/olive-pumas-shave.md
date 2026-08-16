---
"@thomasfosterau/effect-jsonapi": minor
---

**`status` option on `Endpoint.create` / `Endpoint.update`.** `create` stamped `201` on its success
schema unconditionally — re-stamping even a caller-supplied `success` — and `WriteConfig` carried no
`status`, so an api whose creations answer `200` could not adopt the constructors without a wire
change. Both constructors now take an optional `status`, defaulting to today's `201` for `create` and
`200` for `update` whether or not `success` is given, and it is threaded through
`Endpoint.resource` / `Group.resource`'s per-endpoint `create` / `update` config. This is the
`status` `DeleteConfig` has carried since 0.9.0, on the write endpoints:

```ts
Endpoint.create(Article, { status: 200 })
Endpoint.update(Article, { status: 202 })

Group.resource(Article, { endpoints: { create: { status: 200 }, update: { status: 200 } } })
```

Only the status changes; path, params, request payload, success schema, errors and middleware are
untouched.
