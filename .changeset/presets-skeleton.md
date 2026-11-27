---
"@thomasfosterau/effect-jsonapi": minor
---

Split the library into a configurable core and opt-in layers. `JsonApiConfig.strict` (the default) and `JsonApiConfig.lenient` are policy presets; the new `unknownQueryParameters` policy (`"reject"` by default, or `"ignore"`) lets a lenient api pass over query parameters outside the JSON:API families. The server skeleton (`Assemble`, `ResourceHandlers`, `Registry`, `FlatQuery`) is published at `@thomasfosterau/effect-jsonapi/skeleton`; its root re-exports are deprecated.
