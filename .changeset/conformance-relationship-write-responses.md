---
"@thomasfosterau/effect-jsonapi": minor
---

Conformance: three more relationship write rules (#451). `spec/relationships/write-response` judges what a `PATCH` / `POST` / `DELETE` on `/relationships/…` answers: 202, 204 with no body, or 200 whose linkage is the relationship as it now stands (read back through its `GET`, or, with none, as the write leaves it) or that carries top-level `meta` alone. `spec/relationships/update-to-one-null` clears a to-one relationship whose payload admits `null` with `{ "data": null }` and wants it to read back as `null`. `spec/relationships/absent-related-404` links `absentId` under the related type through each `PATCH` and `POST` and wants a 404. Discovery records whether a relationship write's payload admits `null`. The `Conformance.gaps` entry narrows to "A relationship removal naming a resource that does not exist".
