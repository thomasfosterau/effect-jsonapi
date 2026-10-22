---
"@thomasfosterau/effect-jsonapi": minor
---

Conformance: the rest of the write rules (#429). Three client-generated id rules, `spec/status/create-client-id` (201 or 204), `spec/status/create-conflict-id` (409 for a duplicate) and `spec/status/create-client-id-unsupported` (403), run for a type whose `writes[type]` fixture opts in with the new `clientId: { supported, id }` (`Conformance.ClientIdFixture`). The kit never makes up a client id. Three relationship mutation rules, `spec/relationships/update-replaces`, `add-appends` and `remove-deletes`, drive `PATCH` / `POST` / `DELETE` on `/relationships/…` against a created resource, link it to the related type's `ids` sample and read the linkage back through the relationship's `GET`. The `Conformance.gaps` entry is now "Relationship writes beyond the read-back" (#451).
