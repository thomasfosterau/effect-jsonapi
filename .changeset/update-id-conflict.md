---
"@thomasfosterau/effect-jsonapi": minor
---

`Endpoint.update` answers a `data.id` that differs from the `:id` path parameter with 409 Conflict naming `/data/id`, before the handler runs, as JSON:API 1.1 §9.2.5 requires; a mismatched `data.type` already answered 409. The two are compared as wire strings. An update with a `payload` override (`updateInput`) keeps the id check in the handler. The conformance kit gains `spec/status/update-conflict-type` and `spec/status/update-conflict-id`.
