/**
 * An executable specification of JSON:API v1.1 — and of this package's own
 * profile — that a server can be driven through to prove it conforms.
 *
 * The package's premise is that compliance is a property of the construction:
 * the endpoint constructors bake in the media type, the status codes and the
 * negotiation rules. That holds for what they generate, and says nothing once a
 * handler has an opinion. This module is the other half: an oracle a consumer
 * runs against their own `HttpApi`, which fails naming the broken rule and
 * citing its section rather than printing an assertion diff.
 *
 * **What is under test is a transport, not a value.** Endpoint discovery is
 * static — {@link verify} walks the `HttpApi` for each endpoint's method, path,
 * declared query families and response media type — but every rule is decided
 * by a real HTTP request/response pair. That is deliberate: conformance is a
 * wire property, and the typed `HttpApiClient` both hides what has to be
 * observed (raw status, the media type's parameters, the unparsed body) and
 * refuses to construct the malformed requests the rules need to send. The
 * default transport is in-process, so a run binds no ports and is deterministic;
 * {@link verifyWith} takes any `HttpClient` so the identical rules can be run
 * against a deployed server.
 *
 * **Two tiers, separately runnable.** The `spec` tier is JSON:API v1.1 alone.
 * The `profile` tier is this package's own profiles — the filter grammar and
 * the Idempotency-Key profile — and the conventions the library takes a
 * position on where the spec declines to, so a consumer can run the first
 * without adopting the second ({@link Options.tiers}).
 *
 * **The report states what it did not check.** Every rule that could not run
 * reports why, and {@link gaps} declares the areas the kit does not cover at
 * all. A kit that answers "OK" without saying what it checked is worse than
 * nothing, so {@link format} always prints all three sections.
 *
 * **Writes are opt-in and disposable.** The rules that change state run only
 * with `mutating: true` and a {@link WriteFixture} per type in `writes`. They
 * act on the id the server's create response named only after checking it
 * names a resource of the type the kit sent, under an id that is a URL path
 * segment of its own and is neither an `ids` sample, nor one a read in the run
 * returned, nor one the run already holds; they dispose of each resource
 * however the rule ended, and list every one in {@link Report.writes}. The
 * check refuses only ids evidently not the kit's own — any other id is
 * trusted — so run writes only against data you can afford to have modified.
 *
 * @example
 * ```ts
 * import { Effect, Layer, Schema } from "effect"
 * import { HttpApi, HttpApiBuilder } from "effect/http-api"
 * import {
 *   Conformance,
 *   Endpoint,
 *   Group,
 *   Handlers,
 *   Middleware,
 *   Resource
 * } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String }
 * })
 *
 * const api = HttpApi.make("blog").add(
 *   Group.make(Article, Endpoint.get(Article), Endpoint.list(Article))
 * )
 *
 * const sample = Article.make({
 *   id: Article.Id.make("1"),
 *   attributes: { title: "JSON:API paints my bikeshed!", body: "The shortest article. Ever." }
 * })
 *
 * const ArticlesLive = HttpApiBuilder.group(api, "articles", (handlers) =>
 *   handlers
 *     .handle("get", () => Effect.succeed(Handlers.data(sample, { self: "/articles/1" })))
 *     .handle("list", () => Effect.succeed(Handlers.collection([sample]))))
 *
 * const Live = ArticlesLive.pipe(Layer.provideMerge(Middleware.layer))
 *
 * // `ids` is the fixture contract: one id per resource type that is known to exist,
 * // so the rules can build a concrete URL for `/articles/:id`.
 * const program = Conformance.verify(api, { ids: { articles: "1" } }).pipe(
 *   Effect.map(Conformance.format),
 *   Effect.provide(Live),
 *   Effect.scoped
 * )
 *
 * // `program` yields the legible report: what passed, what failed and what was not checked.
 * Effect.isEffect(program) // true
 * ```
 *
 * @since 0.15.0
 */
