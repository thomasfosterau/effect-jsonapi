---
"@thomasfosterau/effect-jsonapi": minor
---

**Breaking:** `ApiError.toDocument` takes an `ApiError.Any` instead of any `object` (#436).

`ApiError.Any` is the type of every `ApiError.make` error instance: a yieldable tagged error carrying the new `ApiError.TypeId` brand, which every `make` class now puts on its prototype. The new `ApiError.isApiError(value)` guard recognises the brand, so a framework hook that caught an arbitrary value narrows it before rendering it.

**Migration:** a call that passes an `ApiError.make` instance compiles unchanged. A call that passes a wider value (`unknown`, `object`, `Error`) narrows it first:

```ts skip-type-checking
// before
const body = ApiError.toDocument(caught);
// after
if (ApiError.isApiError(caught)) {
  const body = ApiError.toDocument(caught);
}
```

`toDocument` still throws at runtime on a value that carries the brand without a `wire` schema.
