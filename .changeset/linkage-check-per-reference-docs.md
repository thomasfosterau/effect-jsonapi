---
"@thomasfosterau/effect-jsonapi": patch
---

Docs: `Handlers.buildIncluded` now says that `onResource` shapes only `included` and that the full-linkage check reads `primary` as passed, so a direct caller should pass `primary` as the document will emit it. No runtime change.
