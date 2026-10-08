---
"@thomasfosterau/effect-jsonapi": patch
---

`Conformance`'s write rules now act only on the id a create response names after checking it. The response must name a resource of the type the fixture's `create` returned (`data.type`, or `atomic:results[0].data.type` for an atomic `add`), under an id that is neither an `ids` sample nor one the run already holds a resource for that has not been removed. Any other id is recorded in `Report.writes` as `left`, with `id: undefined` and a `detail` naming what the response named, and is never PATCHed, DELETEd or passed to `cleanup`; the update and delete rules skip on it. Before, a server that answered `POST /articles` with `{ "data": { "type": "people", "id": "1" } }` had the kit send `DELETE /articles/1` — the `ids` sample — and call `cleanup("1")`.

`spec/status/update-response` now passes a 200 whose document has no primary data, which JSON:API 1.1 allows when the server changed nothing beyond the request; a 200 still fails when it carries no document, or carries `data` that is not the updated resource.

`spec/content-negotiation/request-content-type-parameters` now sends `{}` — a body nothing can apply — and to the create endpoint first, since it runs without `mutating: true`; it sent a resource object, which a server that ignores the media type could have applied. With the write-fixture change's fix that sends a probe's body under the probe's own `Content-Type` (it was `application/json`), this rule and `spec/atomic/malformed-operations-rejected` may reach a different verdict against a third-party server than in 0.16: each now sends the media type its report always said it did.

`spec/atomic/response-ext-parameter` now cites the JSON:API 1.1 §Content Negotiation universal responsibility its MUST comes from, and `format` lists the `WRITES` still in place before those that are gone.
