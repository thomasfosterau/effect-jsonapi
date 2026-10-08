---
"@thomasfosterau/effect-jsonapi": patch
---

The query-parameter errors now set JSON:API `source.parameter` on their error object: `ApiError.UnsupportedIncludePath` and `ApiError.UnsupportedIncludeDepth` name `include`, `ApiError.UnsupportedSortField` names `sort`, and `ApiError.UnsupportedFieldsetMember` names `fields[TYPE]` for the rejected type — matching the 400 the schema-error middleware renders for the same rejection at decode time.
