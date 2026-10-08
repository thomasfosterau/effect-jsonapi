---
"@thomasfosterau/effect-jsonapi": patch
---

Docs: the full-linkage check's documentation now describes what it actually does. It is per reference — an `included` member passes when any resource in the document, primary or included (the member itself among them), references it — not reachability from the primary data, so `Handlers.resolveIncluded` and `Assemble.CollectionOptions` no longer say that stripping the primary data's `relationships` orphans the whole first level of `included`, or that a caller-resolved `included` member must be reachable from the primary data. `Handlers.buildIncluded` now says that `onResource` shapes only `included` and the check reads `primary` as passed, so a direct caller should pass `primary` as the document will emit it. No runtime change.
