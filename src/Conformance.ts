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
 * The `profile` tier is this package's filter grammar profile and the
 * conventions the library takes a position on where the spec declines to — so a
 * consumer can run the first without adopting the second ({@link Options.tiers}).
 *
 * **The report states what it did not check.** Every rule that could not run
 * reports why, and {@link gaps} declares the areas the kit does not cover at
 * all. A kit that answers "OK" without saying what it checked is worse than
 * nothing, so {@link format} always prints all three sections.
 *
 * **Writes are opt-in and disposable.** The rules that change state run only
 * with `mutating: true` and a {@link WriteFixture} per type in `writes`. They
 * act only on the id the server's create response named, after checking it
 * names a resource of the type the kit sent and is neither an `ids` sample nor
 * an id the run already holds; they dispose of each resource however the rule
 * ended, and list every one in {@link Report.writes}.
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
import { Data, Effect, Layer } from "effect";
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
import * as SpecRules from "./internal/conformance/spec.js";
import * as WriteFixtures from "./internal/conformance/write.js";

// ---------------------------------------------------------------------------
// The rule model
// ---------------------------------------------------------------------------

/**
 * Which body of requirements a rule comes from: `"spec"` is JSON:API v1.1
 * itself, `"profile"` is this package's filter grammar profile and the
 * conventions it adds where the spec declines to have an opinion.
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
 * made, `Failed` with its findings, or `Skipped` with the reason it could not
 * be decided against this target.
 *
 * `Skipped` is load-bearing. A rule that needs a write endpoint against an api
 * that has none, or a sample id the caller did not supply, must not be counted
 * as a pass — the report says so and names what was missing.
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
 *
 * Every member is optional, and each one gates only its own rules: a type with
 * no `create` skips every write rule naming `writes["<type>"].create`, and a
 * create-only type supplies no `update` and skips only the update rule.
 * **`cleanup` is optional too**, for a target known to be disposable — an
 * in-process store a test throws away. Without it the kit leaves what it
 * created in place and says so in {@link Report.writes}, so never omit it
 * against a server whose state outlives the run.
 *
 * The write rules run only when {@link Options.mutating} is `true`, and act
 * only on the id the server's create response named, after checking it: the
 * response must name a resource of the type `create` returned, under an id
 * that is not an `ids` sample and not one the run already holds a resource for
 * that has not been removed. Any other id is recorded as named and never
 * updated, deleted or passed to `cleanup`. A create answered with anything but
 * a 2xx is taken to have created nothing, so nothing is recorded or cleaned up
 * for it.
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
 * One resource the kit created during a run, and what became of it — the audit
 * trail {@link Report.writes} carries, so a run against a real server can be
 * checked for what it left behind.
 *
 * `disposal` is `"deleted"` when the kit's own DELETE probe removed it,
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
}

/**
 * Counts over a report.
 *
 * `skipped` and `gaps` are as important as `failed`: a run with no failures and
 * twenty skips has proved very little, and the numbers say so.
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
export class ContractViolation extends Data.TaggedError("ContractViolation")<{
  readonly rule: Rule;
  readonly detail: string;
  readonly expected: string;
  readonly observed: string;
  readonly probe: Probe | undefined;
  /** How many further findings the report carries beyond this one. */
  readonly remaining: number;
}> {
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

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

const implementations: ReadonlyArray<Core.RuleImpl> = [...SpecRules.rules, ...ProfileRules.rules];

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
    area: "The filter profile's evaluation semantics",
    reason:
      "The profile's syntax, closed operator core, canonical form, error pointers and advertisement are checked; what a tree *means* is not. #116 has since supplied the normative tables — `docs/filter-grammar.md` §6, rule-identified F-EVAL-*, F-CMP-*, F-IN-*, F-LOGIC-*, F-ISNULL-* — and deliberately ships no reference evaluator, assigning the executable oracle to this kit instead. The remaining work is a fold over the AST implementing §6.3, run against the unfiltered collection's JSON (which a probe already has, per F-ORD-1's JSON-representation domain) and compared against what the filtered request returned. Open first: whether that evaluator is public API — #116's \"shared building block\" — or stays internal to the kit.",
    tracking: ["#116", "#120"],
  },
  {
    area: "Pagination link correctness",
    reason:
      "That `first` / `prev` / `next` / `last` are present and well-formed is checkable; that following them enumerates the collection exactly once, with no gap or repeat, requires knowing the full set the server is paging over.",
    tracking: [],
  },
  {
    area: "Sort ordering correctness",
    reason:
      "A `sort` field the server does not support must be a 400, and that is checked. Whether `?sort=-createdAt` actually orders the collection, and where NULLs land, requires known data. Note the filter profile's §6.2 ordering rules govern `filter` comparison only — `sort` ordering is still unspecified, so there is no normative text to check against yet.",
    tracking: [],
  },
  {
    area: "Write semantics beyond the success responses",
    reason:
      "Given a `writes` fixture and `mutating: true`, the kit checks what a successful create, update and delete answer — the status, the primary data, `Location` — on resources it creates and disposes of itself. Still unchecked: the 409 Conflict rules (a `type` the endpoint does not serve, a duplicate client-generated id), creation with a client-generated id (201 or 204), relationship mutation through `/relationships/…` (replacement, append, removal), and whether a write was actually stored, which needs the resource read back. The fixture makes each of these probe-able; they are not yet written.",
    tracking: ["#237"],
  },
  {
    area: "Atomic operations processing",
    reason:
      "The request document's shape is checked, and — given a `writes` fixture — that an `add` is answered under the extension's media type. `lid` resolution across operations, all-or-nothing application and `atomic:results` ordering need operations applied and what was stored then observed, and all-or-nothing also needs a deliberately-invalid operation the fixture does not supply.",
    tracking: ["#164"],
  },
  {
    area: "The Idempotency-Key profile",
    reason:
      "This package publishes a second profile (`Idempotency.PROFILE_URI`, normative in `docs/idempotency.md`), and the profile tier does not check it at all — it covers the filter grammar and two library conventions only. Its rules are almost entirely about what a *retried write* does (replay of the recorded response, the fingerprint mismatch conflict, the in-flight case), so beyond the `writes` fixture they need a way to replay a request the kit has already sent. Its one non-mutating rule — that a write endpoint declaring the header advertises the profile on its response media type — is checkable today and simply not yet written.",
    tracking: ["#123", "#165"],
  },
  {
    area: "Link dereferenceability",
    reason:
      "That a document's `self` and `related` links are well-formed is checkable; that each resolves to the resource it claims is a second crawl the kit does not perform.",
    tracking: [],
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
   * Run only these rule ids. A prefix matches every rule beneath it, so
   * `["spec/content-negotiation"]` selects that whole section.
   */
  readonly only?: ReadonlyArray<string> | undefined;
  /** A name for the report's header. Defaults to the `HttpApi`'s identifier. */
  readonly target?: string | undefined;
}

