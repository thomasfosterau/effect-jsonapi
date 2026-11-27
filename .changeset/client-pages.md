---
"@thomasfosterau/effect-jsonapi": minor
---

Add `Client.pages` and `Client.items`: walk a paginated collection as a `Stream`, following each response's `links.next` until the server sends none. The next href's parameters are decoded through the endpoint's query schema and passed to the same typed call, so offset, page-number and cursor pagination all work, each page keeps its `included`, and `maxPages` caps the requests.
