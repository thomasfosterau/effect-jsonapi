---
"@thomasfosterau/effect-jsonapi": minor
---

Accept spec-valid documents the `Document` schemas used to reject: `LinkObject.hreflang` is a string or an array of strings, `JsonApiObject.version` is any string (so a client keeps reading a server on a later minor version; `Document.v1_1` is still what a server emits), and `ErrorSource` is one struct with optional `pointer` / `parameter` / `header` that keeps other members, so `Client.errorDocument` reads an error with `source: {}`. New `Document.ResourceLinksOpen` and `Document.TopLevelLinksOpen` keep the links a server adds beyond the standard ones.