import {
  Array as Arr,
  Duration,
  Effect,
  Layer,
  MutableHashSet,
  Option,
  Order,
  Predicate,
  Schema,
} from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { Path } from "effect/Path";
import type { Scope } from "effect/Scope";
import { HttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { Etag } from "effect/http";
import type { HttpPlatform } from "effect/http/HttpPlatform";
import { HttpApiBuilder } from "effect/http-api";
import type { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import * as Core from "./internal/conformance/core.js";
import * as ProfileRules from "./internal/conformance/profile.js";
import * as ReportFormat from "./internal/conformance/report.js";
import * as Samples from "./internal/conformance/samples.js";
import * as SortRules from "./internal/conformance/sort.js";
import * as SpecRules from "./internal/conformance/spec.js";
import * as WriteFixtures from "./internal/conformance/write.js";

// ---------------------------------------------------------------------------
// The rule model
// ---------------------------------------------------------------------------

/**
 * Which body of requirements a rule comes from: `"spec"` is JSON:API v1.1
 * itself, `"profile"` is this package's own profiles (the filter grammar and the
 * Idempotency-Key profile) and the conventions it adds where the spec declines
 * to have an opinion.
 *
 * The two are separately runnable so a consumer can hold themselves to the spec
 * without adopting the profile.
 *
 * @example
 * ```ts
 * import { Conformance } from "@thomasfosterau/effect-jsonapi"
 *
 * const tier: Conformance.Tier = "spec"
 * Conformance.rules.filter((rule) => rule.tier === tier).length > 0 // true
 * ```
 *
 * @since 0.15.0
 * @category models
 */
export type Tier = Core.Tier;

/**
 * The normative force of a rule, in RFC 2119 terms. A failing `MUST` is
 * non-conformance; a failing `SHOULD` is a recommendation the target declines.
 *
 * @example
 * ```ts
 * import { Conformance } from "@thomasfosterau/effect-jsonapi"
 *
 * const mandatory: ReadonlyArray<Conformance.Level> = ["MUST", "MUST NOT"]
 * Conformance.rules.filter((rule) => mandatory.includes(rule.level)).length > 0 // true
 * ```
 *
 * @since 0.15.0
 * @category models
 */
export type Level = Core.Level;

/**
 * One checkable requirement: a stable `id`, the `requirement` as a normative
 * sentence, and the `section` and `reference` it comes from.
 *
 * The sentence and the citation are the point. "Expected 415, got 200" is a test
 * failure; the rule's text plus its section is a conformance report.
 *
 * @example
 * ```ts
 * import { Conformance } from "@thomasfosterau/effect-jsonapi"
 *
 * const rule: Conformance.Rule | undefined = Conformance.rules.find(
 *   (candidate) => candidate.id === "spec/document/full-linkage"
 * )
 *
 * rule?.level // "MUST NOT"
 * rule?.section // "Compound Documents"
 * ```
 *
 * @since 0.15.0
 * @category models
 */
export interface Rule extends Core.Rule {}

/**
 * The request a rule made, recorded so a failure can be reproduced by hand.
 *
 * @example
 * ```ts
 * import { Conformance } from "@thomasfosterau/effect-jsonapi"
 *
 * const probe: Conformance.Probe = {
 *   method: "GET",
 *   url: "/articles/1",
 *   headers: { accept: "application/vnd.api+json;q=0.9" },
 *   body: undefined
 * }
 *
 * probe.headers["accept"] // "application/vnd.api+json;q=0.9"
 * ```
 *
 * @since 0.15.0
 * @category models
 */
export interface Probe extends Core.Probe {}

/**
 * One way in which a rule was broken: the rule, what was expected, what was
 * observed, and the request that decided it.
 *
 * A rule can produce several findings — the content-negotiation weight rule
 * probes four `Accept` spellings and reports each that was rejected — so the
 * report names every case rather than stopping at the first.
 *
 * @example
 * ```ts
 * import { Conformance } from "@thomasfosterau/effect-jsonapi"
 *
 * const describeFinding = (finding: Conformance.Finding): string =>
 *   `${finding.rule.id}: expected ${finding.expected}, observed ${finding.observed}`
 *
 * typeof describeFinding === "function" // true
 * ```
 *
 * @since 0.15.0
 * @category models
 */
export interface Finding extends Core.Finding {}

/**
 * What became of one rule in a run: `Passed` with the number of requests it
 * made, `Failed` with its findings, `Skipped` with the reason it could not
 * be decided against this target, or `Errored` when the rule died — a
 * transport that throws, or a bug in the kit, not a finding about the server —
 * with the defect's `message` (capped at 500 UTF-16 code units, a longer one
 * ending in `…`; `[unrenderable defect]` for a value the kit cannot read at
 * all — a revoked `Proxy`, or one whose `getPrototypeOf` trap throws, or an
 * `Error` whose `name` or `message` throws when read or cannot become a string
 * (a Symbol, or an object whose `toString` throws)) and the `defect` itself.
 * Any other value that throws when part of it is read — an object whose
 * `toString` throws, say — renders with `Formatter.format`'s own marker for
 * that part, such as `[toString threw]`.
 *
 * `Skipped` is load-bearing. A rule that needs a write endpoint against an api
 * that has none, or a sample id the caller did not supply, must not be counted
 * as a pass — the report says so and names what was missing.
 *
 * `Errored` (since 0.17.0) keeps one rule's defect from costing the run the
 * rest of its report: every other rule still runs and is reported, and so is
 * {@link Report.writes}. It is neither a pass nor a finding — {@link assert}
 * dies on it. Interruption is not turned into an outcome: it still stops the
 * run. A write fixture member that throws is not a defect, whatever it
 * throws: a `create` or `update` that throws skips the rules it would have
 * driven, naming the member, and a `cleanup` that fails or throws is recorded
 * in {@link Report.writes}. The value is rendered as `message` is, so one the
 * kit cannot read at all reads `[unrenderable defect]` there too.
 *
 * @example
 * ```ts
 * import { Conformance } from "@thomasfosterau/effect-jsonapi"
 *
 * const verdict = (outcome: Conformance.Outcome): string => {
 *   switch (outcome._tag) {
 *     case "Passed":
 *       return `${outcome.rule.id} held over ${outcome.probes} probes`
 *     case "Failed":
 *       return `${outcome.rule.id} broken in ${outcome.findings.length} way(s)`
 *     case "Skipped":
 *       return `${outcome.rule.id} not checked: ${outcome.reason}`
 *     case "Errored":
 *       return `${outcome.rule.id} died: ${outcome.message}`
 *   }
 * }
 *
 * typeof verdict === "function" // true
 * ```
 *
 * @since 0.15.0
 * @category models
 */
export type Outcome = Core.Outcome;

/**
 * An area the kit does not check at all, with the reason and the issues that
 * would change it.
 *
 * Declared up front and printed in every report, so coverage the kit does not
 * have cannot be mistaken for coverage it does.
 *
 * @example
 * ```ts
 * import { Conformance } from "@thomasfosterau/effect-jsonapi"
 *
 * const semantics: Conformance.Gap | undefined = Conformance.gaps.find((gap) =>
 *   gap.area.includes("evaluation semantics")
 * )
 *
 * semantics?.tracking.includes("#116") // true
 * ```
 *
 * @since 0.15.0
 * @category models
 */
export interface Gap extends Core.Gap {}

/**
 * A resource object a create endpoint will accept, without an `id` — the value
 * a {@link WriteFixture}'s `create` returns.
 *
 * It is the **wire** form: the kit sends it as raw JSON, exactly as a client
 * would, so a `Schema.DateFromString` attribute is an ISO string here, not a
 * `Date`. The kit wraps it as `{ data: … }` for `POST /<type>` and as an `add`
 * operation for the atomic operations endpoint.
 *
 * @example
 * ```ts
 * import { Conformance } from "@thomasfosterau/effect-jsonapi"
 *
 * const payload: Conformance.WritePayload = {
 *   type: "articles",
 *   attributes: { title: "conformance probe", body: "…", createdAt: "2024-01-01T00:00:00.000Z" },
 *   relationships: { author: { data: { type: "people", id: "9" } } }
 * }
 *
 * payload.type // "articles"
 * ```
 *
 * @since 0.17.0
 * @category models
 */
export interface WritePayload extends Core.Payload {}

/**
 * The write-fixture contract for one resource type: what the kit cannot derive
 * for itself, so the write rules can run.
 *
 * - **`create`** — a payload the server will accept. The kit cannot synthesise
 *   one: attributes carry domain constraints and required relationships point
 *   at resources that must already exist, and a payload the server rejects
 *   proves nothing about what it answers on success. Called once per create, so
 *   a fixture under a uniqueness constraint can return a fresh value each time.
 * - **`update`** — the `attributes` / `relationships` of a PATCH that must
 *   succeed against a resource `create` made. The kit adds `type` and `id`.
 * - **`cleanup`** — removes a resource the kit created, by the id the server
 *   assigned. It runs for every resource the kit created and did not itself
 *   delete, after the rule that made it — whether that rule passed, failed or
 *   died — and a cleanup that fails is recorded in {@link Report.writes} rather
 *   than aborting the run. It requires no services (its `R` is `never`), so
 *   close over or provide whatever it needs up front. It runs uninterruptibly,
 *   as a release step, so a `cleanup` that never completes hangs the run —
 *   give one that talks to a remote store its own timeout.
 * - **`clientId`** — opts the type into the client-generated id rules
 *   ({@link ClientIdFixture}): whether the server supports a client-generated
 *   id, and an id to send. The kit never makes an id up, so without
 *   `clientId` those rules skip naming it.
 *
 * Every member is optional, and each one gates only its own rules: a type with
 * no `create` skips every write rule naming `writes["<type>"].create`, and a
 * create-only type supplies no `update` and skips only the update rule.
 * **`cleanup` is optional too**, for a target known to be disposable — an
 * in-process store a test throws away. Without it the kit leaves what it
 * created in place and says so in {@link Report.writes}, so never omit it
 * against a server whose state outlives the run.
 *
 * The write rules run only when {@link Options.mutating} is `true`, after
 * every rule that creates nothing, and act on the id the server's create response
 * named only after checking it: the response must name a resource of the type
 * `create` returned, under an id that is a URL path segment of its own (not
 * `""`, `.`, `..` or one no URL can carry), is not an `ids` sample, was not
 * returned by a successful `GET` earlier in the run (unless the kit had
 * already taken that id from a create of its own), and is not one the run
 * already holds a resource for that has not been removed. A refused id is
 * recorded as named and never updated, deleted or passed to `cleanup`. The
 * check refuses only ids that are evidently not the kit's own: any other id is
 * trusted, because a server that names some other existing resource cannot be
 * told from an honest one — so supply `writes` only for a server and data you
 * can afford to have modified. A create answered with anything but a 2xx is
 * taken to have created nothing, so nothing is recorded or cleaned up for it —
 * except by `spec/atomic/all-or-nothing`, which lists the type's collection
 * before and after a request that must fail, and records and cleans up any
 * resource that appeared in between carrying the fixture's `attributes`.
 *
 * The atomic rules send `create`'s payload as an `add` operation. A type whose
 * payload links to another type with a `create` fixture gives
 * `spec/atomic/lid-resolution` its linkage probe (create the linked resource
 * under a `lid`, link to it by that `lid`, read both back); a type with an
 * `update` gives it its update probe (an `update` naming the new resource by
 * `lid`, read back). Each needs a single-resource GET to read back through,
 * and `all-or-nothing` a collection GET to list.
 *
 * The relationship mutation rules need no member of their own: for each
 * `PATCH` / `POST` / `DELETE` on `/<type>/:id/relationships/<name>` whose type
 * has a `create`, they create a resource, link it to the `ids` sample of a type
 * the endpoint's payload names, and read the linkage back through
 * `GET /<type>/:id/relationships/<name>`. The sample is only linked to, never
 * written to — but a server that stores the inverse of the relationship on the
 * sample (a comment's one article, say) changes it, so give such a type an
 * `ids` sample you can afford to have relinked.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Conformance } from "@thomasfosterau/effect-jsonapi"
 *
 * // the in-memory store a test server would read from
 * const store = new Map<string, unknown>()
 *
 * let sequence = 0
 * const articles: Conformance.WriteFixture = {
 *   // a fresh title per create, because the server rejects a duplicate
 *   create: () => ({
 *     type: "articles",
 *     attributes: { title: `conformance probe ${++sequence}`, body: "…" },
 *     relationships: { author: { data: { type: "people", id: "9" } } }
 *   }),
 *   update: () => ({ attributes: { title: `conformance probe ${++sequence} (updated)` } }),
 *   cleanup: (id) => Effect.sync(() => store.delete(id))
 * }
 *
 * articles.create?.().type // "articles"
 * ```
 *
 * @since 0.17.0
 * @category models
 */
export interface WriteFixture extends Core.Fixture {}

/**
 * A {@link WriteFixture}'s opt-in to the client-generated id rules
 * ([§Client-Generated IDs](https://jsonapi.org/format/1.1/#crud-creating-client-ids)).
 * The kit never makes up a client-generated id: each rule sends the one `id`
 * returns with `create`'s payload, and runs only for the case `supported`
 * declares.
 *
 * - **`supported: true`** — `spec/status/create-client-id` creates under an
 *   `id` and wants a 201 carrying the resource under that id, or a 204 with no
 *   document; `spec/status/create-conflict-id` creates under an `id` and then
 *   sends the same payload under the same id again, and wants a 409.
 * - **`supported: false`** — `spec/status/create-client-id-unsupported`
 *   creates under an `id` and wants a 403.
 *
 * What a create under an `id` makes is the kit's like any other: vetted as a
 * created id is, recorded in {@link Report.writes} and handed to `cleanup` —
 * a 204 names no id, so the kit takes the one it sent. With
 * `supported: true`, return an id no resource holds yet, fresh per call.
 *
 * @example
 * ```ts
 * import { Conformance } from "@thomasfosterau/effect-jsonapi"
 *
 * let sequence = 0
 * const articles: Conformance.WriteFixture = {
 *   create: () => ({ type: "articles", attributes: { title: `probe ${++sequence}` } }),
 *   // the server mints its own ids, so a client-generated one must be refused with 403
 *   clientId: { supported: false, id: () => `conformance-client-${++sequence}` }
 * }
 *
 * articles.clientId?.supported // false
 * ```
 *
 * @since 0.18.0
 * @category models
 */
export interface ClientIdFixture extends Core.ClientIdFixture {}

/**
 * One resource the kit created during a run, and what became of it — the audit
 * trail {@link Report.writes} carries, so a run against a real server can be
 * checked for what it left behind.
 *
 * `disposal` is `"deleted"` when the kit's own DELETE probe — or an atomic
 * `remove` in the request that created it, confirmed by a read that no longer
 * finds it — removed it,
 * `"cleaned-up"` when the fixture's `cleanup` did, `"cleanup-failed"` when
 * `cleanup` failed (with the cause in `detail`), and `"left"` when nothing
 * removed it — no `cleanup` was supplied, the response named no id, or it
 * named one the kit would not act on. In the last two cases `id` is
 * `undefined` and `detail` says what the response named, if anything.
 *
 * @example
 * ```ts
 * import { Conformance } from "@thomasfosterau/effect-jsonapi"
 *
 * const leftBehind = (report: Conformance.Report): ReadonlyArray<Conformance.Write> =>
 *   (report.writes ?? []).filter((write) => write.disposal === "left" || write.disposal === "cleanup-failed")
 *
 * leftBehind({
 *   target: "blog",
 *   version: "1.1",
 *   transport: "in-process",
 *   outcomes: [],
 *   gaps: [],
 *   writes: [
 *     { type: "articles", id: "2", rule: "spec/status/delete-response", disposal: "deleted", detail: undefined },
 *     { type: "articles", id: "3", rule: "spec/status/create-location", disposal: "left", detail: "no cleanup" }
 *   ]
 * }).length // 1
 * ```
 *
 * @since 0.17.0
 * @category models
 */
export interface Write extends Core.WriteRecord {}

/**
 * One `ids` sample's read, as {@link Report.samples} carries it: the type and
 * id, the URL the sample resolved the type's `GET /:type/:id` endpoint to, and
 * the status that URL answered — `0` when no answer was obtained (the
 * transport failed, or a redirect was left unfollowed).
 *
 * Every sample the run read is recorded, whether or not it resolved. The
 * status is the one the run's first plain read of the URL answered (a `GET`
 * with the JSON:API `Accept` and no query). A sample no selected rule read is
 * left out rather than read for the purpose, so a run narrowed by `only`,
 * `skip` or `tiers` sends only its rules' requests. A sample that did not
 * resolve is not a {@link Gap} and fails no rule — {@link format} names it,
 * and a fixture test can assert on it.
 *
 * @example
 * ```ts
 * import { Conformance } from "@thomasfosterau/effect-jsonapi"
 *
 * const unresolved = (report: Conformance.Report): ReadonlyArray<Conformance.Sample> =>
 *   (report.samples ?? []).filter((sample) => sample.status < 200 || sample.status >= 300)
 *
 * unresolved({
 *   target: "blog",
 *   version: "1.1",
 *   transport: "in-process",
 *   outcomes: [],
 *   gaps: [],
 *   samples: [
 *     { type: "articles", id: "1", url: "/articles/1", status: 200 },
 *     { type: "people", id: "404", url: "/people/404", status: 404 }
 *   ]
 * }).length // 1
 * ```
 *
 * @since 0.17.0
 * @category models
 */
export interface Sample extends Samples.SampleRecord {}

/**
 * The result of a run: every rule's outcome, the declared coverage gaps, and
 * what was driven.
 *
 * @example
 * ```ts
 * import { Conformance } from "@thomasfosterau/effect-jsonapi"
 *
 * const report: Conformance.Report = {
 *   target: "blog",
 *   version: "1.1",
 *   transport: "in-process",
 *   outcomes: [],
 *   gaps: Conformance.gaps
 * }
 *
 * Conformance.summarise(report).failed // 0
 * ```
 *
 * @since 0.15.0
 * @category models
 */
export interface Report {
  /** A name for what was driven — the `HttpApi`'s identifier by default. */
  readonly target: string;
  /** The JSON:API version the spec tier encodes. */
  readonly version: string;
  readonly transport: "in-process" | "http";
  readonly outcomes: ReadonlyArray<Outcome>;
  readonly gaps: ReadonlyArray<Gap>;
  /**
   * Every resource the write rules created, in creation order, with what
   * became of it. Empty when no write rule ran; absent from a report built by
   * hand.
   *
   * @since 0.17.0
   */
  readonly writes?: ReadonlyArray<Write> | undefined;
  /**
   * Every `/:type/:id` read the `ids` samples resolve that the run made, in
   * discovery order, with the status it answered. A non-`2xx` one is a sample the server does
   * not hold: it fails no rule, but every rule that reads it saw less of the
   * api than the run suggests. Absent from a report built by hand.
   *
   * @since 0.17.0
   */
  readonly samples?: ReadonlyArray<Sample> | undefined;
}

/**
 * Counts over a report.
 *
 * `skipped` and `gaps` are as important as `failed`: a run with no failures and
 * twenty skips has proved very little, and the numbers say so. `errored`
 * (since 0.17.0) counts the rules that died before reaching a verdict.
 *
 * @example
 * ```ts
 * import { Conformance } from "@thomasfosterau/effect-jsonapi"
 *
 * const summary: Conformance.Summary = Conformance.summarise({
 *   target: "empty",
 *   version: "1.1",
 *   transport: "in-process",
 *   outcomes: [],
 *   gaps: []
 * })
 *
 * summary.passed // 0
 * summary.probes // 0
 * ```
 *
 * @since 0.15.0
 * @category models
 */
export interface Summary extends ReportFormat.Summary {}

/**
 * A broken rule, as an `Effect` failure: the rule's text and citation, the
 * request that decided it, and what was observed instead.
 *
 * This is what {@link assert} fails with, so a conformance gate in a test or a
 * CI step reports the rule rather than a diff.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Conformance } from "@thomasfosterau/effect-jsonapi"
 *
 * const violation = new Conformance.ContractViolation({
 *   rule: Conformance.rules.find((rule) => rule.id === "spec/document/full-linkage")!,
 *   detail: "/articles answered 1 included resource unreachable from the primary data",
 *   expected: "every `included` resource reachable through resource linkage",
 *   observed: "people:9",
 *   probe: undefined,
 *   remaining: 0
 * })
 *
 * violation._tag // "ContractViolation"
 * violation.message.startsWith("spec/document/full-linkage") // true
 * Effect.isEffect(Effect.fail(violation)) // true
 * ```
 *
 * @since 0.15.0
 * @category errors
 */
export class ContractViolation extends Schema.TaggedError<ContractViolation>()(
  "ContractViolation",
  {
    rule: Schema.Struct({
      id: Schema.String,
      tier: Schema.Literals(["spec", "profile"]),
      section: Schema.String,
      reference: Schema.String,
      level: Schema.Literals(["MUST", "MUST NOT", "SHOULD", "MAY"]),
      requirement: Schema.String,
    }),
    detail: Schema.String,
    expected: Schema.String,
    observed: Schema.String,
    probe: Schema.UndefinedOr(
      Schema.Struct({
        method: Schema.String,
        url: Schema.String,
        headers: Schema.Record(Schema.String, Schema.String),
        body: Schema.Unknown,
      }),
    ),
    /** How many further findings the report carries beyond this one. */
    remaining: Schema.Number,
  },
) {
  /**
   * The rule, its requirement and its citation, then the observation — in that
   * order, because the rule is what a reader needs first.
   *
   * @since 0.15.0
   */
  override get message(): string {
    const request =
      this.probe === undefined ? "" : `\n  request: ${this.probe.method} ${this.probe.url}`;
    const more =
      this.remaining === 0
        ? ""
        : `\n  (and ${this.remaining} further finding${this.remaining === 1 ? "" : "s"} in the report)`;
    return `${this.rule.id} — ${this.rule.level}, ${this.rule.section}
  ${this.rule.requirement}
  ${this.rule.reference}
  ${this.detail}${request}
  expected: ${this.expected}
  observed: ${this.observed}${more}`;
  }
}

/**
 * The defect {@link assert} dies with on a rule that died: the rule's id, a
 * message naming it and the defect, and the defect itself as `cause`. Private
 * on purpose — callers match it by its tag (`_tag: "RuleDied"`), not by class.
 */
class RuleDied extends Schema.TaggedError<RuleDied>()("RuleDied", {
  rule: Schema.String,
  message: Schema.String,
  cause: Schema.Unknown,
}) {}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

const implementations: ReadonlyArray<Core.RuleImpl> = [
  ...SpecRules.rules,
  ...ProfileRules.rules,
  ...SortRules.rules,
];

/**
 * Every rule the kit can check, spec tier first.
 *
 * Readable without running anything, so a consumer can see exactly what the kit
 * claims to cover — and what it does not — before adopting it.
 *
 * @example
 * ```ts
 * import { Conformance } from "@thomasfosterau/effect-jsonapi"
 *
 * const spec = Conformance.rules.filter((rule) => rule.tier === "spec")
 * const profile = Conformance.rules.filter((rule) => rule.tier === "profile")
 *
 * spec.length > profile.length // true
 * Conformance.rules.some((rule) => rule.id === "spec/content-negotiation/accept-weight-is-not-a-parameter") // true
 * ```
 *
 * @since 0.15.0
 * @category constants
 */
export const rules: ReadonlyArray<Rule> = implementations.map(
  (implementation) => implementation.rule,
);

/**
 * The areas this kit does not check, each with the reason and the issues that
 * would change it.
 *
 * Printed in every report. The list is the kit's statement of its own limits:
 * an area named here is known-uncovered, and a requirement named neither here
 * nor in {@link rules} is simply unwritten.
 *
 * @example
 * ```ts
 * import { Conformance } from "@thomasfosterau/effect-jsonapi"
 *
 * for (const gap of Conformance.gaps) {
 *   // every gap explains itself and names what would close it
 *   gap.area.length > 0 && gap.reason.length > 0 // true
 * }
 *
 * Conformance.gaps.length > 0 // true
 * ```
 *
 * @since 0.15.0
 * @category constants
 */
export const gaps: ReadonlyArray<Gap> = [
  {
    area: "The filter profile's evaluation semantics, beyond what the sample shows",
    reason:
      "`profile/filter/evaluation` executes `docs/filter-grammar.md` §6 against the server with the kit's own internal fold (#161, #433, #458): it evaluates filter trees over the collection served unfiltered and names every resource the filtered request wrongly included or excluded — on an attribute NULL on some resources, the trees that tell three-valued evaluation from two-valued (`ne` and the ordering operators over NULL, `nin`, `isnull`, `Or(x, Not(x))`); on an attribute never NULL, `lt` / `lte` / `gt` / `gte` at a pivot that splits the sample and `isnull=true` (F-CMP-2, F-ORD-1, F-ISNULL-4); on a to-one relationship, valued by the related id, equality, membership and `isnull` (F-EVAL-4, F-ORD-5); a filter beside a sparse fieldset (F-EVAL-6); the empty groups (F-AND-2); and the corollaries — De Morgan both ways, `Not(In)`, `Not(Not(x))`, one canonical form in a second spelling (F-CONS-2 to F-CONS-4, F-CONS-7), `included` beside a filter (F-CONS-6), and a filtered response's shape (F-CONS-5). It infers the comparison domain (F-ORD-1) from the JSON type the server answered, so it can only probe what the sample holds: F-ORD-2's exact string comparison (no case folding, collation or normalisation) and F-ORD-3's sub-millisecond precision are tested only as far as the values the server holds exercise them, and a relationship that shows no linkage has no value to read. The corollaries are probed one way each: F-CONS-5 holds each answered resource to its unfiltered representation and an empty result to a 200 collection document, not the top-level `meta` and `links`, which may rightly carry the query or a count; F-CONS-6 follows one relationship, one level deep; F-CONS-7 respells ids, key order and member order, not a literal (F-COERCE-4). Not probed at all: the refusals F-ERR-4 and F-ERR-5.",
    tracking: ["#116", "#161", "#433", "#458"],
  },
  {
    area: "Relationship writes beyond the read-back",
    reason:
      "Given a `writes` fixture and `mutating: true`, the kit checks what a create, update and delete answer, the 409s for an unserved `type` and a duplicate client-generated id, what a create under a client-generated id answers (201 or 204, or 403 where unsupported — only for a type whose fixture opts in with `clientId`, since the kit never makes an id up), and that a create, an update and a `PATCH` / `POST` / `DELETE` on `/relationships/…` read back as they should. A relationship write is judged by its read-back alone: what the write itself answers (202, 204, or 200 with the linkage as it now stands) is not checked, nor is a to-one replacement with `null`, nor the 404 for linking a resource that does not exist.",
    tracking: ["#451"],
  },
  {
    area: "The Idempotency-Key profile",
    reason:
      "This package publishes a second profile (`Idempotency.PROFILE_URI`, normative in `docs/idempotency.md`). The profile tier checks its advertisement (§1): given a `writes` fixture and `mutating: true`, a create or an update on an endpoint declaring `Idempotency-Key` must answer with the profile URI in `jsonapi.profile` or on its media type. Delete endpoints (usually a 204, with no document to name it in) and the atomic operations endpoint are not checked. What a *retried* write does is not checked either: replay of the recorded response, the fingerprint mismatch conflict, the in-flight case and the scope of a key. Each needs the kit to resend a request it has already sent, byte for byte, which neither the write fixture (#162) nor the kit yet provides.",
    tracking: ["#123", "#162", "#165"],
  },
  {
    area: "Concerns outside JSON:API",
    reason:
      "Authentication, authorisation, caching and conditional requests, rate limiting and CORS. JSON:API takes no position on any of them, so neither does this kit.",
    tracking: [],
  },
];

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * How a run is configured.
 *
 * `ids` is the read fixture contract, and it is deliberately the smallest one
 * that works: one id per resource type that is known to exist, so a rule can
 * turn `/articles/:id` into a URL. `writes` is the write fixture contract
 * ({@link WriteFixture}): a payload per type the server will accept, so the
 * write rules can create a disposable target, and how to remove it afterwards.
 * A rule with no id or fixture to use reports `Skipped` naming the key it
 * wanted rather than quietly passing.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Conformance } from "@thomasfosterau/effect-jsonapi"
 *
 * const created = new Set<string>()
 *
 * const options: Conformance.Options = {
 *   // one known-existing id per resource type
 *   ids: { articles: "1", people: "9" },
 *   // an explicit URL for an endpoint whose path the conventions don't cover
 *   paths: { "search.search": "/search?filter[q]=bikeshed" },
 *   // the spec tier only — don't hold the target to this package's profile
 *   tiers: ["spec"],
 *   // opt in to the rules that write, against targets made from this fixture
 *   mutating: true,
 *   writes: {
 *     articles: {
 *       create: () => ({ type: "articles", attributes: { title: "conformance probe", body: "…" } }),
 *       cleanup: (id) => Effect.sync(() => created.delete(id))
 *     }
 *   }
 * }
 *
 * options.tiers?.includes("spec") // true
 * options.writes?.["articles"]?.update === undefined // true — the update rule skips
 * ```
 *
 * @since 0.15.0
 * @category models
 */
export interface Options {
  /**
   * A known-existing id per resource type, keyed by the type name — which under
   * the conventional paths is the first literal path segment.
   */
  readonly ids?: Readonly<Record<string, string>> | undefined;
  /**
   * An explicit URL path for an endpoint, keyed `"<group>.<endpoint>"`, for
   * paths the `ids` convention cannot resolve (several path parameters, or a
   * path that does not begin with the resource type).
   */
  readonly paths?: Readonly<Record<string, string>> | undefined;
  /**
   * An id the target is known *not* to have, used to probe the 404 rules.
   * Defaults to a value no realistic fixture would use.
   */
  readonly absentId?: string | undefined;
  /**
   * Extension URIs the target advertises support for. Only affects which `ext`
   * URI the kit treats as unsupported when probing negotiation.
   */
  readonly extensions?: ReadonlyArray<string> | undefined;
  /**
   * Run the rules whose probes change the target's state. Off by default: a
   * conformance run should be safe to point at a live server. The write rules
   * also need a {@link WriteFixture} per type in `writes`.
   */
  readonly mutating?: boolean | undefined;
  /**
   * The write fixture per resource type, keyed like `ids`: a payload to create
   * a disposable target with, an update to apply to it, and how to remove it.
   * A type with no entry skips its write rules, naming the key it wanted.
   *
   * @since 0.17.0
   */
  readonly writes?: Readonly<Record<string, WriteFixture>> | undefined;
  /** Which tiers to run. Defaults to both. */
  readonly tiers?: ReadonlyArray<Tier> | undefined;
  /**
   * Run only these rule ids. Each entry matches by path segment: the rule
   * with that id, and every rule whose id continues it with `/`. So
   * `["spec/content-negotiation"]` (or `["spec/content-negotiation/"]`)
   * selects that whole section, `["spec/status/create-location"]` that rule
   * alone — not `spec/status/create-location-matches-self` — and a partial
   * segment such as `["spec/content-neg"]` nothing. A rule it does not select
   * is left out of the run and out of the report.
   */
  readonly only?: ReadonlyArray<string> | undefined;
  /**
   * Leave out these rule ids — the complement of `only`, matched the same
   * way, by path segment: an entry matches the rule with that id and every
   * rule whose id continues it with `/`, so `["spec/links/"]` (or
   * `["spec/links"]`) leaves out the link crawl,
   * `["spec/pagination/links-enumerate-collection"]` the pagination walk, and
   * `["spec/status/create-location"]` that rule alone, keeping
   * `spec/status/create-location-matches-self`. It applies after `tiers` and
   * `only`, so it removes rules from what they select, and a rule both name
   * is left out. A rule it leaves out is left out
   * of the run and out of the report, as one `only` does not select is.
   *
   * @since 0.17.0
   */
  readonly skip?: ReadonlyArray<string> | undefined;
  /**
   * The longest the kit waits for one request to be answered and its body
   * read, as any `Duration.Input` (`"5 seconds"`, `Duration.seconds(5)`, a
   * number of milliseconds). A request still unanswered then is interrupted —
   * over `fetch`, aborted — and reads as a lost response: no status, with a
   * transport error naming the timeout, which every rule treats as it treats
   * any transport failure. Each redirect hop the kit follows is a request with
   * a timeout of its own; a client's own `retry` runs within one.
   *
   * Defaults to thirty seconds, for `verify` and `verifyWith` alike.
   * `"Infinity"` (or `Duration.infinity`) turns it off: the kit then waits as
   * long as the transport does, so a server that holds a response open holds
   * the run. A duration that is not positive — zero, negative or `NaN` — or
   * one `Duration` cannot read (e.g. `"1e3 seconds"`) is a defect: the run
   * dies before it sends a request.
   *
   * @since 0.17.0
   */
  readonly requestTimeout?: Duration.Input | undefined;
  /** A name for the report's header. Defaults to the `HttpApi`'s identifier. */
  readonly target?: string | undefined;
}

const DEFAULT_ABSENT_ID = "conformance-absent-id-0000";

const resolveOptions = (
  baseUrl: string,
  options: Options,
  requestTimeout: Option.Option<Duration.Duration>,
): Core.ResolvedOptions => ({
  baseUrl,
  ids: options.ids ?? {},
  paths: options.paths ?? {},
  absentId: options.absentId ?? DEFAULT_ABSENT_ID,
  extensions: options.extensions ?? [],
  mutating: options.mutating ?? false,
  writes: options.writes ?? {},
  requestTimeout,
});

const selected = (options: Options | undefined): ReadonlyArray<Core.RuleImpl> => {
  const tiers = options?.tiers;
  const only = options?.only;
  const skip = options?.skip ?? [];
  // By segment: a prefix is the id itself, or the id continues it with `/`
  // (#367), so `spec/status/create-location` never reaches
  // `spec/status/create-location-matches-self`.
  const matches = (prefixes: ReadonlyArray<string>, id: string): boolean =>
    prefixes.some(
      (prefix) => id === prefix || id.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`),
    );
  return implementations.filter((implementation) => {
    const { id, tier } = implementation.rule;
    if (tiers !== undefined && !tiers.includes(tier)) return false;
    if (only !== undefined && !matches(only, id)) return false;
    return !matches(skip, id);
  });
};

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