const DEFAULT_ABSENT_ID = "conformance-absent-id-0000";

const resolveOptions = (baseUrl: string, options: Options | undefined): Core.ResolvedOptions => ({
  baseUrl,
  ids: options?.ids ?? {},
  paths: options?.paths ?? {},
  absentId: options?.absentId ?? DEFAULT_ABSENT_ID,
  extensions: options?.extensions ?? [],
  mutating: options?.mutating ?? false,
  writes: options?.writes ?? {},
});

const selected = (options: Options | undefined): ReadonlyArray<Core.RuleImpl> => {
  const tiers = options?.tiers;
  const only = options?.only;
  return implementations.filter((implementation) => {
    if (tiers !== undefined && !tiers.includes(implementation.rule.tier)) return false;
    if (only !== undefined && !only.some((prefix) => implementation.rule.id.startsWith(prefix)))
      return false;
    return true;
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
    const resolved = resolveOptions(baseUrl, options);
    const ctx: Core.Context = {
      endpoints: Core.discover(api),
      options: resolved,
      request: Core.runner(client, resolved.baseUrl),
      writes: [],
    };
    const outcomes: Array<Outcome> = [];
    for (const implementation of selected(options)) {
      outcomes.push(yield* implementation.run(ctx));
    }
    return {
      target: options?.target ?? api.identifier,
      version: "1.1",
      transport,
      outcomes,
      gaps,
      writes: WriteFixtures.snapshot(ctx),
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
      const response = yield* handler.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, serverRequest),
        Effect.orDie,
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
 *     ids: { articles: "1" }
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
 * Renders a report as text: each tier's failures first with the rule, its
 * citation and the request that decided it, then the rules that passed, then the
 * rules that did not run and why, then the declared coverage gaps and a summary
 * line.
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
export const assert = (report: Report): Effect.Effect<Report, ContractViolation> => {
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
};
