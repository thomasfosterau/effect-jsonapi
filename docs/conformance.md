# Conformance kit

Design note for `Conformance` — the executable specification a server is driven through to prove it
implements JSON:API v1.1, and this package's profile. Tracks
[#120](https://github.com/thomasfosterau/effect-jsonapi/issues/120) (epic
[#115](https://github.com/thomasfosterau/effect-jsonapi/issues/115)).

**Status:** v1 implemented. 31 rules across two tiers, eight declared coverage gaps.

## 0. Why it exists

The package's premise is that compliance is _"a property of the construction, not of developer
discipline"_. That holds for what the endpoint constructors generate — the media type, the status
codes, the negotiation rules. It says nothing about a server once a handler has an opinion, and
until now there was no way for anyone to check. `HttpApiTest` exists and the package's own tests use
it, but a consumer had nothing to run.

The kit is the other half: an oracle that fails **naming the broken rule and citing its section**,
not printing an assertion diff.

> `spec/content-negotiation/accept-weight-is-not-a-parameter` — MUST NOT, Content Negotiation (with RFC 9110 §12.4.2)
> A `q` weight is an Accept-header parameter, not a media type parameter …

versus `expected 200, got 406`.

## 1. What is under test

**A transport, discovered from an `HttpApi` value.**

Two things are deliberately separated:

- **Discovery is static.** `Conformance.verify` walks `api.groups[*].endpoints[*]` and reads each
  endpoint's method, path, path parameters, flat wire query keys (`include`, `sort`,
  `fields[articles]`, `page[limit]`, and whether `filter[…]` is an index signature — i.e. the
  grammar — or named keys — i.e. the escape hatch) and its declared response media type. From the
  method and the path's segment shape it assigns a **role**: `collection`, `resource`, `create`,
  `update`, `delete`, `related`, `relationship`, `relationshipWrite`, `operations`. Nothing is
  requested during discovery, so the report can name both the endpoints it probed and the ones it
  could not build a URL for.
- **Observation is wire-level.** Every rule is decided by a real request/response pair.

### 1.1 Why not the typed client

`HttpApiTest.groups` returns an `HttpApiClient`, which is the wrong instrument here for two reasons:

1. **It hides what has to be checked.** Conformance is a wire property — the raw status code, the
   media type's _parameters_, the unparsed body, whether `included` carries a duplicate. The typed
   client decodes all of that away.
2. **It cannot express the probes.** Half the rules send deliberately malformed requests: a
   `Content-Type` with a `charset` parameter, an `Accept` whose every JSON:API instance is
   parameterised, `?fields[articles]=` naming a field that is not there, `?unknown=1`, a repeated
   `filter[…]` key. A typed client refuses to construct them, which is exactly its job and exactly
   why it is not the seam.

So the kit builds an in-memory `HttpClient` over the real router — the same
`HttpRouter.toHttpEffect` + `HttpClient.make` technique `HttpApiTest` uses, stopping one step
earlier — and drives raw requests through it.

### 1.2 In-process _and_ over the wire

This is not an either/or, and it should not be two kits.

|              | `Conformance.verify`                                  | `Conformance.verifyWith`       |
| ------------ | ----------------------------------------------------- | ------------------------------ |
| Transport    | in-memory over the real router                        | any `HttpClient` you pass      |
| Binds a port | no                                                    | n/a (whatever you point it at) |
| Handlers     | from the ambient context, as `HttpApiTest` takes them | the deployed server's          |
| Rules        | **identical**                                         | **identical**                  |

In-process is the default because it is deterministic, fast (~100–200 requests in well under a
second) and needs no fixture beyond sample ids. It still exercises request decoding, routing,
middleware, the handler and response encoding — the whole pipeline the rules care about.
`verifyWith` takes `FetchHttpClient` and runs the same rules against a deployed server, for the
things only a real deployment has: a reverse proxy rewriting `Content-Type`, a CDN, a gateway that
normalises headers.

### 1.3 The fixture contract

Deliberately the smallest one that works:

```ts
Conformance.verify(api, {
  ids: { articles: "1", people: "9" }, // one known-existing id per resource type
  paths: { "search.search": "/search?filter[q]=x" } // an explicit URL where the convention can't reach
})
```

`ids` is keyed by resource type, which under the conventional paths is the first literal path
segment. A rule that cannot resolve a URL reports **`Skipped`, naming the option it wanted** —
never a pass:

```
SKIP  spec/document/top-level-members
      not checked: no sample id for "articles" — pass ids["articles"] or paths["articles.get"]
```

A rule that probed _some_ endpoints but not others passes with a note saying how many it never
reached, so partial coverage never reads as full coverage.

## 2. Two tiers, separately runnable

| Tier      | What it is                                                                                                   | Authority                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `spec`    | JSON:API v1.1 alone                                                                                          | `https://jsonapi.org/format/1.1/` and the atomic extension |
| `profile` | this package's filter grammar profile, and the conventions it takes a position on where the spec declines to | `docs/filter-grammar.md`, the README                       |

`tiers: ["spec"]` runs the first without the second, so a consumer can hold themselves to the
specification without adopting anything of this library's. A test asserts that no profile rule ever
cites `jsonapi.org/format` as its authority.

## 3. What v1 covers

31 rules. Every one carries a stable id, an RFC 2119 level, a section and a URL.

**Content negotiation (§Content Negotiation, §Extensions, §Profiles)** — the response media type and
its permitted parameters; 415 on a parameterised request `Content-Type`; 406 when every `Accept`
instance is parameterised; an unsupported `ext` URI; an unrecognised `profile` ignored rather than
rejected; and the two RFC 9110 §12.4.2 weight rules — a non-zero `q` is not a media type parameter,
`q=0` is a refusal. The kit reported the first of those against the shipped middleware before
[#101](https://github.com/thomasfosterau/effect-jsonapi/issues/101) was fixed; it now guards the fix
against regressing.

**Document structure (§Document Structure, §Compound Documents, §Resource Objects)** — at least one
of `data` / `errors` / `meta`; `data` and `errors` never together; `included` only alongside `data`;
full linkage, computed transitively from the primary data through included resources' linkage;
no duplicate `(type, id)` anywhere in the document; `type` and `id` present and strings; the
`jsonapi` object's member types.

The document rules probe **compound** documents, not just bare ones: for each endpoint declaring
`include`, the kit reads the includable relationship names off a baseline response (only those
carrying inline `data` — a paginated relationship is links-only and including it is a legitimate 400) and re-probes with them. Without that, full linkage and duplicate detection would pass over
documents that never carry `included`, which is a pass that proves nothing.

**Error objects (§Errors, §Error Objects)** — the `{ errors: [...] }` shape; member types; `source`
discrimination (`pointer` / `parameter` / `header` only, `pointer` a real JSON Pointer); and
`status` agreeing with the response status.

**Query parameters (§Sparse Fieldsets, §Inclusion, §Sorting, §Query Parameters)** — sparse fieldsets
applying to primary data _and_ to `included` (two rules, because they fail independently —
[#112](https://github.com/thomasfosterau/effect-jsonapi/issues/112)); an unidentifiable `include`
path is a 400; an unsupported `sort` field is a 400; and an all-lowercase unrecognised query
parameter is a 400.

**Status codes** — 404 for an absent resource. The rest (`Location` on a 201, the 204-vs-200 delete
rules) are declared and reported as skipped; see §5.

**Atomic operations** — a malformed `atomic:operations` document is rejected. The rest are declared
and skipped; see §5.

**The profile tier** — the filter grammar's advertisement (§5), its rejections with
`source.parameter` (§2, §4, §7: an operator outside the closed core, an undeclared field, a key
deeper than the grammar admits, a repeated `filter[…]` key), and spelling equivalence (§2.2, §3:
bare shorthand, explicit `[eq]`, group form and a key-permuted group form must all answer the same
document, because the canonical string is a function of the AST alone). Plus two library
conventions: advertising `jsonapi: { version: "1.1" }`
([#103](https://github.com/thomasfosterau/effect-jsonapi/issues/103)) and accepting the repeated-key
spelling of every comma-separated family
([#102](https://github.com/thomasfosterau/effect-jsonapi/issues/102)).

The grammar rules learn a field name the target is known to accept from a baseline response before
probing rejections — otherwise "undeclared operator" would pass for the wrong reason, since an
undeclared _field_ is also a 400.

## 4. Vacuous passes are the failure mode

A conformance kit that answers "OK" without saying what it checked is worse than nothing, because it
manufactures confidence it has not earned. Three mechanisms guard against it:

1. **Applicability gating.** A conditional rule that never met its condition reports `Skipped`, not
   `Passed`. `spec/document/full-linkage` over an api that returned no compound document says so;
   `spec/document/jsonapi-object` over documents with no `jsonapi` member says so;
   `spec/query/sparse-fieldsets-included` counts only projection probes that actually returned an
   `included` resource of the requested type.
2. **Three distinct kinds of "not checked".** A rule can be absent because this api has no endpoint
   of that shape, because the caller withheld a sample id, or because the kit does not implement it
   at all — and the report keeps them apart. A reader who cannot tell them apart does not know what
   the run proved.
3. **A declared coverage ledger.** `Conformance.gaps` lists the areas the kit does not check, each
   with its reason and its tracking issues, and `format` prints it in every report. A requirement
   named neither in `Conformance.rules` nor in `Conformance.gaps` is simply unwritten, and the
   ledger says so in as many words.

The summary line reports skips alongside passes for the same reason:

```
SUMMARY  7 rules failed (19 findings) · 19 passed · 10 not checked · 7 areas out of scope · 111 requests made
```

## 5. What v1 does **not** cover

Declared in `Conformance.gaps` and printed in every report.

| Area                                          | Why not                                                                                                                                                                                                                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The filter profile's evaluation semantics** | Whether `not(eq(status, x))` matches a NULL row, whether `nin` is SQL's `NOT IN` or the negation of `in`, where an absent attribute lands. Needs an oracle over known data, which a black-box transport cannot supply. See §6.                                                               |
| **Pagination link correctness**               | That the links are present and well-formed is checkable; that following them enumerates the collection exactly once needs the full set.                                                                                                                                                      |
| **Sort ordering correctness**                 | That an unsupported field is a 400 is checked; that `?sort=-createdAt` actually orders, and where NULLs land, needs known data and the profile's collation decision.                                                                                                                         |
| **Write semantics**                           | Create / update / delete / relationship mutation. The status-code and `Location` rules are declared and skipped: the kit cannot synthesise a valid payload for an arbitrary resource, nor reset the target afterwards. Needs a fixture contract supplying a payload and a disposable target. |
| **Atomic operations processing**              | `lid` resolution, all-or-nothing, `atomic:results` ordering — same write-fixture need.                                                                                                                                                                                                       |
| **Link dereferenceability**                   | Well-formedness is checkable; crawling every `self` / `related` is a second pass the kit does not make.                                                                                                                                                                                      |
| **Concerns outside JSON:API**                 | Auth, caching, conditional requests, rate limiting, CORS. The spec takes no position, so neither does the kit.                                                                                                                                                                               |

Mutating probes are **off by default** (`mutating: true` opts in), because a conformance run should
be safe to point at a live server.

## 6. Relationship to #116

[#116](https://github.com/thomasfosterau/effect-jsonapi/issues/116) completed the filter profile by
giving it normative semantics, and **landed while this kit was being built**. The two were coupled
but not ordered, because the profile splits cleanly along the line the kit can see:

- **Normative all along, and checked here.** `docs/filter-grammar.md` §2 (surface syntax and what is
  a 400), §3 (canonical encoding and the round-trip invariants), §4 (the closed operator core), §5
  (the profile URI and its advertisement) and §7 (`source.parameter` on every rejection). None of
  these needs to know what a tree _means_, so all of them are in the profile tier today, and were
  before #116 landed.
- **Semantic, and a different kind of rule.** What §1.3 used to defer to a citation is now
  `docs/filter-grammar.md` §6: three-valued Kleene logic, a truth table per operator, and comparison
  defined on the field's JSON representation — rule-identified `F-EVAL-*`, `F-CMP-*`, `F-IN-*`,
  `F-LOGIC-*`, `F-ISNULL-*`, `F-NULL-*`, `F-CONS-*`. Deciding these means knowing which resources
  the server holds and what each one should have matched.

### 6.1 What #116 handed to this kit

#116 decided **no reference evaluator ships**, and said why the oracle belongs here instead:

> An executable oracle belongs where it can run against the thing that actually has to conform — a
> **server** — which is the conformance kit, #120. […] checking a _server_ against them is #120's
> job.

It also observed that the harness already holds the input: F-ORD-1 defines comparison on a field's
**JSON representation**, and F-EVAL-4 reads `value(resource, field)` from it — which is exactly what
a probe gets back off the wire. So the gap is narrower than it was first written. The remaining work
is:

1. A fold over `Filter.Ast` implementing §6.3's tables (short, per #116, but a second
   implementation of §6 to keep honest — which #116 names as a real cost).
2. A rule that fetches a collection unfiltered, evaluates a filter tree over each returned
   resource's JSON, and compares the expected match set against what the filtered request actually
   returned. No seeded fixture needed — the unfiltered collection _is_ the known set.

### 6.2 The open decision

Whether that evaluator is **public API or internal to the kit**. #116 left it open —

> Revisit if #120 wants the evaluator as a shared building block rather than a fixture of its own.

— and it is a real choice, not a detail. Public, it is the first thing this package ships that
evaluates data rather than describing it, and F-ORD-1's comparison domain (derived internally from
an attribute's encoded form, deliberately not part of `Resource.filterable`'s public shape) would
have to be exposed. Internal, the kit keeps its own oracle and no new public surface appears, but a
consumer building a server cannot reuse it to check their own store.

That decision is deliberately **not** taken in this version. The gap stays declared, now pointing at
§6 and at this question rather than at an unlanded issue.

## 7. Shipping

`Conformance` is a module of the package, namespaced from the root like every other:

```ts
import { Conformance } from "@thomasfosterau/effect-jsonapi"
```

A **supported entry point**, not a dev-only fixture: it compiles to `dist` and ships, so a consumer
can run it. (`effect-auth#199`, where the in-memory server fixture is excluded from the build and so
unusable downstream, is the cautionary tale #120 cites.)

Two packaging questions are deliberately **not** pre-empted:

- **[#117](https://github.com/thomasfosterau/effect-jsonapi/issues/117) (subpath exports).**
  `Conformance` imports `effect/unstable/http` and `effect/unstable/httpapi`, so it is unambiguously
  in the HTTP tier wherever #117 draws the line. Adding a subpath now would pre-empt a decision
  #117 wants made deliberately.
- **[#121](https://github.com/thomasfosterau/effect-jsonapi/issues/121) (`sideEffects`, `src` in
  `files`).** The module is pure — rule data and functions, no top-level effects — so it is
  compatible with `sideEffects: false` whenever that lands.

## 8. Running it against this repo

`examples/{blog,github,northwind}/test/conformance.test.ts` run the kit against all three worked
examples. They deliberately **do not assert a clean run** — they pin the exact set of rules each
example is known to break, with the issue tracking each:

| Rule                                   | Tracking                                                            | Whose         |
| -------------------------------------- | ------------------------------------------------------------------- | ------------- |
| `spec/document/no-duplicate-resources` | [#147](https://github.com/thomasfosterau/effect-jsonapi/issues/147) | the library's |
| `spec/query/sparse-fieldsets-primary`  | [#112](https://github.com/thomasfosterau/effect-jsonapi/issues/112) | the examples' |
| `spec/query/sparse-fieldsets-included` | [#112](https://github.com/thomasfosterau/effect-jsonapi/issues/112) | the examples' |
| `spec/query/unknown-query-parameter`   | [#148](https://github.com/thomasfosterau/effect-jsonapi/issues/148) | the library's |
| `profile/document/jsonapi-member`      | [#103](https://github.com/thomasfosterau/effect-jsonapi/issues/103) | the examples' |

The same five in all three examples, which is itself evidence: nothing here is one example's
mistake. Two were previously unfiled and were found by the kit —
[#147](https://github.com/thomasfosterau/effect-jsonapi/issues/147) (`Handlers.buildIncluded` does
not dedupe `included` against the primary data) and
[#148](https://github.com/thomasfosterau/effect-jsonapi/issues/148) (unknown query parameters are
ignored rather than rejected). A seventh,
[#101](https://github.com/thomasfosterau/effect-jsonapi/issues/101), was on this list until its fix
landed; the kit now guards it instead. An eighth,
[#102](https://github.com/thomasfosterau/effect-jsonapi/issues/102) (the repeated-key spelling was
honoured for `include` only), landed the same way.

Three of the five are now _example_ gaps rather than library ones: #112 landed `onResource` /
`Handlers.project` and #103 landed the `jsonapi` builder option, but the worked examples have not
adopted either, so the kit still sees unprojected fieldsets and documents that do not advertise
their version. Adopting both in `examples/*/handlers.ts` would clear those three — worth doing, and
deliberately left to a change that is about the examples rather than about the kit.

A new failure means a regression; a disappearing one means a fixed bug whose entry should come off
the list. The test says so when either happens.

## 9. Proving the kit detects

A kit that finds nothing is indistinguishable from a kit that checks nothing, so `Conformance.test.ts`
drives it against a **canned transport**: a hand-written JSON:API server good enough to pass every
rule the kit can decide, and then ~20 one-line deviations from it, each breaking exactly one rule.

Each case asserts the kit reports that rule _and_ produces a finding with a non-empty expected and
observed. One further case asserts the converse and matters just as much:

```ts
it("does not flag anything else when one rule is broken", async () => {
  // …serve `application/json` instead of the JSON:API media type…
  expect(failed(report)).toEqual(["spec/content-negotiation/response-media-type"])
})
```

A kit that fails everything catches every bug and is worthless. The control — the conformant server,
against which the kit reports no failures — is the other half of the same argument.

**The filter-grammar rules get their own fixture**, because nothing else would run them: no api in
this repo declares `filter: true`, so against every example they legitimately report `Skipped`. A
rule that skips everywhere would ship never having executed, which is indistinguishable from a rule
that does not work. So `Conformance.test.ts` carries a grammar-enabled api and a canned server
implementing §2/§4/§5/§7 correctly, asserts the three rules **pass and actually ran** (not skipped),
and then breaks each in turn: the profile parameter dropped from the media type, an operator outside
the closed core accepted, a rejection that omits `source.parameter`, and the group form answering a
different document from the shorthand it desugars from.

## 10. Open questions

- **A write-fixture contract.** The largest gap by far. Something like a per-resource
  `{ create: () => payload, cleanup: (id) => Effect<void> }`, which would unlock the create/update/
  delete status rules, `Location`, relationship replacement semantics and the whole atomic suite.
- **Machine-readable output.** `format` renders text. A JSON rendering of `Report` is trivially
  derivable (it is plain data) but no stable serialisation is committed to yet.
- **Rule versioning.** Rule ids are the stable surface a consumer pins against; a policy for
  renaming or retiring one is not yet written.