const IN_PROCESS_ORIGIN = "http://conformance.invalid";

const execute = (
  api: HttpApi.HttpApi<string, any>,
  client: HttpClient.HttpClient,
  transport: Report["transport"],
  baseUrl: string,
  options: Options | undefined,
): Effect.Effect<Report> =>
  Effect.gen(function* () {
    const resolved = resolveOptions(
      baseUrl,
      options ?? {},
      yield* Core.requestTimeoutOf(Option.fromUndefinedOr(options?.requestTimeout)),
    );
    const observed = MutableHashSet.empty<string>();
    const writes: Core.Context["writes"] = [];
    const endpoints = Core.discover(api);
    const ledger = Samples.ledger(endpoints, resolved);
    const ctx: Core.Context = {
      endpoints,
      options: resolved,
      request: Samples.recording(
        Core.observing(
          Core.runner(client, resolved.baseUrl, resolved.requestTimeout),
          observed,
          writes,
        ),
        ledger,
      ),
      writes,
      observed,
    };
    // Every rule that creates nothing (the profile tier's included) runs
    // before the first rule that creates, so a create is vetted against
    // everything the run reads (`Context.observed` in
    // `./internal/conformance/core.ts`). Each outcome carries its rule's
    // position in the suite, so the report keeps the suite's order.
    const chosen = Arr.map(selected(options), (implementation, index) => ({
      implementation,
      index,
    }));
    const ran = yield* Effect.forEach(
      [
        ...Arr.filter(chosen, ({ implementation }) => implementation.creates !== true),
        ...Arr.filter(chosen, ({ implementation }) => implementation.creates === true),
      ],
      ({ implementation, index }) =>
        Effect.map(Core.runRule(implementation, ctx), (outcome) => ({ outcome, index })),
      { concurrency: 1 },
    );
    const outcomes = Arr.map(
      Arr.sortWith(ran, ({ index }) => index, Order.Number),
      ({ outcome }) => outcome,
    );
    return {
      target: options?.target ?? api.identifier,
      version: "1.1",
      transport,
      outcomes,
      gaps,
      writes: WriteFixtures.snapshot(ctx),
      samples: Samples.snapshot(ledger),
    };
  });

