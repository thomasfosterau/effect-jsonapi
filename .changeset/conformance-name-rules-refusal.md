---
"@thomasfosterau/effect-jsonapi": patch
---

`Conformance`'s three query-parameter-name rules — `spec/query/unknown-query-parameter`, `spec/query/illegal-parameter-name` and `spec/query/unsupported-extension-parameter` — are now decided the way the other refusal rules are. Each sends a baseline request first and probes the first read endpoint that answers it with 2xx, so an endpoint that is down no longer decides the rule. A 400 whose `source.parameter` names only other parameters fails, because it refused something else; a 400 naming no `source.parameter` still passes, now with a note. A probe answered 429 or 408, or not at all, leaves the rule skipped as not decided instead of failing it. Each rule now sends two requests, not one.
