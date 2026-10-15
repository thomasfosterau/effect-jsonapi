---
"@thomasfosterau/effect-jsonapi": minor
---

`Conformance` gains two spec-tier MUST rules on the link crawl (#309). Both use the crawl the other link rules use: same-origin only, `GET` only, 200 requests per rule, and a server error, a `429`, a `408` or a lost response leaves the link not decided. `skip: ["spec/links/"]` leaves them out with the rest.

- `spec/links/relationship-self-dereferences` follows every relationship's own `links.self` (JSON:API 1.1 §Fetching Relationships: "A server **MUST** support fetching relationship data for every relationship URL provided as a `self` link …", and "The primary data in the response document **MUST** match the appropriate value for resource linkage"). The answer must be resource linkage. When the relationship object carries linkage, the answer must hold the same identifiers. As in `spec/links/related-matches-linkage`, the check relaxes to a subset when either side carries `next`, and nothing is decided when both do.
- `spec/links/top-level-self-dereferences` follows every document's top-level `links.self` (§Fetching Resources), relationship endpoints' documents included. The answer must be a document of the same kind. A single resource must answer the same `type` and `id`, and `null` must answer `null`. A collection must answer a collection. It must hold the same resources, in any order, only when neither document carries `next` or `prev`, because a page can differ from the document it is compared with.

`Conformance.gaps` no longer lists "Relationship and top-level `self` links".
