---
"@thomasfosterau/effect-jsonapi": patch
---

Take the pure Schema helpers from `@thomasfosterau/effect-ext` (#552) instead of keeping local copies. This adds the package's first runtime dependency, `@thomasfosterau/effect-ext` `^0.1.0`. Only its `Bounded`, `Ids`, `Issues` and `TriState` subpaths are imported, and they import only `effect`'s core.

`FlatQuery`'s `PageOffset`, `pageLimit`, `pagination`, `Uuid`, `idList`, `IdList`, `DEFAULT_MAX_ID_LIST`, `SLUG_PATTERN`, `slug`, `Slug` and `suppliedValue`, and `ServerErrors.pathToJsonPointer`, now delegate to effect-ext. Their names, option objects and declared types stay the same, and so do their decoded values, error messages and JSON Schema. No declaration names effect-ext. The `/schema` entry point and the schema-tier subpaths still never reach `effect/http` or `effect/http-api`; they now also resolve those effect-ext subpaths.

`ServerErrors.schemaIssueToErrors` keeps its own issue walk, because effect-ext's `Issues.pointers` formats a struct-level check's `message` differently.
