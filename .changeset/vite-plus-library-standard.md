---
"@thomasfosterau/effect-jsonapi": patch
---

Migrate the toolchain to the Vite+ library standard.

For consumers the package is the same API, built differently:

- `dist/` is now emitted by `vp pack` (tsdown) — one ESM bundle per entry point (`.` and `./schema`) plus bundled declarations — instead of one file per module from `tsc`. The `exports` map and the two entry points are unchanged; the schema-only entry point still resolves `effect` and nothing else.
- The sources compile under `exactOptionalPropertyTypes`. Every optional option a caller may pass an explicit `undefined` for (`Query.Options`, `Document.*`'s `included` / `meta` / `error`, `Handlers.data` / `collection` / `buildIncluded`'s `included` / `checkLinkage` / `onResource`, `Resource.make` / `extend`'s `id`, `attribute`'s `filterLiteral`) is now spelled `?: T | undefined`, so a consumer on that flag can forward its own optional values without a cast.
- The published manifest declares its `effect` peer through pnpm's `catalogs.peers` (the floor itself is covered by this release's peer-floor entries) and is published with `pnpm publish` under npm OIDC trusted publishing.
- `engines.node` is now `>=22`.
