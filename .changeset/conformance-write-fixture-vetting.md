---
"@thomasfosterau/effect-jsonapi": patch
---

`Conformance`'s write rules no longer end the run with a defect when a create response names an id no URL can carry — a lone surrogate such as `"\ud800"`, on which `encodeURIComponent` throws. That throw came after the server had created the resource and before the kit recorded it, so the resource was left behind with no `Report.writes` entry, no `cleanup` and no report; the id is now refused like `..`, recorded as `left` with a `detail`, and never PATCHed, DELETEd or passed to `cleanup`.

An id a successful `GET` earlier in the run returned is still refused, but no longer when the kit had already taken that id from a create of its own: a read-back of what it made does not disown it, so a server that hands out the next free id keeps working. Every rule that only reads — the profile tier's included — now runs before the first rule that creates, so a create is checked against everything the run reads (the profile rules used to run after the write rules); `Report.outcomes` keeps the suite's order.

`spec/status/update-response` now requires the top-level `meta` of a 200 with no primary data to be an object, so `{ "meta": null }` fails, and its finding says which of `errors`, a missing `meta` or a non-object `meta` is wrong — a 200 carrying both `meta` and `errors` no longer reads "carries neither primary data nor a top-level `meta`".
