---
"@thomasfosterau/effect-jsonapi": minor
---

`Conformance` gains two spec-tier MUST rules that follow a server's own links rather than only reading them (#168):

- `spec/links/resource-self-dereferences` follows every resource object's `links.self` and requires the answer's primary data to be that resource, the same `type` and `id` (JSON:API 1.1 §Resource Links: "A server **MUST** respond to a `GET` request to the specified URL with a response that includes the resource as the primary data").
- `spec/links/related-dereferences` follows every relationship's `links.related` and requires the answer to be the resources its linkage names: the same resource for to-one linkage, `null` for `null` linkage, the same set for to-many linkage — a subset either way when the related collection or the linkage carries `next` — and resource objects of any identity for a links-only relationship (§Fetching Resources: "A server **MUST** support fetching resource data for every URL provided as: … a `related` link as part of a relationship-level links object"; §Related Resource Links: "When fetched, the related resource object(s) are returned as the response's primary data").

The links are collected from one `GET` of each read endpoint whose URL resolves. A link may be a string or a link object's `href`, and is resolved against the document that carries it. A link to another origin is never requested and is reported as not followed. A server error, a `429`, a lost response, a `401` or a `403` leaves a link not decided; any other non-2xx, a `404` included, is a finding. Each rule makes at most 200 requests per run and is `Skipped`, naming that budget, when it cannot follow every link — never a partial pass — unless a link it did follow broke the rule. The pagination walk and the link rules now share one link-following module.

`Conformance.verify`'s in-process transport now answers a request the router itself fails — a path no route serves — as a deployed server does (the router's 404), instead of making the rule that sent it `Errored`.

`Conformance.gaps` no longer lists "Link dereferenceability"; it lists the narrower "Relationship and top-level `self` links" (#309) instead.
