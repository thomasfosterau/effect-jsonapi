---
"@thomasfosterau/effect-jsonapi": minor
---

**Behaviour change: a client that sends extra fields, meaning `attributes` or `relationships` members a resource doesn't declare, now gets a 400 where it used to get a 2xx, on every resource.** Before, a member that declares at least one field silently dropped the extras. A member that declares none rejects them already, as the other changeset in this release describes. Both now answer the same way.

Each undeclared member is its own 400 error, with `detail` `Expected no excess property` and a `source.pointer` at that member (`/data/attributes/<name>`, `/atomic:operations/<n>/data/relationships/<name>`). An own `__proto__` or `constructor` member is rejected like any other name. This applies to `createPayload`, `updatePayload`, the atomic `add` / `update` operations, and the flat `createInput` and `updateInput`, where the pointer is `/<name>`. `updateInput` was not covered before. It also covers a member excluded from that write (`create: false`, `update: false`, `paginated`). A client that sends a stale or read-only attribute, such as a server-set timestamp, now gets this 400 too. The members JSON:API allows around them are still accepted: a document's `meta`, `jsonapi` and `links`, a resource object's `meta` and `links`, a relationship's `meta` and `links`, a resource identifier's `meta`, and an operation's `meta`.

Encoding through these schemas, which is what `Client` does with a write body, now fails the same way for a value with an undeclared member, before any request is sent.

The schemas are still `Schema.Struct`s. `.fields`, including `createInput.fields`, and the inferred types are unchanged. The generated OpenAPI document is byte-identical: it already described each member with its properties and `additionalProperties: false`. A struct derived from one with `mapFields` is a plain `Schema.Struct` again, which drops undeclared members.
