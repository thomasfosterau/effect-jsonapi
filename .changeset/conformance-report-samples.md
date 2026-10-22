---
"@thomasfosterau/effect-jsonapi": minor
---

`Conformance.Report.samples` records every `/:type/:id` read the `ids` samples resolve, as `{ type, id, url, status }`, and `Conformance.format` names the ones that answered non-2xx under `SAMPLES`. A sample the server does not hold still fails no rule and is not a gap; a fixture test can now assert on `report.samples` instead of matching a note's wording (#319). The kit sends no request of its own for this: a sample no selected rule read is left out.
