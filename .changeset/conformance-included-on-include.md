---
"@thomasfosterau/effect-jsonapi": minor
---

The conformance kit checks that a response to a request carrying `include` has a top-level `included` array, even an empty one (JSON:API 1.1 §Fetching Includes). The new rule, `spec/document/included-on-include`, reads the kit's compound-document probes and sends a bare `?include=` to every read endpoint that declares `include`, since a supplied but empty `include` must get `included: []`. It reports `Skipped` when no such request drew a 2xx.
