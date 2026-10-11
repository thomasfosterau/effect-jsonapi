---
"@thomasfosterau/effect-jsonapi": patch
---

The link dereferencing rules (#168) are refined after review:

- `spec/links/related-dereferences` (MUST) now holds a relationship's `related` link only to answering a 2xx with resource data — a resource object, an array of them or `null` — as JSON:API 1.1 §Fetching Resources requires: "A server **MUST** support fetching resource data for every URL provided as: … a `related` link as part of a relationship-level links object". Its `section` and `reference` are now §Fetching Resources.
- The comparison with the linkage moves to a new rule, `spec/links/related-matches-linkage`, graded **SHOULD** because §Related Resource Links states it without a keyword: "When fetched, the related resource object(s) are returned as the response's primary data." It follows the `related` link of every relationship that carries linkage and leaves a link the MUST already fails (not a link, a non-2xx, no resource data) not decided rather than reporting it twice.
- A resource or linkage item without a string `type` and `id` now leaves its link not decided, as an answer holding one already did. A `self` link on such a resource used to be skipped silently, and such an item in to-many linkage was left out of the comparison, which could report a resource the linkage did name as one it did not.
- A rule lists its first ten findings and one more counting the rest, and quotes every resource label it names, cut to 200 UTF-16 code units.
- A read endpoint the request budget left unsearched now makes the rule `Skipped`, naming the budget, as a link left unfollowed already did; it could pass.
- A link whose scheme has no origin (`javascript:`) is named by its scheme, not as "another origin, null".

Every `Conformance` probe, over either transport, now leaves a redirect unfollowed: `verifyWith` provides `FetchHttpClient.RequestInit` with `redirect: "manual"` (keeping the rest of the run's `RequestInit`), so a `3xx` answers as itself, as it always has in process, and a server cannot lead the kit to another origin. An answer a transport fetched from another origin all the same is not read; it is recorded as a lost response. `Conformance.verify`'s in-process transport now answers only the router's `RouteNotFound` as a 404; any other router failure dies again, as before #168.
