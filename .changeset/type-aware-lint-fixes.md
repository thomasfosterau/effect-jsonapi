---
"@thomasfosterau/effect-jsonapi": patch
---

Drop a redundant `| undefined` from two optional parameters in the shipped internal declarations (`mediaTypeWith`, `unlinkedIncluded`); the types are unchanged. Found by the newly enabled type-aware lint.
