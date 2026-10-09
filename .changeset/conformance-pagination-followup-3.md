---
"@thomasfosterau/effect-jsonapi": patch
---

`spec/pagination/links-enumerate-collection` and the link dereferencing rules decide less on evidence they did not get:

- A walk that would start on a page of items none of which has a string `type` and `id` (or `lid`) — the reference request or the second walk's first page — is not begun, and the collection is reported not decided. It used to go ahead and report MUST failures (a `first` link that "answers different resources", resources "never reached") against resources the kit never saw.
- A `408 Request Timeout` mid-walk, from a `first` / `last` link, or from a link `spec/links/resource-self-dereferences` or `spec/links/related-dereferences` follows, now leaves the collection or link not decided, as a server error, a `429` or a lost response already did. It used to be a MUST failure.
