---
"@thomasfosterau/effect-jsonapi": minor
---

A flat group's include surface now types its documents end to end (#595).

- **`Group.flat` / `Group.flatReadOnly` keep the surface's `included` union in their success schemas.** It used to be inferred while the surface type was still generic, which widened it to `Schema.Top`: every endpoint's decoding services became `unknown`, so a typed `Client.make` method required `unknown`, and `effect/cli` commands built on one failed to type-check. A flat group without a surface is unchanged.
- **`Assemble` and `ResourceHandlers` type `included` by the include registry.** `Assemble.ResourceDocument`, `CollectionDocument` and `UnpaginatedCollectionDocument` gain a trailing `I` parameter, the `included` members' type, defaulting to `ResourceLike`. `Assemble.resource` / `collection` / `unpaginatedCollection` set it from their `targets` through the new `Assemble.TargetsIncluded<Targets>`: what the loaders return, or `never` with no registry. `ResourceHandlers.readOnly` / `make` handlers get the same type, with writes typed `never`. A family's handlers then satisfy a group whose `included` is the surface's precise union, with no cast. Declare the registry with `satisfies Handlers.IncludeTargets` so the loaders' types stay visible; an annotated registry keeps the loose `ResourceLike`.
- **Migration:** drop any `Schema.Codec<…, never, never>` cast around a flat group's documents, and any cast on handler output. Code that names a document's exact type from a call with no registry sees `included?: ReadonlyArray<never>` instead of `ReadonlyArray<WireResource<ResourceLike>>`, which is still assignable to the old type.
