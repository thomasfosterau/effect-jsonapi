---
"@thomasfosterau/effect-jsonapi": patch
---

Docs: `Handlers.resolveIncluded` no longer claims the builders' full-linkage check is merely a guard on any document it feeds. The guarantee is scoped to the array the resolver returns, and the doc names what voids it — an `onResource` transform that removes or rewrites `relationships`, an edited array, or different primary data. The `checkLinkage` option on `Handlers.data`, `Handlers.collection` and `Handlers.buildIncluded` now says that a resolver-built document is not on its own a reason to turn the check off. No runtime change.
