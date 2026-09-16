---
"@thomasfosterau/effect-jsonapi": minor
---

Add idempotent writes: the `Idempotency-Key` profile (#123)

A retried `POST` duplicates. `lid` does not cover it — a local id correlates resources _within_ one
request and says nothing about whether the request already ran. The new `Idempotency` module answers
that as a JSON:API profile
(`https://thomasfosterau.github.io/effect-jsonapi/profiles/idempotency/v1`), defined in full in
[`docs/idempotency.md`](./docs/idempotency.md).

- **The header, on the endpoints that honour it.** `Endpoint.create` / `update` / `delete` /
  `operations`, and the `Endpoint.resource` / `Group.resource` generators, take
  `idempotency: true | "required"`. It declares the `Idempotency-Key` request header (typed and
  parsed, not raw) and attaches `Idempotency.Middleware`, so an api carrying an idempotent endpoint
  does not type-check until a store is provided. Endpoints that do not opt in are unchanged.
- **Replay is verbatim.** A retry carrying the same key gets the recorded response back byte for
  byte — the same status, headers and body — plus `Idempotency-Replayed: true`, so a `201` stays a
  `201` and typed clients keep working.
- **The same key with a different body is an error, not a replay.** `422 Unprocessable Content`
  (`idempotency_key_mismatch`), checked before the in-flight case; a retry while the original is
  still running is `409 Conflict` (`idempotency_key_in_progress`). Both are JSON:API error documents
  carrying `source: { header: "idempotency-key" }`. A missing required key is the package's standard
  `400`.
- **The store is a seam.** This package persists nothing: `Idempotency.Store` is three effects
  (`claim` / `complete` / `release`) the application supplies to `Idempotency.layer(store)`, with
  `claim`'s atomicity and the retention window as documented requirements.
  `Idempotency.memoryStore()` is a reference implementation for tests and single-process
  development.
- **Atomic operations:** one key covers the whole request — the extension's own unit of atomicity —
  and replays the whole `atomic:results` document, so a replayed `lid` resolves to the id it
  resolved to the first time.

Also: `ApiError.make` now takes a `source` option, so a declared error can name the `pointer`,
`parameter` or `header` that caused it in its error document.
