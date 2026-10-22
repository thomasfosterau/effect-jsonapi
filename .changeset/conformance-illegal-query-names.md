---
"@thomasfosterau/effect-jsonapi": minor
---

`Conformance` gains two query-parameter rules, `spec/query/illegal-parameter-name` (`?foo!=1`, a base name that is not a legal member name) and `spec/query/unsupported-extension-parameter` (`?unsupported:param=1`, a parameter of an extension the server does not support). Each sends the first read endpoint the one parameter and expects `400 Bad Request` under JSON:API 1.1 §Implementation-Specific Query Parameters, guarding the 400 `Middleware.checkQueryParameters` gives both since #263 (#425).
