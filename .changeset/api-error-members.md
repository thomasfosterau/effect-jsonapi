---
"@thomasfosterau/effect-jsonapi": minor
---

`ApiError.make` can set the rest of a JSON:API error object: `id` (an occurrence id, from the fields), `links` (`type` and `about`, constant or from the fields), and `meta` (a function of the fields replacing the default copy of them), with `fromMeta` as its inverse so `Client.errorDocument` still reconstructs the class. Errors that set none of them encode exactly as before. `Document.ErrorLinks` is the error object's `links` schema.
