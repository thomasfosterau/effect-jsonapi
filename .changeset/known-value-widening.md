---
"@thomasfosterau/effect-jsonapi": minor
---

Name the shapes a few constructors return, so the `effect/no-known-value-widening` lint rule is back at `error` (#436). These are new exported types; each one has the same structure as the inline type it replaces:

- `Atomic.RequestValue<Ops>` for `Atomic.request`.
- `Atomic.EmptyResult` for `Atomic.emptyResult`.
- `Atomic.ResultEntry<R, M>` for `Atomic.result`.
- `Atomic.ResultsValue<Entries>` for `Atomic.results`.
- `Client.Hydrated<R>` for `Client.hydrate`.

`Atomic.targetsResource`, `Atomic.targetsRelationship`, `Client.narrowIncluded`, `FlatQuery.pagination`, `Group.make` and `Handlers.project` are now overloaded function declarations rather than constants with an overloaded type. Their call signatures are unchanged.
