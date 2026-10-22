---
"@thomasfosterau/effect-jsonapi": patch
---

The full-linkage walk now starts from a relationship document's primary identifiers as well as from relationship linkage: an `included` member reached only through one (`GET /articles/1/relationships/comments?include=comments`) is linked. Both the conformance kit's `spec/document/full-linkage` rule and the endpoint middleware's post-encode check stop reporting such members (#423).
