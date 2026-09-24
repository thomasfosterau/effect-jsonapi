---
"@thomasfosterau/effect-jsonapi": patch
---

Fix a phantom `unknown` requirement on every `:id` endpoint of a generated client

The endpoint constructors that take an `:id` path parameter passed a bare field record as `params`, which left `HttpApiEndpoint`'s return type a deferred conditional. Declaration emit then serialised it with the conditional's true-branch narrowing baked in, as `Schema.Struct<Schema.Struct.Fields & { id: … }>`. That index signature admits `Schema.Top`, whose `DecodingServices` is `unknown`, so `get`, `update`, `delete`, `related`, `polymorphic` and the relationship methods on a client built with `HttpApiClient.make` each carried an `unknown` requirement that no layer could satisfy. Paramless endpoints (`list`, `create`, `collection`) were unaffected.

The bug was only visible through the published `.d.ts`; type-checking against the sources resolved the same call sites cleanly, which is why the existing type-level tests never caught it. Passing `Schema.Struct({ id: … })` resolves the conditional eagerly, so the emitted parameter type is now a concrete `Schema.Struct<{ id: … }>` with no index signature, and the requirements come out as `never`. The parameter stays required and branded; the runtime behaviour is unchanged (`HttpApiEndpoint` already accepted a schema instance here).

Consumers carrying a cast to launder the phantom requirement can drop it.