/**
 * Drives an `HttpApi` through the conformance rules in-process and returns the
 * report.
 *
 * Handlers are taken from the ambient context exactly as `HttpApiTest.groups`
 * takes them, so a run is the api's own handler layers plus
 * `Middleware.layer` — the same wiring the server uses. The transport is an
 * in-memory `HttpClient` over the real router, so requests go through request
 * decoding, routing, middleware, the handler and response encoding, and the
 * rules observe raw statuses, media types and bodies. No port is bound.
 * Each request has {@link Options.requestTimeout} (thirty seconds unless the
 * run says otherwise) to be answered; a request it cuts short reads as a lost
 * response.
 *
 * Use {@link verifyWith} to run the identical rules against a deployed server.
 *
 * @example
 * ```ts
 * import { Effect, Layer, Schema } from "effect"
 * import { HttpApi, HttpApiBuilder } from "effect/http-api"
 * import {
 *   Conformance,
 *   Endpoint,
 *   Group,
 *   Handlers,
 *   Middleware,
 *   Resource
 * } from "@thomasfosterau/effect-jsonapi"
 *
 * const Tag = Resource.make("tags", { attributes: { name: Schema.NonEmptyString } })
 *
 * const api = HttpApi.make("tags").add(Group.make(Tag, Endpoint.list(Tag)))
 *
 * const TagsLive = HttpApiBuilder.group(api, "tags", (handlers) =>
 *   handlers.handle("list", () =>
 *     Effect.succeed(
 *       Handlers.collection([
 *         Tag.make({ id: Tag.Id.make("1"), attributes: { name: "api-design" } })
 *       ])
 *     )))
 *
 * const program = Conformance.verify(api, { tiers: ["spec"] }).pipe(
 *   Effect.tap((report) => Effect.sync(() => Conformance.format(report))),
 *   Effect.provide(TagsLive.pipe(Layer.provideMerge(Middleware.layer))),
 *   Effect.scoped
 * )
 *
 * Effect.isEffect(program) // true
 * ```
 *
 * @since 0.15.0
 * @category constructors
 */
