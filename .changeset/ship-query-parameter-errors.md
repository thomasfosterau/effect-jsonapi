---
"@thomasfosterau/effect-jsonapi": minor
---

Add the standard JSON:API query-parameter errors: `ApiError.UnsupportedIncludePath`, `ApiError.UnsupportedIncludeDepth`, `ApiError.UnsupportedSortField` and `ApiError.UnsupportedFieldsetMember` (grouped as `ApiError.QueryParameterErrors`), each carrying what the endpoint _does_ support in `meta` (`includablePaths`, `sortableFields`, `attributes`) so a rejection tells a client the legal set without a second request.

Also adds `Query.validateIncludePaths`, a runtime validator (depth checked before membership, matching the whole dotted path) for resolvers that walk a whitelist not fully expressible as `Query.Include`'s closed schema.

`UnsupportedSortField` and `UnsupportedFieldsetMember` are standalone declarations for now: `Query.schema`'s `sort` and `fields[TYPE]` codecs already validate against a closed, schema-build-time `Schema.Literals` set, so there's no dynamic "requested vs. supported" check point analogous to `include`'s (open-ended, resolver-validated) paths for them to be wired into yet.

None of the four set `source.parameter` — `ApiError.Config` has no way to declare a `source` yet (tracked separately); once it does, these four are the natural first adopters.
