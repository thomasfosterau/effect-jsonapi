# Conformance kit

The table above is what the constructors guarantee. It says nothing about your server once a handler has an opinion — so `Conformance` is an **executable specification** you run against your own `HttpApi`, which fails naming the broken rule and citing its section rather than printing an assertion diff.

```ts
import { Effect } from "effect";
import { Conformance } from "@thomasfosterau/effect-jsonapi";
import { Api } from "./api.js";
import { BlogLive } from "./handlers.js";

const report = await Effect.runPromise(
  Conformance.verify(Api, {
    // the fixture contract: one known-existing id per resource type
    ids: { articles: "1", people: "9" },
  }).pipe(Effect.provide(BlogLive), Effect.scoped),
);

console.log(Conformance.format(report));
```

Endpoints are discovered from the `HttpApi` value — method, path, declared query families, response media type — but every rule is decided by a real request/response pair, because conformance is a wire property and the typed client both hides the raw status, media type parameters and unparsed body, and refuses to construct the malformed requests half the rules need to send. `verify` drives an in-memory transport over the real router (no port bound, no fixture beyond the ids); `Conformance.verifyWith(api, { client, baseUrl })` runs the **identical** rules against a deployed server over `FetchHttpClient`.

Failures read as a report, not a diff:

```
FAIL  spec/content-negotiation/accept-weight-is-not-a-parameter
      MUST NOT · Content Negotiation (with RFC 9110 §12.4.2)
      A `q` weight is an Accept-header parameter, not a media type parameter (RFC 9110 §12.4.2),
      so a JSON:API media type instance carrying only a non-zero `q` MUST NOT be counted as
      parameterised and MUST NOT be rejected with 406.
      https://jsonapi.org/format/1.1/#content-negotiation-servers
      · a weighted preference between HTML and JSON:API was treated as a disallowed media type parameter
        GET /articles/1  [accept: text/html;q=0.9, application/vnd.api+json;q=0.8]
        expected: any status but 406 — the weight is not a media type parameter
        observed: 406 application/vnd.api+json — {"errors":[{"status":"406", …
```

**Writes need a fixture, and are opt-in.** The kit cannot invent a payload your server will accept, so the create / update / delete rules (201 with the created resource, `Location`, the update and delete responses, the atomic extension's response media type, `lid` resolution, all-or-nothing processing and the order of `atomic:results`) run only with `mutating: true` and a write fixture per type:

```ts
let n = 0;
Conformance.verify(Api, {
  ids: { articles: "1" },
  mutating: true,
  writes: {
    articles: {
      create: () => ({
        type: "articles",
        attributes: { title: `conformance probe ${++n}`, body: "…" },
        relationships: { author: { data: { type: "people", id: "9" } } },
      }),
      update: () => ({ attributes: { title: `conformance probe ${++n} (updated)` } }),
      cleanup: (id) => deleteArticleFromYourStore(id), // an Effect
    },
  },
});
```

Each write rule creates its own target from `create`, and acts on the id the server's create response named only after checking it: the response must name a resource of the type `create` returned, under an id that is a URL path segment of its own (not `""`, `.`, `..` or a lone surrogate) and is neither an `ids` sample, nor one a read earlier in the run returned (unless the kit had already taken it from a create of its own), nor one the run already holds — anything else is recorded as named and never updated, deleted or passed to `cleanup`. That check refuses only ids that are evidently not what the kit created: a server that answers a create with the id of some other existing resource cannot be told from an honest one, so run `writes` only against a server and data you can afford to have modified. `cleanup` runs after the rule that made it whether that rule passed, failed or died; and `report.writes` (printed under `WRITES`) lists everything the run created and what became of it. A type with no fixture skips its write rules naming the missing key. The client-generated id rules (201 or 204 under a client id, the 409 for a duplicate one, or 403 where they are unsupported — and the same of an atomic `add` under one, where the api has an operations endpoint) run only for a type whose fixture adds `clientId: { supported, id }` — the kit never makes up an id — and the relationship mutation rules (`PATCH` / `POST` / `DELETE` on `/relationships/…`, read back through the relationship's `GET` — a to-one `PATCH` of `null` included — what each answers, and the 404 for linking `absentId`) link a created resource to the `ids` sample of the related type. `cleanup` may be omitted for a target you throw away (an in-process store) — the report then lists what was left — but supply it against anything that outlives the run.

Two tiers, separately runnable. `spec` is JSON:API v1.1 alone; `profile` is this package's filter grammar profile, the Idempotency-Key profile's advertisement (with the write fixture, a create or an update on an endpoint declaring `Idempotency-Key` must name the profile on its media type, which an endpoint built with `idempotency` does itself) and the conventions it adds where the spec declines to have one. Pass `tiers: ["spec"]` to hold a server to the specification without adopting any of this library's opinions.

**It says what it did not check.** Every rule that could not run reports why — no endpoint of that shape, no sample id, no write fixture, a mutating probe not opted into — and `Conformance.gaps` declares the areas the kit does not cover at all (filter _evaluation_ semantics beyond what the sample shows, retried writes under the Idempotency-Key profile, concerns outside JSON:API), each with its reason and tracking issue. Both are printed in every report, and skips are counted separately from passes, so a run that proved little cannot read as a clean bill of health.

**A rule that dies does not cost you the report.** A defect in one rule — a transport that throws, or a bug in the kit — becomes that rule's `Errored` outcome (printed as `DIED`, with the defect's message, and counted as `errored` by `Conformance.summarise`); every other rule still runs and is reported, and so is `report.writes`. Interruption is not caught: it still stops the run, after the cleanup of whatever the interrupted rule created. A write fixture member that throws is not a defect, whatever it throws: a `create` or `update` that throws skips the rules it would have driven, and a `cleanup` that fails or throws is recorded in `report.writes`.

Use `Conformance.assert(report)` as a gate: it fails with a `ContractViolation` carrying the rule, its requirement, its citation and the request that decided it. A rule that died is not a finding about your server, but the run could not decide it either, so `assert` dies on it — with a defect tagged `RuleDied` naming the rule and the defect, the original as its `cause` — rather than passing. If you gate on `summarise(report).failed` or `findings(report)` instead of `assert`, also check `summarise(report).errored === 0`.

**Against a live server, bound the run.** `verifyWith` runs the identical rules over any `HttpClient` and `baseUrl`. Two options bound what that costs the server:

- `skip` — rule-id prefixes to leave out, the complement of `only` and matched the same way, by path segment: an entry matches the rule with that id and every rule whose id continues it with `/`, so `skip: ["spec/status/create-location"]` leaves out that rule alone, keeping `spec/status/create-location-matches-self`, and a partial segment (`"spec/content-neg"`) matches nothing. `skip: ["spec/pagination/links-enumerate-collection", "spec/links/"]` leaves out the pagination walk and the link crawl, the rules that make the most requests. It removes rules from what `tiers` and `only` select, and a rule it leaves out is absent from the report, as one `only` does not select is.
- `requestTimeout` — a `Duration.Input` (`"10 seconds"`) bounding each request, its body included; each redirect hop gets its own. A request still unanswered then is aborted and reads as a lost response naming the timeout, which every rule treats as any transport error. Thirty seconds by default, for `verify` and `verifyWith` alike; `requestTimeout: "Infinity"` (or `Duration.infinity`) turns it off, so the kit waits as long as the transport does. A duration that is not positive, or one `Duration` cannot read (e.g. `"1e3 seconds"`), is a defect.
