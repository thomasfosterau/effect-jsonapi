---
"@thomasfosterau/effect-jsonapi": minor
---

Add `capabilitiesOnIncluded` to `Assemble.Options` (and `Assemble.RelationshipInput`, and the `ResourceHandlers` read-only, writable and related configs): `false` stamps the `capabilities` hook's result on primary data only, leaving `included` members without capability `meta`. It defaults to `true`, today's behaviour, so existing callers are unchanged. From gardeneria#1263 O5.
