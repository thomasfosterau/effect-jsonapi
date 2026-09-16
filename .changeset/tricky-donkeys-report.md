---
"@thomasfosterau/effect-jsonapi": minor
---

Add `Conformance` — an executable specification of JSON:API v1.1, and of this package's filter
grammar profile, that a server can be driven through to prove it conforms.

`Conformance.verify(api, { ids })` discovers your endpoints from the `HttpApi` value (method, path,
declared query families, response media type) and then decides every rule against a real
request/response pair over an in-memory transport wired to the real router — no port bound, no
fixture beyond one known-existing id per resource type.
`Conformance.verifyWith(api, { client, baseUrl })` runs the identical rules against a deployed
server over any `HttpClient`. Conformance is a wire property, so the rules observe raw statuses,
media-type parameters and unparsed bodies, and send the malformed requests a typed client cannot
express.

31 rules across two separately runnable tiers. The `spec` tier covers content negotiation
(including the RFC 9110 §12.4.2 `q`-weight rules), document structure (top-level members, full
linkage computed transitively, duplicate resources, resource identification, the `jsonapi` object),
error objects and `source` discrimination, query-parameter handling (sparse fieldsets on primary
data _and_ on `included`, unsupported `include` / `sort`, unknown parameters), 404 semantics and the
atomic operations request document. The `profile` tier covers the filter grammar's advertisement,
its rejections with `source.parameter`, and spelling equivalence between shorthand and group form,
plus two library conventions (`jsonapi` version advertisement, the repeated-key query spelling).
Pass `tiers: ["spec"]` to hold a server to the specification without adopting the profile.

Failures name the rule, quote its normative sentence, cite its section and show the request that
decided it. `Conformance.assert(report)` fails with a `ContractViolation` carrying all of that, and
`Conformance.format(report)` renders the whole run.

The report states what it did **not** check. A rule that could not run reports why — no endpoint of
that shape, no sample id, a mutating probe not opted into — rather than passing vacuously, and
`Conformance.gaps` declares the areas the kit does not cover at all (filter evaluation semantics,
pagination-link and sort-ordering correctness, write semantics, atomic processing, link
dereferenceability), each with its reason and tracking issues. Skips are counted separately from
passes so a run that proved little cannot read as a clean one.

Mutating probes are off by default, so a run is safe to point at a live server.
