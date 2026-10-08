---
"@thomasfosterau/effect-jsonapi": minor
---

`Conformance` gains a write-fixture contract, so the create / update / delete rules can actually run. `Conformance.Options.writes` takes a `Conformance.WriteFixture` per resource type — `create` (a payload the server accepts), `update` (a PATCH that must succeed) and `cleanup` (removes what the kit created; optional) — and, with `mutating: true`, the kit creates its own disposable targets from it, disposes of each however its rule ended (passed, failed or died), and lists every one in the new `Report.writes` (`Conformance.Write`), printed by `format` under `WRITES`. A type with no fixture skips its write rules naming the missing key.

Rules that now run: `spec/status/create-location`, `spec/status/delete-response` and `spec/atomic/response-ext-parameter`, plus three new ones — `spec/status/create-response-document`, `spec/status/create-location-matches-self` and `spec/status/update-response`. `spec/status/create-location` is now a `SHOULD`, the level JSON:API v1.1 gives `Location` on a 201. `spec/status/delete-response` now deletes a resource the kit created rather than the `ids` sample it used to delete under `mutating: true`.

Fixed: a probe's request body is now sent under the probe's own `Content-Type` (the JSON:API media type by default). It was sent as `application/json`, so `spec/content-negotiation/request-content-type-parameters` and `spec/atomic/malformed-operations-rejected` never sent the media type their report said they did.

The `Write semantics` coverage gap is narrowed to what the fixture does not yet cover (#237).