export const verify = Effect.fnUntraced(function* <
  ApiId extends string,
  Groups extends HttpApiGroup.Constraint,
>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  options?: Options,
): Effect.fn.Return<
  Report,
  never,
  | HttpApiGroup.ToService<ApiId, Groups>
  | HttpApiGroup.MiddlewareClient<Groups>
  | HttpApiEndpoint.Middleware<HttpApiGroup.Endpoints<Groups>>
  | FileSystem
  | Etag.Generator
  | HttpPlatform
  | Path
  | Scope
> {
  // The handler layers come from the ambient context, exactly as
  // `HttpApiTest.groups` takes them, so a run drives the api's real wiring.
  const context = yield* Effect.context<HttpApiGroup.ToService<ApiId, Groups>>();
  const handler = yield* HttpRouter.toHttpEffect(
    HttpApiBuilder.layer(api).pipe(
      Layer.provide(Layer.succeedContext(context)),
    ) as unknown as Layer.Layer<never, never, HttpRouter.HttpRouter>,
  );
  const client = HttpClient.make(
    Effect.fnUntraced(function* (request) {
      const serverRequest = HttpServerRequest.fromClientRequest(request);
      // A path no route serves is the router's 404, as a deployed server
      // answers it, not a defect that kills the rule that requested it (a
      // link the server emitted, say). Any other failure, and any defect,
      // still dies, as a transport that throws does.
      const response = yield* Core.answeredAsDeployed(
        Effect.provideService(handler, HttpServerRequest.HttpServerRequest, serverRequest),
      );
      return HttpServerResponse.toClientResponse(response);
    }, Effect.scoped),
  );
  return yield* execute(
    api as HttpApi.HttpApi<string, any>,
    client,
    "in-process",
    IN_PROCESS_ORIGIN,
    options,
  );
});

