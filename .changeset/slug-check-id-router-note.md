---
"@thomasfosterau/effect-jsonapi": patch
---

Correct the 0.16.0 notes on two rc.118 consequences, and tighten the `/schema` entry-point guards. No runtime change.

- `FlatQuery.slug`'s length check is now `Schema.isBetweenLength`, so its runtime annotation `ast.checks[0].annotations.representation.id` reads `effect/schema/isBetweenLength` where it read `effect/schema/isLengthBetween`. This reaches beyond stored `SchemaRepresentation` documents (regenerate those): any consumer keying on `annotations.representation.id`, such as effect-forms' `constraintsFromSchema`, which maps the old id to HTML `minlength` / `maxlength`, must update, or slug fields silently lose those attributes. Accepted values and messages are unchanged.
- Effect rc.118 builds a fresh `HttpRouter` per entrypoint, so routes added to a router you provided yourself are not served. Serve `Registry.layer` / `HttpApiBuilder.layer` through `HttpRouter.serve` or `HttpRouter.toWebHandler`, not through a self-provided `HttpRouter.layer`. The README server snippet now shows this.
