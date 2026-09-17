---
"@thomasfosterau/effect-jsonapi": patch
---

Fixed `Middleware.acceptIsAcceptable` and `Middleware.contentTypeIsAcceptable` (and the
`Middleware.negotiate` predicate they back) incorrectly treating an `Accept` entry's `q` weight as a
media type parameter. Per RFC 9110 §12.4.2, `q` terminates a media type's parameter list — it and
anything after it are accept-extension parameters, not subject to JSON:API §5's ext/profile
whitelist. Previously `application/vnd.api+json;q=0.9` was rejected outright, and a low-weighted
JSON:API entry alongside a higher-weighted non-JSON:API one (e.g.
`text/html;q=0.9, application/vnd.api+json;q=0.8`) produced a spurious 406. An entry weighted
`q=0` is now correctly treated as an explicit refusal rather than a malformed parameter.