/**
 * Runs the conformance rules over a transport you supply — a deployed server
 * behind `FetchHttpClient`, a proxy, a recorded client.
 *
 * The `HttpApi` is still required, and is still only read: it is how the kit
 * discovers the endpoints, their declared query families and their response
 * media types. Nothing about the rules changes between here and
 * {@link verify} — which is the point, since the two answers to "in-process or
 * over the wire?" should not be two different kits.
 *
 * The kit follows a redirect only when its `Location` stays on `baseUrl`'s
 * origin (scheme, host and port), at most five hops for one request, each
 * counted against a rule's request budget, and grades the final answer. It
 * checks each hop before requesting it, so, given a client that does not
 * follow redirects itself, it never sends a request to another origin on a
 * server's say-so: a redirect it does not follow leaves the request with no
 * answer to read, and `spec/target/reachable` reports a read endpoint that
 * answers with one — point `baseUrl` at the URL that serves, shorten a chain on
 * its origin longer than the cap, or fix a `Location` that does not parse. To
 * keep the transport
 * from following a redirect itself, the kit provides
 * `FetchHttpClient.RequestInit` with `redirect: "manual"` for its own
 * requests, over the rest of the `RequestInit` the run's context holds. A
 * `RequestInit` given only to the client's layer
 * (`FetchHttpClient.layer.pipe(Layer.provide(…))`) is replaced for the kit's
 * requests, so give it to the run instead. A client that follows redirects by
 * other means (`HttpClient.followRedirects`) still sends the request. The kit
 * reads neither the answer nor the transport error such a client ends in on
 * another origin than it sent the request to, or after turning the method
 * into a `GET`, and a rule that sent the request is not decided by it, as for
 * any redirect the kit does not follow; but only the final URL and method are
 * checked, so a chain off the origin and back is read, and the request has
 * been made either way — pass a client that does not follow redirects. A
 * client that only rewrites each request (`HttpClient.mapRequest` onto
 * another origin, say) follows nothing, and is read as any other: the kit
 * runs each request through it as its `execute` does, so its `retry` still
 * re-prepares a request, and a `Location` on the origin it sends to is
 * followed as one on the base URL's.
 * Each request has {@link Options.requestTimeout} (thirty seconds unless the
 * run says otherwise) to be answered; a request it cuts short reads as a lost
 * response.
 *
 * @example
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { FetchHttpClient, HttpClient } from "effect/http"
 * import { HttpApi } from "effect/http-api"
 * import { Conformance, Endpoint, Group, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString }
 * })
 *
 * const api = HttpApi.make("blog").add(Group.make(Article, Endpoint.list(Article)))
 *
 * // the identical rules, against whatever is serving that base URL
 * const program = Effect.gen(function* () {
 *   const client = yield* HttpClient.HttpClient
 *   return yield* Conformance.verifyWith(api, {
 *     client,
 *     baseUrl: "https://api.example.com",
 *     ids: { articles: "1" },
 *     // a live server: give up on a request after ten seconds, not thirty…
 *     requestTimeout: "10 seconds",
 *     // …and leave out the rules that walk its collections and crawl its links
 *     skip: ["spec/pagination/links-enumerate-collection", "spec/links/"]
 *   })
 * }).pipe(Effect.provide(FetchHttpClient.layer))
 *
 * Effect.isEffect(program) // true
 * ```
 *
 * @since 0.15.0
 * @category constructors
 */
