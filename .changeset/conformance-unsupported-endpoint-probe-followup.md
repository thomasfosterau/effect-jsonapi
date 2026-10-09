---
"@thomasfosterau/effect-jsonapi": patch
---

`Conformance`'s `spec/query/include-unsupported-endpoint` and `spec/query/sort-unsupported-endpoint` rules no longer report a false failure against a hand-built endpoint whose query is not a plain struct. Discovery read only a struct's own keys, so a query declared as a `Schema.Union`, a `Schema.suspend` or a `Schema.Record` looked as though it declared nothing, and the rules probed an endpoint that does accept the parameter. Discovery now reads a query by the walk `Middleware.SchemaErrors` checks requests against: a union declares what any member declares, a suspended schema what its target declares, and an endpoint whose query names cannot be enumerated (a record keyed by any string, which the middleware stands aside for) is never probed; when that leaves nothing to probe, the skip reason names it.

The include rule now probes only an endpoint whose baseline request answered 2xx, moving on to the next candidate otherwise; when no baseline succeeds, either rule skips naming each endpoint's observed status. A probe that got no response is reported as such instead of as "was not rejected", and a 400 carrying no JSON:API error objects passes with a note that says so rather than one about `source.parameter`.
