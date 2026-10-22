---
"@thomasfosterau/effect-jsonapi": minor
---

**`Assemble.relationship` no longer puts the parent resource in `included`.** A relationship document's primary data is the related resources' identifiers, so the parent was reachable only if an included child linked back to it, and the document failed full linkage (#444). Through `Endpoint.getRelationship` encoding already stripped `included`, so the parent never reached the client; a custom schema that declared `included` got a 500 from the post-encode linkage check. `included` now carries only the resources passed as `included` (deduplicated), and is `[]` when none are. `RelationshipDocument<R, I>['included']` is typed `ReadonlyArray<WireResource<I>>` accordingly. A client that needs the post-mutation parent fetches it.