export const verifyWith = <ApiId extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  options: Options & {
    readonly client: HttpClient.HttpClient;
    /** The origin every probe is sent to. */
    readonly baseUrl: string;
  },
): Effect.Effect<Report> =>
  execute(api as HttpApi.HttpApi<string, any>, options.client, "http", options.baseUrl, options);

// ---------------------------------------------------------------------------
// Reading a report
// ---------------------------------------------------------------------------

/**
 * Renders a report as text: each tier's rules that died first (marked `DIED`,
 * with the defect's message), then its failures with the rule, its citation and
 * the request that decided it, then the rules that passed, then the rules that
 * did not run and why, then the `ids` samples that answered non-`2xx` (only when
 * one did, from {@link Report.samples}), then the declared coverage gaps and a
 * summary line. The count of rules that died appears in the tier and summary
 * lines only when one did.
 *
 * The three "not checked" kinds stay distinct on purpose. A rule can be absent
 * because this api has no endpoint of that shape, because the caller withheld a
 * sample id, or because the kit does not implement it at all — and a reader who
 * cannot tell those apart does not know what the run proved.
 *
 * @example
 * ```ts
 * import { Conformance } from "@thomasfosterau/effect-jsonapi"
 *
 * const rule = Conformance.rules.find((candidate) => candidate.id === "spec/document/top-level-members")!
 *
 * const text = Conformance.format({
 *   target: "blog",
 *   version: "1.1",
 *   transport: "in-process",
 *   outcomes: [
 *     { _tag: "Passed", rule, probes: 3, note: undefined },
 *     {
 *       _tag: "Skipped",
 *       rule: Conformance.rules.find((candidate) => candidate.id === "spec/status/delete-response")!,
 *       reason: "mutating probe — pass `mutating: true` to run it against a disposable target"
 *     }
 *   ],
 *   gaps: Conformance.gaps
 * })
 *
 * text.includes("NOT COVERED BY THIS KIT") // true
 * text.includes("not checked: mutating probe") // true
 * ```
 *
 * @since 0.15.0
 * @category accessors
 */
