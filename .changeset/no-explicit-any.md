---
"@thomasfosterau/effect-jsonapi": minor
---

**Breaking (types):** the published declarations no longer spell `any` (#533, #536). Almost every site widens to the same set of accepted values (`unknown`, a constrained generic or `never` in a parameter position), so call sites compile unchanged; the ones a consumer can notice are in `Registry`:

- `Registry.RawHandler<R>` takes `request: never` (was `any`) and `R` defaults to `unknown` (was `any`); `Registry.Family<R>` defaults to `unknown` too. A host that called a handler out of `family.handlers` directly, or annotated `Registry.Family` bare and then passed it to `webHandler`, now supplies a typed request and `Context` itself. Migration: annotate `Registry.Family<YourServices>`, and type the request you hand a raw handler.
- `Registry.HandlersFor<G>` types a handler's error and requirement channels as `unknown` (was `any`). Declarations written with `satisfies Registry.FamilyFor<typeof group>` are unaffected: the `ResourceHandlers` constructors (`make`, `readOnly`) return `NoInfer<…>` so the requirement channel is not inferred from that contextual type.
- `Registry.familyLayer`, `Registry.layer` and `Registry.webHandler` are generic over the api's identifier and groups (`HttpApi.HttpApi<ApiId, Groups>`) rather than taking `HttpApi.HttpApi<any, any>`. Any concrete `HttpApi` still passes; a caller that held its api as `HttpApi<any, any>` should pass the concrete value.

- `Client.decodeInput` constrains `S` to `Schema.Codec<unknown, unknown, unknown, unknown>` (was `Schema.Top`), so the schema is decoded without an internal assertion. A value typed only as `Schema.Top` must be narrowed to a codec first.
- `Resource.createAttributeFields` and `Resource.updateAttributeFields` return `CreateAttributes<A>` / `UpdateAttributes<A>` (was `Record<string, Schema.Top>`); `Resource.attributeKeys`, `relationshipKeys`, `sortable`, `annotate`, `Include.paths`, `Document.wire`, `Document.LinkageDocument`, `Atomic.Operations`, `Assemble.toWireSafeResource` and `Query.bracketPageKeys` are now overloaded function declarations with the same call signature.

Also widened without a consumer-visible effect: the `Schema.Codec<any, string>` id-schema bound (now `Schema.Codec<unknown, string>`) across `Resource`, `Endpoint` and `Group`; `Handlers.IncludeTargets` loaders (`IncludeTarget<ResourceValue, unknown, unknown>`); the `Resource.Family` bound of the include-path helpers; and `Query.bracketKeys`'s input constraint. `Resource.extend`, `Resource.annotate`, `Resource.family` and `ApiError.make` no longer round-trip through `as unknown as` internally; their signatures are unchanged.