export const format = (report: Report, options?: { readonly width?: number | undefined }): string =>
  ReportFormat.format(report, options);

/**
 * Counts a report's outcomes.
 *
 * @example
 * ```ts
 * import { Conformance } from "@thomasfosterau/effect-jsonapi"
 *
 * const rule = Conformance.rules[0]!
 *
 * const summary = Conformance.summarise({
 *   target: "t",
 *   version: "1.1",
 *   transport: "in-process",
 *   outcomes: [{ _tag: "Skipped", rule, reason: "no endpoint of that shape" }],
 *   gaps: []
 * })
 *
 * summary.skipped // 1
 * summary.failed // 0
 * ```
 *
 * @since 0.15.0
 * @category accessors
 */
export const summarise = (report: Report): Summary => ReportFormat.summarise(report.outcomes);

/**
 * Every finding in a report, flattened across rules — failures in declaration
 * order, which is spec-section order.
 *
 * @example
 * ```ts
 * import { Conformance } from "@thomasfosterau/effect-jsonapi"
 *
 * const rule = Conformance.rules[0]!
 *
 * const found = Conformance.findings({
 *   target: "t",
 *   version: "1.1",
 *   transport: "in-process",
 *   outcomes: [
 *     {
 *       _tag: "Failed",
 *       rule,
 *       probes: 1,
 *       findings: [
 *         { rule, detail: "d", expected: "e", observed: "o", probe: undefined }
 *       ]
 *     }
 *   ],
 *   gaps: []
 * })
 *
 * found.length // 1
 * found[0]?.rule.id === rule.id // true
 * ```
 *
 * @since 0.15.0
 * @category accessors
 */
export const findings = (report: Report): ReadonlyArray<Finding> =>
  report.outcomes.flatMap((outcome) => (outcome._tag === "Failed" ? outcome.findings : []));

/**
 * Fails with the report's first {@link ContractViolation}, or succeeds with the
 * report when nothing was broken — the conformance gate for a test or a CI step.
 *
 * Only failures fail it. Skipped rules do not, because a skip is a statement
 * about coverage rather than about conformance; read {@link summarise} or print
 * {@link format} if a run must also prove it checked enough.
 *
 * A rule that died (`Errored`) is neither: the run could not decide it, so the
 * gate cannot pass, and it is not a finding about the server, so it is not a
 * `ContractViolation`. `assert` dies on the first one instead — before looking
 * at failures — with a tagged defect, `_tag: "RuleDied"` (match it with
 * `Predicate.isTagged(defect, "RuleDied")`), whose `rule` is the rule's id,
 * whose message names the rule and the defect's, and whose `cause` is the
 * original defect. That keeps the gate as strict as when a rule's defect
 * killed the whole run, while the report itself stays readable. Its `message`
 * is always rendered, but its `cause` holds the defect as it was thrown, so a
 * reporter that pretty-prints the cause can itself throw on a defect that
 * cannot be inspected (a revoked `Proxy`, say).
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Conformance } from "@thomasfosterau/effect-jsonapi"
 *
 * const clean: Conformance.Report = {
 *   target: "t",
 *   version: "1.1",
 *   transport: "in-process",
 *   outcomes: [],
 *   gaps: []
 * }
 *
 * // succeeds, yielding the report back
 * Effect.runSync(Conformance.assert(clean)).target // "t"
 *
 * const rule = Conformance.rules[0]!
 * const broken: Conformance.Report = {
 *   ...clean,
 *   outcomes: [
 *     {
 *       _tag: "Failed",
 *       rule,
 *       probes: 1,
 *       findings: [
 *         { rule, detail: "a 406 was returned", expected: "200", observed: "406", probe: undefined }
 *       ]
 *     }
 *   ]
 * }
 *
 * const exit = Effect.runSyncExit(Conformance.assert(broken))
 * exit._tag // "Failure"
 * ```
 *
 * @since 0.15.0
 * @category combinators
 */
export const assert = (report: Report): Effect.Effect<Report, ContractViolation> =>
  Option.match(
    Arr.findFirst(report.outcomes, (outcome) =>
      Predicate.isTagged(outcome, "Errored") ? Option.some(outcome) : Option.none(),
    ),
    {
      onSome: (died) =>
        Effect.die(
          new RuleDied({
            rule: died.rule.id,
            message: `${died.rule.id} died: ${died.message}`,
            cause: died.defect,
          }),
        ),
      onNone: () => {
        const all = findings(report);
        const first = all[0];
        if (first === undefined) return Effect.succeed(report);
        return Effect.fail(
          new ContractViolation({
            rule: first.rule,
            detail: first.detail,
            expected: first.expected,
            observed: first.observed,
            probe: first.probe,
            remaining: all.length - 1,
          }),
        );
      },
    },
  );
