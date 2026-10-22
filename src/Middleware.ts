/**
 * JSON:API protocol middleware.
 *
 * Three `HttpApiMiddleware` services enforce the parts of the spec that live
 * outside schemas:
 *
 *   - {@link ContentNegotiation} — JSON:API §5 content negotiation:
 *       - a request `Content-Type: application/vnd.api+json` carrying media
 *         type parameters other than `ext` / `profile` (or unsupported
 *         extension URIs) → 415 Unsupported Media Type
 *       - an `Accept` header in which every instance of the JSON:API media
 *         type carries such parameters or is weighted `q=0` → 406 Not
 *         Acceptable (the `q` weight itself is not a media type parameter,
 *         per RFC 9110 §12.4.2, so it never counts against the whitelist; a
 *         malformed `q` counts as the default weight, so it never causes a
 *         406 on its own)
 *   - {@link SchemaErrors} — converts request validation failures (malformed
 *     query parameters, payloads, path parameters) into spec-compliant
 *     JSON:API 400 error documents instead of the default HttpApi error shape:
 *     an error object per reported issue, each with a `detail` and a `source`
 *     naming the offending `parameter` (`filter[age][gt]`, `page[limit]`),
 *     `pointer` (`/data/attributes/title`) or `header`. HttpApi decodes each
 *     request part with the default parse options (`errors: "first"`), so a
 *     part yields one error object — except the `filter` family, whose codec
 *     reports every offending key together. A create or update whose
 *     resource object names a `type` the endpoint does not serve is the
 *     exception, answered with 409 Conflict naming `/data/type`
 *     (§Creating Resources; §Updating Resources). It also rejects, with a 400
 *     naming it, a query parameter whose family base name is made only of
 *     a-z and that neither the specification defines nor the endpoint
 *     declares (JSON:API 1.1 §Query Parameters), and a parameter of one of
 *     the specification's own families — `include`, `fields[TYPE]`, `sort`,
 *     `page[…]`, `filter[…]` — on an endpoint that does not declare it, or
 *     declares it with an empty vocabulary, or a `page` / `filter` member
 *     the endpoint does not declare beside members it does, or a bracketed
 *     `include[…]` / `sort[…]`, which the specification does not define
 *     (§Inclusion of Related Resources; §Sorting on a collection endpoint;
 *     the general §Implementation-Specific Query Parameters rule otherwise;
 *     see {@link checkQueryParameters}). On the way out it re-checks full
 *     linkage (§Compound Documents) on the document the endpoint encoded,
 *     answering a violation with a JSON:API 500 (see {@link SchemaErrorsLive}).
 *   - {@link CreatedLocation} — JSON:API §Creating Resources: a 201 create
 *     answers with a `Location` header copied from the created resource's
 *     `self` link.
 *
 * The first two are attached automatically by every `Endpoint` constructor
 * and the third by `Endpoint.create`, so any `HttpApi` containing JSON:API
 * endpoints will fail to build (at the type level) until {@link layer} is
 * provided — compliance cannot be forgotten.
 *
 * The first two are also usable **outside** those constructors, for hosts that own the
 * URL themselves: {@link negotiate} runs the §5 rules over plain headers and
 * {@link schemaError} builds the request-validation 400 (and
 * {@link schemaErrorDocument} the source-bearing document from the decoding
 * failure itself), both rendered with `ApiError.toDocument`. And for an api
 * built from the constructors whose host has already negotiated,
 * {@link layerHostNegotiated} satisfies the endpoints' negotiation
 * requirement without running §5 twice. {@link checkQueryParameters} is the
 * reserved-query-parameter rule standalone.
 *
 * ## Tracing
 *
 * The live {@link ContentNegotiationLive} and {@link SchemaErrorsLive}
 * implementations wrap their per-request decisions in `Effect.withSpan`,
 * under the stable names collected in {@link Span}. This is the package's
 * whole tracing surface: everything else it exports is either a plain schema
 * or a synchronous helper with no Effect to attach a span to (see
 * {@link https://github.com/thomasfosterau/effect-jsonapi/issues/122 #122}
 * for why the boundary stops here).
 *
 * Spans need no layer or configuration to appear — `Effect.withSpan` reads
 * whatever `Tracer` is already in context and is a no-op when none is
 * provided, so a host with no tracing set up pays no cost and sees no
 * behavior change. Attributes are deliberately low-cardinality (an outcome,
 * a rule name, a request part) and never carry a header value, a filter
 * literal, a URL, or anything else that varies per request or could identify
 * a user — see each span's documentation under {@link Span}.
 *
 * @since 0.1.0
 */
import {
  Array as Arr,
  Context,
  Effect,
  ErrorReporter,
  Layer,
  Option,
  Record as Rec,
  Schema,
  SchemaAST,
  SchemaIssue,
} from "effect";
import { HttpServerRespondable } from "effect/http";
import { HttpServerRequest, ParsedSearchParams } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type { HttpApiEndpoint } from "effect/http-api";
import { HttpApiError, HttpApiMiddleware } from "effect/http-api";
import {
  BadRequest,
  Conflict,
  NotAcceptable,
  toDocument,
  UnsupportedMediaType,
  type WireDocument,
} from "./ApiError.js";
import { pointer } from "./Document.js";
import type { ErrorSource } from "./Document.js";
import { declaredNames, declaresName } from "./internal/declaredQuery.js";
import { indexErrorMeta } from "./internal/errorMeta.js";
import { MEDIA_TYPE, parseMediaType } from "./internal/media.js";
import { conflictingType, isTypePath, ServedTypes } from "./internal/servedTypes.js";
import { unlinkedOnWire, withCreatedLocation } from "./internal/responseBody.js";
import { wireLeaves } from "./internal/wireNames.js";
import {
  admitsNoValue,
  definesMembers,
  type Family,
  isFamily,
  isFamilyMember,
} from "./internal/vocabulary.js";
import { errorResponse, SERVER_ERROR } from "./ServerErrors.js";

// ---------------------------------------------------------------------------
// Tracing
// ---------------------------------------------------------------------------

/**
 * The stable `Effect.withSpan` names this package's middleware emits,
 * namespaced under `effect-jsonapi.` so they cannot collide with a host
 * application's own spans. Centralised here (rather than inlined at each
 * `withSpan` call) so a consumer can match on them — in an exporter's
 * dashboard, a sampling rule, or a test — without depending on string
 * literals scattered through the source.
 *
 * Both spans are attached automatically by {@link ContentNegotiationLive} and
 * {@link SchemaErrorsLive}; there is nothing to enable, and they cost nothing
 * when no `Tracer` is in context.
 *
 * - `Span.negotiate` — one span per request, wrapping the JSON:API §5
 *   decision. Attributes: `jsonapi.negotiation.outcome` (`"accepted"` or
 *   `"rejected"`), and, only when rejected, `jsonapi.negotiation.rule`
 *   (`"content_type"` or `"accept"`, naming which header failed).
 * - `Span.schemaError` — one span per request-validation failure, wrapping
 *   the translation of that failure into a JSON:API 400 document. Attribute:
 *   `jsonapi.request_part` — the request part that failed (`"Params"`,
 *   `"Headers"`, `"Query"` or `"Payload"`; a rejected reserved query
 *   parameter is tagged `"Query"`). A failure to encode the
 *   *response* is a server error, not a request-validation failure, and
 *   emits no such span.
 *
 * Every attribute value is one of a small fixed set of strings; none of them
 * is derived from a header value, a filter literal, a query string, or
 * anything else that could vary per request or identify a user.
 *
 * @example
 * ```ts
 * import { Middleware } from "@thomasfosterau/effect-jsonapi"
 *
 * Middleware.Span.negotiate // "effect-jsonapi.negotiate"
 * Middleware.Span.schemaError // "effect-jsonapi.schema_error"
 * ```
 *
 * @since 0.15.0
 * @category constants
 */
export const Span = {
  negotiate: "effect-jsonapi.negotiate",
  schemaError: "effect-jsonapi.schema_error",
} as const;

// ---------------------------------------------------------------------------
// Content negotiation predicates (JSON:API §5)
// ---------------------------------------------------------------------------

/**
 * Options for the content-negotiation predicates and middleware.
 *
 * @since 0.1.0
 * @category models
 */
export interface NegotiationOptions {
  /**
   * The JSON:API extension URIs this api supports (e.g.
   * `Atomic.EXTENSION_URI`). Media types carrying `ext` parameters whose URIs
   * are not all supported are rejected (415 / 406), per the spec.
   *
   * Defaults to none.
   */
  readonly extensions?: ReadonlyArray<string>;
}

/**
 * JSON:API §5: a JSON:API media type instance is acceptable when its only
 * parameters are `ext` and `profile`, and every `ext` URI is supported.
 * Unsupported profiles are ignored (never rejected), per the spec.
 */
const parametersAreAcceptable = (
  parameters: ReadonlyArray<readonly [name: string, value: string]>,
  extensions: ReadonlyArray<string>,
): boolean => {
  for (const [name, value] of parameters) {
    if (name === "profile") continue;
    if (name === "ext") {
      const uris = value.split(" ").filter((uri) => uri !== "");
      if (!uris.every((uri) => extensions.includes(uri))) return false;
      continue;
    }
    // Any parameter other than ext / profile is unacceptable.
    return false;
  }
  return true;
};

/**
 * JSON:API §5: the server MUST respond with 415 if the request `Content-Type`
 * is the JSON:API media type with any media type parameters other than `ext`
 * or `profile`, or with an `ext` parameter carrying unsupported extension
 * URIs. A `q` parameter (and anything after it) is an accept-extension
 * parameter, not a media type parameter, so it never counts against this rule
 * — `Content-Type` has no meaningful use for it, but the split is positional
 * regardless of which header carries it.
 *
 * Other content types are left to the downstream payload decoder.
 *
 * @since 0.1.0
 * @category utils
 */
export const contentTypeIsAcceptable = (
  header: string | undefined,
  options?: NegotiationOptions,
): boolean => {
  if (header === undefined) return true;
  const { base, parameters } = parseMediaType(header.trim());
  if (base !== MEDIA_TYPE) return true;
  return parametersAreAcceptable(parameters, options?.extensions ?? []);
};

/**
 * JSON:API §5: the server MUST respond with 406 if every instance of the
 * JSON:API media type in `Accept` carries media type parameters other than
 * `ext` / `profile` (or unsupported `ext` URIs). An `Accept` containing
 * `*\/*` or `application/*` always satisfies the rule.
 *
 * A `q` parameter is a weight on the `Accept` entry (RFC 9110 §12.4.2), not a
 * media type parameter, so it never counts against the ext/profile rule. An
 * entry weighted `q=0` is an explicit refusal of that representation and is
 * skipped rather than treated as acceptable; any non-zero weight is treated
 * the same as an entry with no weight at all. A `q` outside the RFC 9110
 * `qvalue` grammar (`0` to `1`, at most three decimals — e.g. `q=`, `q=2`,
 * `q=abc`) is malformed and counts as the default weight `1`: the client
 * named the type, so a malformed weight is never a refusal and never causes
 * a 406 on its own. `Negotiation` reads a malformed `q` the same way.
 *
 * @since 0.1.0
 * @category utils
 */
export const acceptIsAcceptable = (
  header: string | undefined,
  options?: NegotiationOptions,
): boolean => {
  if (header === undefined) return true;
  const entries = header.split(",").map((entry) => entry.trim());
  for (const entry of entries) {
    if (entry === "") continue;
    const { base, parameters, weight } = parseMediaType(entry);
    if (base === "*/*" || base === "application/*") return true;
    if (base !== MEDIA_TYPE) continue;
    // A malformed `q` is the default weight, not a refusal (as in `Negotiation`).
    if ((weight ?? 1) <= 0) continue;
    if (parametersAreAcceptable(parameters, options?.extensions ?? [])) return true;
  }
  return false;
};

/**
 * Runs JSON:API §5 content negotiation over request headers, independent of
 * Effect's HttpApi — for use in a plain framework hook that owns the URL
 * (e.g. a SvelteKit hook) rather than an `HttpApi`.
 *
 * Returns the {@link ApiError} the spec requires when negotiation fails — a 415
 * {@link UnsupportedMediaType} for an unacceptable `Content-Type`, or a 406
 * {@link NotAcceptable} for an unacceptable `Accept` — or `undefined` when the
 * request is acceptable. Render the returned error to a JSON:API error document
 * with `ApiError.toDocument(error)`.
 *
 * @example
 * ```ts
 * import { ApiError, Middleware } from "@thomasfosterau/effect-jsonapi"
 *
 * // inside a framework hook, from the request headers:
 * const error = Middleware.negotiate({
 *   contentType: "application/vnd.api+json",
 *   accept: "application/vnd.api+json"
 * })
 * if (error !== undefined) {
 *   // render the spec error body for the hook's response
 *   const body = ApiError.toDocument(error)
 *   body.errors[0]?.status // "415" (content type) or "406" (accept)
 * }
 * ```
 *
 * @since 0.3.0
 * @category utils
 */
export const negotiate = (
  headers: {
    readonly contentType?: string | undefined;
    readonly accept?: string | undefined;
  },
  options?: NegotiationOptions,
): UnsupportedMediaType | NotAcceptable | undefined => {
  if (!contentTypeIsAcceptable(headers.contentType, options)) return new UnsupportedMediaType();
  if (!acceptIsAcceptable(headers.accept, options)) return new NotAcceptable();
  return undefined;
};

/**
 * The part of a request whose decoding failed — the input to
 * {@link schemaError} and {@link schemaErrorDocument}.
 *
 * `"Params"`, `"Headers"`, `"Query"` and `"Payload"` are the request-side
 * kinds `HttpApiSchemaError` uses; HttpApi calls the request body
 * `"Payload"`. `"Body"` is accepted for a host that decodes a request body
 * itself and names it so, but inside HttpApi an `HttpApiSchemaError` of kind
 * `"Body"` is a failure to encode the handler's *response* — a server error
 * that {@link SchemaErrorsLive} never answers as a 400.
 *
 * @since 0.7.0
 * @category models
 */
export type RequestPart = "Params" | "Headers" | "Query" | "Body" | "Payload";

/**
 * The JSON:API 400 a request-validation failure produces — the standalone form
 * of what {@link SchemaErrorsLive} applies inside `HttpApi`.
 *
 * Pair it with {@link negotiate} to run the package's §5 negotiation and its
 * request-validation error shape from a plain framework hook that owns the URL,
 * without adopting the `Endpoint` constructors: decode with your own schemas,
 * and render this error with `ApiError.toDocument` when decoding fails. The
 * resulting document is byte-identical to the one an `Endpoint`-built api
 * returns, so both halves of a shared URL space answer alike.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { ApiError, Middleware } from "@thomasfosterau/effect-jsonapi"
 *
 * const Query = Schema.Struct({ limit: Schema.FiniteFromString })
 *
 * // inside a framework hook, decoding the request yourself:
 * const decode = (params: Record<string, string>) => {
 *   const result = Schema.decodeUnknownExit(Query)(params)
 *   if (result._tag === "Failure") {
 *     const body = ApiError.toDocument(Middleware.schemaError("Query"))
 *     return { status: 400, body }
 *   }
 *   return { status: 200, body: result.value }
 * }
 *
 * decode({ limit: "nope" }).status // 400
 * ```
 *
 * @since 0.7.0
 * @category utils
 */
export const schemaError = (part: RequestPart): BadRequest =>
  new BadRequest({ detail: `Request ${part.toLowerCase()} failed validation` });

// A JSON Pointer (RFC 6901) from an issue path, reusing `Document.pointer`'s
// escaping so this spelling can't drift from the public constructors'.
const jsonPointer = (path: ReadonlyArray<string | number>): string =>
  "/" + path.map((segment) => pointer.escape(String(segment))).join("/");

// The `source` of one error object, from the part that failed and the issue's
// path: query keys are re-bracketed (`["page", "limit"]` → `page[limit]`; a
// grammar key like `filter[age][gt]` is already one segment) up to the first
// list index — everything after an index is inside a decoded value (the sort
// codec's `["sort", 0, "field"]`), not part of the wire key; path params and
// headers take the first segment; a request body (HttpApi's `Payload`, or a
// host's own `Body`) takes the JSON Pointer.
const sourceOf = (
  part: RequestPart,
  path: ReadonlyArray<string | number>,
): typeof ErrorSource.Type | undefined => {
  switch (part) {
    case "Query": {
      const keys: Array<string> = [];
      for (const segment of path) {
        if (typeof segment !== "string") break;
        keys.push(segment);
      }
      if (keys.length === 0) return undefined;
      return {
        parameter:
          keys[0]! +
          keys
            .slice(1)
            .map((key) => `[${key}]`)
            .join(""),
      };
    }
    case "Params": {
      const key = path.find((segment): segment is string => typeof segment === "string");
      return key === undefined ? undefined : { parameter: key };
    }
    case "Headers": {
      const key = path.find((segment): segment is string => typeof segment === "string");
      return key === undefined ? undefined : { header: key };
    }
    case "Body":
    case "Payload":
      return path.length === 0 ? undefined : { pointer: jsonPointer(path) };
  }
};

/**
 * The JSON:API 400 document for a request-validation failure, from the
 * failure itself: one error object per issue the failure reports, each with
 * `status` `"400"`, `code` `"bad_request"`, `title` `"Bad Request"`, the
 * issue's message as `detail`, and a `source` naming what failed —
 * `source.parameter` for a query (`page[limit]`, `filter[age][gt]`) or path
 * parameter, `source.header` for a header, `source.pointer` (a JSON Pointer,
 * `/data/attributes/title`) for a body. When no source can be derived (the
 * whole part is malformed) it is the single-error document of
 * {@link schemaError}.
 *
 * A query parameter is named as the request sent it. A property the query
 * schema renames on the wire (`Schema.encodeKeys`, `Query.bracketKeys`,
 * `Query.bracketPageKeys`, `Query.flatList`) is rejected under its decoded
 * name once decoded, and `source.parameter` carries its wire name instead:
 * `include` for a property `paths` sent as `include`, `page[limit]` for a
 * bracketed `limit`. The same holds for a body member, at any depth, a
 * header and a path parameter: with `Schema.encodeKeys({ count: "itemCount" })`
 * a rejected `count` is `source.pointer` `/itemCount`, and with
 * `Schema.encodeKeys({ trace: "x-trace" })` a rejected header is
 * `source.header` `x-trace`. A key the schema does not rename keeps its own
 * name. To read a renamed struct's wire names, its transformation's decode
 * runs on probe values once per schema, as it does for a query, so a decode
 * with side effects has them run then.
 *
 * Where the schema that rejected the value publishes what it *would* have
 * accepted, the error object carries it as `meta`: a rejected `?include=` path
 * carries `meta.includablePaths` (the endpoint's whole supported set, as
 * {@link ApiError.UnsupportedIncludePath} does) and an unknown `?sort=` field
 * carries `meta.sortableFields`. A caller that guessed wrong learns the legal
 * vocabulary from the rejection instead of from a second request.
 *
 * How many issues a failure reports is the decoder's choice: HttpApi decodes
 * with the default parse options (`errors: "first"`), so inside
 * {@link SchemaErrorsLive} a part yields one error object, except the `filter`
 * family, whose codec reports every offending key together. Decode with
 * `errors: "all"` yourself to get every failing value.
 *
 * This is what {@link SchemaErrorsLive} answers with; reach for it directly
 * from a plain framework hook that decodes requests itself.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Middleware } from "@thomasfosterau/effect-jsonapi"
 *
 * const Query = Schema.Struct({ limit: Schema.FiniteFromString })
 *
 * const result = Schema.decodeUnknownResult(Query)({ limit: "nope" })
 * if (result._tag === "Failure") {
 *   Middleware.schemaErrorDocument("Query", result.failure)
 *   // → { errors: [{ status: "400", code: "bad_request", title: "Bad Request",
 *   //                detail: "Expected a finite number", source: { parameter: "limit" } }] }
 * }
 * ```
 *
 * @since 0.13.0
 * @category utils
 */
export const schemaErrorDocument = (
  part: RequestPart,
  error: Schema.SchemaError | SchemaIssue.Issue,
): typeof WireDocument.Type => {
  const issue = SchemaIssue.isIssue(error) ? error : error.issue;
  // Each leaf's path in decoded names, and as the request spelled it: a
  // query parameter (#305), body member, header or path parameter (#316)
  // renamed on the wire is named by its wire name.
  const leaves = wireLeaves(issue);
  // Error `meta` a schema publishes for its own rejections — the include
  // whitelist, the sortable fields — indexed once per failure and looked up
  // per leaf by the path the leaf sits at.
  const metaAt = indexErrorMeta(issue);
  const errors = leaves.map((leaf) => {
    const path = leaf.wire.flatMap((key) =>
      typeof key === "string" || typeof key === "number" ? [key] : [],
    );
    return { detail: leaf.message, source: sourceOf(part, path), meta: metaAt(leaf.path) };
  });
  if (!errors.some((error) => error.source !== undefined)) return toDocument(schemaError(part));
  return {
    errors: errors.map(({ detail, source, meta }) => ({
      status: String(BadRequest.status),
      code: BadRequest.code,
      ...(BadRequest.title !== undefined ? { title: BadRequest.title } : {}),
      detail,
      ...(source !== undefined ? { source } : {}),
      ...(meta !== undefined ? { meta } : {}),
    })),
  };
};

// ---------------------------------------------------------------------------
// Reserved query parameter names (JSON:API 1.1 §Query Parameters)
// ---------------------------------------------------------------------------

// The general rule every family the specification defines falls back on,
// §Implementation-Specific Query Parameters: "If a server encounters a query
// parameter that does not follow the naming conventions above, or the server
// does not know how to process it as a query parameter from this
// specification, it MUST return `400 Bad Request`."
const GENERAL_RULE =
  "JSON:API requires a server to reject a query parameter from the specification " +
  "that it does not know how to process.";

// The detail of the 400 for a parameter of a family JSON:API 1.1 defines
// (`FAMILIES`, the single list of them) on an endpoint that does not support
// it: `include` under §Inclusion of Related Resources; `sort` under §Sorting
// on an endpoint that responds with a resource collection, and under the
// general rule on any other; `fields[TYPE]`, `page[…]` and `filter[…]` under
// the general rule (#261), `fields` also because ignoring it would break
// §Sparse Fieldsets' MUST NOT on additional fields. An endpoint supports a
// family by declaring it with at least one legal value (#282), and a
// `fields[TYPE]` by declaring that very name.
const UNSUPPORTED: Readonly<Record<Family, (parameter: string) => string>> = {
  include: () =>
    'This endpoint does not support the "include" parameter. JSON:API requires an ' +
    "endpoint that does not support inclusion of related resources to reject any " +
    "request that carries it.",
  fields: (parameter) =>
    `This endpoint does not support the "${parameter}" parameter: it supports no sparse ` +
    `fieldset of that name. ${GENERAL_RULE}`,
  sort: () =>
    'This endpoint does not support the "sort" parameter. JSON:API requires a server ' +
    "that does not support the requested sorting to reject it.",
  page: () =>
    `This endpoint does not support the "page" parameter family: it does not paginate. ${GENERAL_RULE}`,
  filter: () =>
    `This endpoint does not support the "filter" parameter family: it does not filter. ${GENERAL_RULE}`,
};

// The detail of the 400 for a parameter of a family on an endpoint that
// declares other names of the family but not this one (#321): a misspelt
// `filter[stauts]` beside a declared `filter[status]`, a `page[sise]` beside
// `page[size]`, a bare `include` beside a hand-built `include[x]`, which the
// query schema would otherwise drop. It names the ones the endpoint does
// declare, a family prefix (an open record of it) as `filter[…]`.
const undeclaredMember = (
  parameter: string,
  family: Family,
  members: ReadonlyArray<string>,
): string =>
  `This endpoint does not support the "${parameter}" parameter: of the "${family}" family ` +
  `it supports only ${members.map((member) => `"${member.endsWith("[") ? `${member}…]` : member}"`).join(", ")}. ` +
  GENERAL_RULE;

// The detail of the 400 for a bracketed `include[…]` or `sort[…]` on an
// endpoint that supports the bare parameter (#329): JSON:API defines only
// the bare one, so the query schema would otherwise drop it and the handler
// would never see it.
const bracketedBareOnly = (parameter: string, family: Family): string =>
  `This endpoint does not support the "${parameter}" parameter: JSON:API defines only ` +
  `the bare "${family}" parameter, which this endpoint supports. ${GENERAL_RULE}`;

// The detail of the 400 for a parameter of a family the specification
// defines, on an endpoint that declares other names of that family: a
// bracketed `include[…]` / `sort[…]` beside the bare parameter, or an
// undeclared member of the names the endpoint does declare. With none
// declared, the family's own detail; `fields[TYPE]` always keeps its own,
// which already names the parameter.
const unsupportedDetail = (
  parameter: string,
  family: Family,
  declared: ReadonlyArray<string>,
): string => {
  const members = Arr.dedupe(Arr.filter(declared, (entry) => baseName(entry) === family));
  if (family === "fields" || !Arr.isReadonlyArrayNonEmpty(members)) {
    return UNSUPPORTED[family](parameter);
  }
  return !definesMembers(family) && parameter !== family && members.includes(family)
    ? bracketedBareOnly(parameter, family)
    : undeclaredMember(parameter, family, members);
};

// A family base name made only of a-z is reserved for the specification.
const RESERVED_BASE_NAME = /^[a-z]+$/;

// A parameter's family base name: everything before its first `[` — `page`
// for `page[limit]`, `foo` for `foo[bar]`, the whole name when unbracketed.
const baseName = (name: string): string => {
  const bracket = name.indexOf("[");
  return bracket === -1 ? name : name.slice(0, bracket);
};

/**
 * Options for the reserved-query-parameter check {@link SchemaErrors} runs on
 * every request (see {@link checkQueryParameters}).
 *
 * @since 0.17.0
 * @category models
 */
export interface QueryParameterOptions {
  /**
   * Family base names made only of a-z that the api accepts on every
   * endpoint although no endpoint declares them — for a host whose URL space
   * carries its own lowercase parameters (`lang`, `ref`, …) through to the
   * api. Each name admits the bare parameter and its bracketed members
   * (`lang` admits `lang` and `lang[x]`); the endpoint never sees them in its
   * decoded query, which keeps only what its `query` schema declares — also
   * when that schema declares nothing (#260).
   *
   * JSON:API 1.1 reserves these names for the specification, so accepting one
   * is a deliberate deviation: prefer renaming the parameter (`langCode`,
   * `x-lang`) when the host controls it. Defaults to none.
   *
   * An entry that is not such a base name — a bracketed member (`lang[x]`),
   * a name with any other character (`Lang`, ` lang`), or `""` — is refused
   * with {@link InvalidAllowedQueryParameter} rather than admitting nothing:
   * {@link schemaErrorsLayer} and {@link layerWith} throw it when the layer is
   * built, {@link checkQueryParameters} when it is called. List a bracketed
   * member by its base name (`lang`) and drop an empty entry; a name with any
   * other character is implementation-specific and never rejected, so it
   * needs no entry. So is a family the specification defines (`include`,
   * `fields`, `sort`, `page`, `filter`), and any bracketed name of one: an
   * endpoint supports a family, or a `fields`, `page` or `filter` member
   * (`page[size]`), by declaring it in its `query` schema, and answers 400
   * under the specification's general rule when it does not (JSON:API 1.1
   * §Implementation-Specific Query Parameters: a server that "does not know
   * how to process it as a query parameter from this specification … MUST
   * return `400 Bad Request`"). JSON:API defines only the bare `include` and
   * `sort`, so a bracketed `include[]` or `sort[title]` is that 400 even
   * where the endpoint declares the bare parameter (#329), and the refusal
   * says so; a name that only starts like a family's (`page[`, `filter[_]`)
   * is no member of it, and the refusal says that instead. The allow-list
   * cannot switch that 400 off, so a spec family is never silently ignored
   * (#261).
   */
  readonly allowedQueryParameters?: ReadonlyArray<string> | undefined;
}

/**
 * Options for {@link schemaErrorsLayer}: the reserved-query-parameter options
 * plus the switch for the full-linkage check it runs on every encoded success.
 *
 * @since 0.17.0
 * @category models
 */
export interface SchemaErrorsOptions extends QueryParameterOptions {
  /**
   * `false` skips the full-linkage check on the **encoded** response, which is
   * on by default (#250). The document builders (`Handlers.data`,
   * `Handlers.collection`, and the `Assemble` builders over them) check full
   * linkage on the document value they return, but they do not know the
   * endpoint's schema, and encoding through it drops every relationship the
   * resource does not declare: an `included` member reached only through one
   * passes the builders, then arrives on the wire unreachable from the
   * primary data. So the middleware re-runs the same reachability walk — the
   * one the conformance kit's `spec/document/full-linkage` rule makes — over
   * every 2xx document the endpoint encoded with an `included` member, and
   * answers a violation as it answers a response its schema rejects: a
   * defect, reported at `Error` severity, that the client receives as the
   * opaque JSON:API 500 of `ServerErrors.SERVER_ERROR`.
   *
   * A builder's own `checkLinkage: false` cannot reach this check — the
   * encoded document carries no trace of the value it came from — so a
   * handler that deliberately emits unlinked members turns it off here, for
   * every endpoint the layer serves. Only the encoded document decides, so
   * the check also covers a document built without the builders.
   */
  readonly checkLinkage?: boolean | undefined;
}

/**
 * An `allowedQueryParameters` entry that is not a family base name made only
 * of the letters a-z, or that names a family the specification defines
 * (`include`, `fields`, `sort`, `page`, `filter`) or a bracketed name of one
 * (`page[size]`, `include[]`, `page[`; see
 * {@link QueryParameterOptions.allowedQueryParameters}). Thrown when
 * {@link schemaErrorsLayer} or {@link layerWith} builds its layer, and by
 * {@link checkQueryParameters}, so a misspelt entry fails at startup instead
 * of leaving the parameter it meant to admit rejected, and a spec family
 * never ends up silently ignored.
 *
 * @example
 * ```ts
 * import { Middleware } from "@thomasfosterau/effect-jsonapi"
 *
 * try {
 *   Middleware.schemaErrorsLayer({ allowedQueryParameters: ["lang[region]"] })
 * } catch (error) {
 *   console.log((error as Middleware.InvalidAllowedQueryParameter).parameter)
 * }
 * // → lang[region]
 * ```
 *
 * @since 0.17.0
 * @category errors
 */
export class InvalidAllowedQueryParameter extends Schema.TaggedError<InvalidAllowedQueryParameter>()(
  "InvalidAllowedQueryParameter",
  { parameter: Schema.String, message: Schema.String },
) {}

// The tail of the refusal of an allow-list entry the 400 for a family the
// specification defines covers.
const CANNOT_SWITCH_OFF =
  "answers 400 under the specification's general rule when it does not, which the " +
  "allow-list cannot switch off; remove the entry.";

// Why an allow-list entry of a family the specification defines is refused:
// the family itself, a bracketed member of it such as `page[size]` (whose
// base name would be refused in turn), a bracketed `include[…]` / `sort[…]`,
// which the specification does not define at all (#329), or a name that
// only starts like one (`page[`, `filter[_]`), which is not a member.
const familyRefusal = (parameter: string, family: Family): string => {
  const entry = `allowedQueryParameters entry "${parameter}"`;
  if (parameter === family) {
    return (
      `${entry} names a query parameter family JSON:API defines. An endpoint supports ` +
      `it by declaring it in its query schema, and ${CANNOT_SWITCH_OFF}`
    );
  }
  if (!isFamilyMember(parameter, family)) {
    return (
      `${entry} starts with the "${family}" query parameter family name JSON:API defines ` +
      `but is not a well-formed member of it: a member is "${family}" followed by "[]" or ` +
      "square-bracketed member names. The allow-list cannot admit a name of that family; " +
      "remove the entry."
    );
  }
  if (!definesMembers(family)) {
    return (
      `${entry} is a bracketed member of the "${family}" query parameter family, but ` +
      `JSON:API defines only the bare "${family}" parameter. An endpoint answers a ` +
      "bracketed one 400 under the specification's general rule unless its query schema " +
      "declares that very name, which the allow-list cannot switch off; remove the entry."
    );
  }
  return (
    `${entry} is a member of the "${family}" query parameter family JSON:API defines. ` +
    `An endpoint supports it by declaring it in its query schema, and ${CANNOT_SWITCH_OFF}`
  );
};

// Why an allow-list entry is refused, if it is: one that is not a reserved
// family base name could never match a parameter the check rejects, and one
// of a family the specification defines would switch off the 400 the
// general rule calls for (owner decision on #261).
const refusal = (parameter: string): Option.Option<string> => {
  const base = baseName(parameter);
  if (isFamily(base)) return Option.some(familyRefusal(parameter, base));
  if (RESERVED_BASE_NAME.test(parameter)) return Option.none();
  return Option.some(
    `allowedQueryParameters entry "${parameter}" is not a family base name ` +
      "made only of the letters a-z. " +
      (parameter === ""
        ? "An empty entry names no parameter; remove it."
        : base !== parameter && RESERVED_BASE_NAME.test(base)
          ? `List its base name "${base}", which admits the bare parameter and ` +
            "every bracketed member of its family."
          : "A name with any other character is implementation-specific and never rejected, " +
            "so it needs no entry."),
  );
};

// The allow-list, every entry checked to be a reserved family base name the
// specification does not define.
const allowedBaseNames = (options?: QueryParameterOptions): ReadonlyArray<string> => {
  const allowed = options?.allowedQueryParameters ?? [];
  const refused = Arr.findFirst(allowed, (parameter) =>
    Option.map(
      refusal(parameter),
      (message) => new InvalidAllowedQueryParameter({ parameter, message }),
    ),
  );
  if (Option.isSome(refused)) throw refused.value;
  return allowed;
};

// Whether a parameter is one the endpoint supports, given the names it
// declares and the allow-list. Every name of a family the specification
// defines is its own parameter — a `fields[TYPE]` per resource type (#261),
// a `page[KEY]` or `filter[KEY]` per declared key (#321), and the bare
// `include` / `sort`, which admit no bracketed member (#329) — so only that
// very name, or a declared prefix of its family (`fields[`, `filter[`: an
// open record of it), admits it (`declaresName`). A declared name of any
// other reserved family admits its whole family, as does an allowed base
// name.
const isSupported = (
  name: string,
  declared: ReadonlyArray<string>,
  allowed: ReadonlyArray<string>,
): boolean => {
  const base = baseName(name);
  if (!RESERVED_BASE_NAME.test(base) || allowed.includes(base)) return true;
  if (isFamily(base)) return declaresName(declared, name);
  return declared.some((entry) => baseName(entry) === base);
};

// The check behind `checkQueryParameters`, over an allow-list
// `allowedBaseNames` has already validated: `schemaErrorsLayer` validates
// once, when it is built, rather than on every request.
const rejectQueryParameters = (
  names: Iterable<string>,
  declared: ReadonlyArray<string>,
  allowed: ReadonlyArray<string>,
): Option.Option<typeof WireDocument.Type> => {
  const rejected = Arr.dedupe(
    Arr.filter(Arr.fromIterable(names), (name) => !isSupported(name, declared, allowed)),
  );
  if (!Arr.isReadonlyArrayNonEmpty(rejected)) return Option.none();
  return Option.some({
    errors: rejected.map((parameter) => ({
      status: String(BadRequest.status),
      code: BadRequest.code,
      ...(BadRequest.title !== undefined ? { title: BadRequest.title } : {}),
      detail: Option.getOrElse(
        Option.map(Option.liftPredicate(baseName(parameter), isFamily), (family) =>
          unsupportedDetail(parameter, family, declared),
        ),
        () =>
          `Query parameter "${parameter}" is not supported. JSON:API reserves parameter ` +
          "names made only of the letters a-z for the specification; an implementation-" +
          "specific parameter's name must contain at least one other character, such as " +
          "a capital letter.",
      ),
      source: { parameter },
    })),
  });
};

/**
 * The input to {@link checkQueryParameters}: the
 * {@link QueryParameterOptions} plus the parameters the endpoint declares.
 *
 * @since 0.17.0
 * @category models
 */
export interface QueryParameterCheck extends QueryParameterOptions {
  /**
   * The query parameter names the endpoint's own query schema declares
   * (`q`, `page[limit]`, `fields[articles]`, …). Each admits its whole
   * family, except a name of a family the specification defines, which
   * admits only itself: a sparse fieldset is per resource type, so
   * `fields[articles]` does not admit `fields[people]`; a page or filter
   * key is per key, so `page[limit]` does not admit `page[size]` (#321); and
   * JSON:API defines only the bare `include` and `sort`, so a declared
   * `include` does not admit `include[]` (#329). A name ending in `[`
   * (`fields[`, `filter[`) admits every name it opens.
   * An endpoint that supports one of the specification's families
   * (`include`, `fields[TYPE]`, `sort`, `page`, `filter`) lists it here:
   * undeclared, it is rejected. One that declares it with an empty
   * vocabulary (no include path, no sortable field, no filterable field, a
   * resource type with no attribute) supports no value of it, so leaves it
   * out, as {@link SchemaErrorsLive} does. Defaults to none.
   */
  readonly declared?: ReadonlyArray<string> | undefined;
}

/**
 * JSON:API 1.1 §Query Parameters: a query parameter whose family base name is
 * made only of the letters a-z is reserved for the specification, so a server
 * that does not know how to process one MUST answer 400 Bad Request. That
 * covers a parameter of one of the specification's own families on an
 * endpoint that does not support it, and two sections require the same 400
 * outright: §Inclusion of Related Resources for `include`, and §Sorting for
 * `sort` on an endpoint that responds with a resource collection. For
 * `fields[TYPE]`, ignoring it would also break §Sparse Fieldsets, under which
 * an endpoint "MUST NOT include additional [fields]" beyond the requested set.
 * Returns that 400 document — one error object per offending parameter, each
 * naming it in `source.parameter` — or `undefined` when every parameter is
 * acceptable.
 *
 * A parameter is acceptable when its family base name (everything before the
 * first `[`):
 *
 * - contains any character outside a-z (`fooBar`, `x-trace`, `foo_bar`,
 *   `ext:name`) — an implementation-specific or extension parameter, ignored
 *   here as before;
 * - is the base of a name in `declared` — the only way a family the
 *   specification defines (`include`, `sort`, `page`, `filter`) is
 *   acceptable, since an endpoint that does not declare one does not
 *   support it (nor one that declares it with an empty vocabulary, which
 *   {@link SchemaErrorsLive} leaves out of `declared`). A `fields[TYPE]` is
 *   acceptable only when `declared` lists that very name (or a `fields[`
 *   prefix): a sparse fieldset is per resource type, so a declared
 *   `fields[articles]` does not admit `fields[people]`, a bare `fields` or
 *   `fields[articles][x]`. A `page[…]` or `filter[…]`, and a bare `page` or
 *   `filter`, likewise (#321): a declared `page[limit]` does not admit
 *   `page[size]`, and a declared `filter[status]` does not admit
 *   `filter[stauts]` or `filter[status][eq]`, each of which is answered
 *   naming the members `declared` does list; a `filter[` prefix (the open
 *   `filter: true` grammar) admits every `filter[…]`. A declared `include`
 *   or `sort` admits only the bare parameter (#329): JSON:API defines no
 *   bracketed member of either, so `include[]` or `sort[title]` is answered
 *   saying so, unless `declared` lists that very name; or
 * - is listed in `allowedQueryParameters`.
 *
 * Throws {@link InvalidAllowedQueryParameter} for an `allowedQueryParameters`
 * entry that is not a family base name made only of a-z, or that names one
 * of the specification's families or a bracketed name of one.
 *
 * {@link SchemaErrorsLive} runs this on every request before the endpoint
 * decodes anything, with the names the endpoint's query schema declares.
 * Call it directly from a plain framework hook that decodes requests itself.
 *
 * @example
 * ```ts
 * import { Middleware } from "@thomasfosterau/effect-jsonapi"
 *
 * // the names of the request's query parameters, e.g. from `URLSearchParams`
 * const names = new URLSearchParams("q=hello&unknown=1&fooBar=2").keys()
 *
 * const document = Middleware.checkQueryParameters(names, { declared: ["q"] })
 * document?.errors[0]?.source // { parameter: "unknown" }
 * ```
 *
 * @since 0.17.0
 * @category utils
 */
export const checkQueryParameters = (
  names: Iterable<string>,
  options?: QueryParameterCheck,
): typeof WireDocument.Type | undefined =>
  Option.getOrUndefined(
    rejectQueryParameters(names, options?.declared ?? [], allowedBaseNames(options)),
  );

// What an endpoint supports, for `checkQueryParameters`: the wire names its
// query schema declares (`declaredNames`; none when it could accept a name
// the walk cannot enumerate, and the check then stands aside), less every
// name of a family it declares with no legal value — `include: { paths: []
// }`, `sort: true` over no attributes, `filter: true` over no filterable
// field, a `fields[TYPE]` whose type has no attribute. Such a parameter
// supports no value, so it counts as undeclared (owner decisions on #282 and
// #261): every request that carries it gets the same 400 as on an endpoint
// that never declared it. Each name is read off the property its wire
// parameter decodes into, and no other (`admitsNoValue`); a `fields[TYPE]`
// off that type's fieldset alone, so a neighbouring type keeps its own.
const supportedNames = (ast: SchemaAST.AST): Option.Option<ReadonlyArray<string>> =>
  Option.map(declaredNames(ast), (names) => Arr.filter(names, (name) => !admitsNoValue(ast, name)));

// Endpoints are built once and served many times; walk each query schema once.
const declaredByEndpoint = new WeakMap<HttpApiEndpoint.Top, Option.Option<ReadonlyArray<string>>>();

const declaredFor = (endpoint: HttpApiEndpoint.Top): Option.Option<ReadonlyArray<string>> => {
  const cached = declaredByEndpoint.get(endpoint);
  if (cached !== undefined) return cached;
  const names = endpoint.query === undefined ? Option.some([]) : supportedNames(endpoint.query.ast);
  declaredByEndpoint.set(endpoint, names);
  return names;
};

// ---------------------------------------------------------------------------
// Middleware services
// ---------------------------------------------------------------------------

/**
 * Enforces JSON:API §5 content negotiation. Fails with
 * {@link UnsupportedMediaType} (415) or {@link NotAcceptable} (406), both of
 * which encode to JSON:API error documents.
 *
 * @since 0.1.0
 * @category services
 */
export class ContentNegotiation extends HttpApiMiddleware.Service<ContentNegotiation>()(
  "effect-jsonapi/ContentNegotiation",
  { error: [NotAcceptable.wire, UnsupportedMediaType.wire] as const },
) {}

/**
 * Converts request validation failures (`HttpApiSchemaError`: malformed
 * params, query, payload or headers) into JSON:API 400 error documents, and
 * rejects reserved all-lowercase query parameters the endpoint does not
 * process, the specification's own families included (see
 * {@link checkQueryParameters}). A failure to encode the
 * handler's response is left a server error, and so is an encoded document
 * that breaks full linkage (see {@link SchemaErrorsLive}).
 *
 * @since 0.1.0
 * @category services
 */
export class SchemaErrors extends HttpApiMiddleware.Service<SchemaErrors>()(
  "effect-jsonapi/SchemaErrors",
  {
    error: BadRequest.wire,
  },
) {}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

/**
 * Creates the live {@link ContentNegotiation} implementation, optionally
 * supporting JSON:API extensions (e.g. atomic operations).
 *
 * @since 0.1.0
 * @category constructors
 */
export const contentNegotiationLayer = (
  options?: NegotiationOptions,
): Layer.Layer<ContentNegotiation> =>
  Layer.effect(
    ContentNegotiation,
    Effect.succeed<typeof ContentNegotiation.Service>((httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const error = yield* Effect.sync(() =>
          negotiate(
            { contentType: request.headers["content-type"], accept: request.headers["accept"] },
            options,
          ),
        ).pipe(
          Effect.tap((error) =>
            Effect.annotateCurrentSpan(
              error === undefined
                ? { "jsonapi.negotiation.outcome": "accepted" }
                : {
                    "jsonapi.negotiation.outcome": "rejected",
                    "jsonapi.negotiation.rule":
                      error instanceof UnsupportedMediaType ? "content_type" : "accept",
                  },
            ),
          ),
          Effect.withSpan(Span.negotiate),
        );
        if (error !== undefined) return yield* Effect.fail(error);
        return yield* httpEffect;
      }),
    ),
  );

/**
 * The live {@link ContentNegotiation} implementation (no extensions).
 *
 * @since 0.1.0
 * @category layers
 */
export const ContentNegotiationLive: Layer.Layer<ContentNegotiation> = contentNegotiationLayer();

// The `HttpApiSchemaError` kinds HttpApi raises while encoding the handler's
// *response* rather than decoding the request: `Body` for the success value,
// `ResponseHeaders` for its declared headers. Either means the handler produced
// something its own endpoint's schema rejects — a server bug, not a bad request.
type ResponsePart = Extract<HttpApiError.HttpApiSchemaError["kind"], "Body" | "ResponseHeaders">;

const isResponsePart = (kind: HttpApiError.HttpApiSchemaError["kind"]): kind is ResponsePart =>
  kind === "Body" || kind === "ResponseHeaders";

// The defect a response-encoding failure dies with — and a wire full-linkage
// violation, the other way a handler's response can fail its endpoint's
// encoding (#250), with no `HttpApiSchemaError` behind it. It cannot stay the
// `HttpApiSchemaError` itself: that error is `Respondable` as an empty 400, and
// HttpApi turns a failure of it into a defect the router answers with exactly
// that 400. This one answers with the opaque JSON:API 500 `ServerErrors.respond`
// uses for every other server defect, and asks error reporters for `Error`
// severity; the original `HttpApiSchemaError` rides along as `cause`.
class ResponseEncodeError extends Schema.TaggedError<ResponseEncodeError>()(
  "effect-jsonapi/ResponseEncodeError",
  { message: Schema.String, cause: Schema.Defect() },
) {
  override readonly [ErrorReporter.severity] = "Error" as const;

  [HttpServerRespondable.symbol]() {
    return errorResponse(SERVER_ERROR);
  }
}

// The 400 a request-validation failure answers with, under the request-part
// span every such failure emits.
const badRequestResponse = (part: RequestPart, document: typeof WireDocument.Type) =>
  Effect.succeed(
    HttpServerResponse.jsonUnsafe(document, { status: BadRequest.status, contentType: MEDIA_TYPE }),
  ).pipe(
    Effect.tap(() => Effect.annotateCurrentSpan({ "jsonapi.request_part": part })),
    Effect.withSpan(Span.schemaError),
  );

// The 409 a create or update answers a resource object of another `type`
// with (§Creating Resources → 409 Conflict: "A server MUST return 409 Conflict
// when processing a POST request in which the resource object's type is not
// among the type(s) that constitute the collection represented by the
// endpoint"; §Updating Resources → 409 Conflict likewise for a PATCH), under
// the same span as the 400 it replaces.
const conflictResponse = (type: string, served: ReadonlyArray<string>) =>
  Effect.succeed(
    HttpServerResponse.jsonUnsafe(
      {
        errors: [
          {
            status: String(Conflict.status),
            code: Conflict.code,
            title: Conflict.title,
            detail:
              `Resource object type "${type}" is not served by this endpoint ` +
              `(expected ${served.map((name) => `"${name}"`).join(" or ")})`,
            source: { pointer: "/data/type" },
          },
        ],
      },
      { status: Conflict.status, contentType: MEDIA_TYPE },
    ),
  ).pipe(
    Effect.tap(() => Effect.annotateCurrentSpan({ "jsonapi.request_part": "Payload" })),
    Effect.withSpan(Span.schemaError),
  );

// A payload rejected at `/data/type` on an endpoint that declares the types it
// serves (`Endpoint.create` / `Endpoint.update`), whose body sent a string
// `type` none of them names: the `type` of the resource object that conflicts.
// Any other failure — a `type` missing or not a string, a body that is not
// JSON — is a malformed document, the 400.
const payloadConflict = Effect.fnUntraced(function* (
  endpoint: HttpApiEndpoint.Top,
  error: Schema.SchemaError,
) {
  const served = Context.getOption(endpoint.annotations, ServedTypes);
  if (Option.isNone(served) || !wireLeaves(error.issue).some((leaf) => isTypePath(leaf.wire))) {
    return Option.none<{ readonly type: string; readonly served: ReadonlyArray<string> }>();
  }
  const request = yield* HttpServerRequest;
  // The body HttpApi decoded, cached on the request, so this reads no stream.
  const body = yield* Effect.option(request.text);
  return Option.map(
    Option.flatMap(body, (text) => conflictingType(text, served.value)),
    (type) => ({ type, served: served.value }),
  );
});

const transformSchemaError = (
  endpoint: HttpApiEndpoint.Top,
  error: HttpApiError.HttpApiSchemaError,
) => {
  const { kind } = error;
  if (isResponsePart(kind)) {
    return Effect.die(
      new ResponseEncodeError({
        message: `The handler's response failed to encode against its endpoint's schema (${kind})`,
        cause: error,
      }),
    );
  }
  const badRequest = badRequestResponse(kind, schemaErrorDocument(kind, error.cause));
  if (kind !== "Payload") return badRequest;
  return Effect.flatMap(payloadConflict(endpoint, error.cause), (conflict) =>
    Option.isSome(conflict)
      ? conflictResponse(conflict.value.type, conflict.value.served)
      : badRequest,
  );
};

// The encoded success as it stands, or the defect a full-linkage violation in
// it dies with. The message is the builders' (`Handlers.buildIncluded`), with
// what the builders could not see: that it is the encoded document that
// breaks the rule, most often through a relationship the schema drops.
const checkWireLinkage = (response: HttpServerResponse.HttpServerResponse) =>
  Arr.match(unlinkedOnWire(response), {
    onEmpty: () => Effect.succeed(response),
    onNonEmpty: (orphans) =>
      Effect.die(
        new ResponseEncodeError({
          message:
            `JSON:API full linkage violation: included ${orphans.length === 1 ? "resource" : "resources"} ` +
            `${orphans.map((label) => `"${label}"`).join(", ")} ` +
            `${orphans.length === 1 ? "is" : "are"} not reachable from the primary data through resource linkage ` +
            `in the document as encoded against its endpoint's schema, which drops any relationship the ` +
            `resource does not declare (https://jsonapi.org/format/1.1/#document-compound-documents)`,
          cause: undefined,
        }),
      ),
  });

/**
 * Creates the live {@link SchemaErrors} implementation, optionally accepting
 * extra all-lowercase query parameters (see
 * {@link QueryParameterOptions.allowedQueryParameters}).
 *
 * Before the endpoint decodes anything, every request's query parameter
 * names are checked with {@link checkQueryParameters} against the names the
 * endpoint's query schema declares: a parameter whose family base name is made
 * only of a-z, that is neither one of the specification's families nor
 * declared nor allowed, is answered with the JSON:API 400 naming it in
 * `source.parameter` (JSON:API 1.1 §Query Parameters), and so is a parameter
 * of one of the specification's families — `include`, `fields[TYPE]`,
 * `sort`, `page[…]`, `filter[…]` — the endpoint does not declare with at
 * least one legal value (§Inclusion of Related Resources; §Sorting on a
 * collection endpoint; the general §Implementation-Specific Query
 * Parameters rule otherwise), as is a member of a `page` or `filter` family
 * the endpoint declares other members of but not that one (`filter[stauts]`
 * beside a declared `filter[status]`, under the general rule), and a
 * bracketed `include[…]` / `sort[…]` beside a declared bare `include` /
 * `sort` (`include[]`, `sort[title]`; JSON:API defines only the bare
 * parameter, so the general rule applies). Then every request validation
 * failure is answered as {@link SchemaErrorsLive} describes.
 *
 * The `Endpoint` constructors attach {@link SchemaErrors} after
 * {@link ContentNegotiation}, which makes it the outer of the two, so this
 * check runs first: a request that both carries a reserved parameter and
 * fails §5 negotiation is answered with the 400, not the 406 or 415.
 *
 * Throws {@link InvalidAllowedQueryParameter}, when called, for an
 * `allowedQueryParameters` entry that is not a family base name made only of
 * a-z, or that names one of the specification's families (`include`,
 * `fields`, `sort`, `page`, `filter`) or a bracketed name of one
 * (`page[size]`, `include[]`).
 *
 * Then every 2xx document the endpoint encoded is checked for full linkage,
 * unless `checkLinkage` is `false` ({@link SchemaErrorsOptions.checkLinkage}).
 *
 * {@link SchemaErrorsLive} is `schemaErrorsLayer()`; {@link layerWith} takes
 * the same options. A host that negotiates content itself composes this with
 * {@link ContentNegotiationPassthrough} and {@link CreatedLocationLive}, as the
 * example does.
 *
 * @example
 * ```ts
 * import { Layer } from "effect"
 * import { Middleware } from "@thomasfosterau/effect-jsonapi"
 *
 * const HandlersLive: Layer.Layer<never> = Layer.empty
 *
 * // The host's URL space carries its own `?lang=` through to the api.
 * const ApiLive = Layer.mergeAll(HandlersLive).pipe(
 *   Layer.provideMerge(
 *     Layer.mergeAll(
 *       Middleware.ContentNegotiationPassthrough,
 *       Middleware.schemaErrorsLayer({ allowedQueryParameters: ["lang"] }),
 *       Middleware.CreatedLocationLive
 *     )
 *   )
 * )
 * ```
 *
 * @since 0.17.0
 * @category constructors
 */
export const schemaErrorsLayer = (options?: SchemaErrorsOptions): Layer.Layer<SchemaErrors> => {
  // Checked here, so a misspelt entry fails when the layer is built.
  const allowedQueryParameters = allowedBaseNames(options);
  const checkLinkage = options?.checkLinkage !== false;
  return Layer.succeed(
    SchemaErrors,
    // Untraced: the middleware's span surface is `Span.schemaError` alone.
    Effect.fnUntraced(function* (httpEffect, { endpoint }) {
      const declared = declaredFor(endpoint);
      if (Option.isSome(declared)) {
        const params = yield* ParsedSearchParams;
        const rejected = rejectQueryParameters(
          Rec.keys(params),
          declared.value,
          allowedQueryParameters,
        );
        if (Option.isSome(rejected)) return yield* badRequestResponse("Query", rejected.value);
      }
      // The linkage check reads the encoded success only: a defect it dies
      // with passes `catch`, which sees failures alone.
      return yield* Effect.catch(
        checkLinkage ? Effect.flatMap(httpEffect, checkWireLinkage) : httpEffect,
        (error) =>
          HttpApiError.HttpApiSchemaError.is(error)
            ? transformSchemaError(endpoint, error)
            : Effect.fail(error),
      );
    }),
  );
};

/**
 * The live {@link SchemaErrors} implementation: answers every request
 * validation failure with the JSON:API 400 error document of
 * {@link schemaErrorDocument} — an error object per reported issue (one per
 * request part under HttpApi's `errors: "first"`, every offending key for the
 * `filter` family), each with a `detail` and a `source` naming the offending
 * parameter, header or body member.
 *
 * One payload failure is not a 400: on `Endpoint.create` and
 * `Endpoint.update`, a resource object whose `data.type` is a string naming a
 * type the endpoint does not serve (`{ "data": { "type": "people", … } }` to
 * `POST /articles`) is answered with JSON:API's 409 Conflict, an
 * `ApiError.Conflict`-shaped error object whose `source.pointer` is
 * `/data/type` (§Creating Resources → 409 Conflict; §Updating Resources →
 * 409 Conflict). A `type` that is missing or not a string stays the 400, as
 * does every other malformed member. It applies only where the payload's
 * failure is at `/data/type`, so a flat command-input payload
 * (`resource.createInput`) and a relationship endpoint's linkage keep their
 * 400. The 409 is not declared among the endpoint's errors, so a derived
 * client fails with the raw `HttpClientError` carrying the response, or an
 * `ErrorResponse` under `Client.make`'s `decodeErrors`.
 *
 * It also answers a query parameter whose family base name is made only of
 * a-z, and which the endpoint neither declares nor the specification defines
 * (`?unknown=1`, `?foo[bar]=1`), with a 400 naming it in `source.parameter`:
 * JSON:API 1.1 reserves those names for the specification, so a server that
 * does not know how to process one MUST reject it. Implementation-specific
 * names, carrying any other character (`?fooBar=1`, `?x-trace=1`), are
 * ignored as before. {@link schemaErrorsLayer} accepts extra lowercase names
 * a host needs.
 *
 * Likewise an `include` or `sort` parameter on an endpoint whose `query`
 * schema does not declare it — `?include=author` on `Endpoint.get(R)`
 * without `include`, `?sort=title` on `Endpoint.get(R)`, which never
 * declares `sort` — is a 400 naming it, whatever its value (an empty
 * `?include=` too). So is one the schema declares with an empty vocabulary,
 * which supports no value: `include: { paths: [] }`, `include: true` on a
 * resource with no relationships, `sort: true` on one with no attributes.
 * This 400 falls under JSON:API 1.1's general rule (§Implementation-Specific
 * Query Parameters: a server that "does not know how to process it as a
 * query parameter from this specification … MUST return `400 Bad
 * Request`"), which covers every case here, `sort` on a single-resource
 * endpoint (`GET /articles/1?sort=title`) included. Two sections repeat it
 * for their own family: §Inclusion of Related Resources for `include`, and
 * §Sorting for `sort` on an endpoint that responds with a resource
 * collection. Only the property the schema decodes the `include` /
 * `sort` parameter into decides whether its vocabulary is empty, read
 * through a union or `Schema.suspend`: one whose codec publishes no
 * vocabulary (`Query.IncludeList`, a custom codec), or a non-empty one in
 * any member of a union, supports the family. That is the property the
 * schema's encoding sends under the parameter's name, whatever its decoded
 * name: with `Schema.encodeKeys({ paths: "include", order: "sort" })`, the
 * `include` parameter is decided by `paths` and `sort` by `order`, and a
 * decoded `include` sent as `inc` decides nothing about `include`; a
 * transformation between two structs that renames nothing pairs each name
 * with itself, whatever order either struct lists them in. Where the
 * encoding cannot show which property that is (a chain of more than one
 * transformation, one that fails on a probe value, a `Middleware`), the
 * property of that name decides, or failing one, every property whose name
 * the wire does not declare.
 *
 * The same holds for `fields[TYPE]`, `page[…]` and `filter[…]` (#261): on an
 * endpoint whose `query` schema does not declare the family —
 * `?page[limit]=10` or `?filter[status]=open` on `Endpoint.get(R)`,
 * `?fields[articles]=title` on an endpoint declared without `fields` — the
 * parameter is a 400 naming it, whatever its value, under the general
 * §Implementation-Specific Query Parameters rule; so is one declared with an
 * empty vocabulary (`filter: true` on a resource with no filterable field,
 * `page: {}`, `filter: {}`). `fields` is per resource type: a `fields[TYPE]`
 * the endpoint declares no sparse fieldset for, or whose type has no
 * attribute to select, is a 400 naming that parameter, and a bare `fields`
 * or a `fields[TYPE][…]` likewise, while the endpoint's other
 * `fields[TYPE]` keep decoding. Ignoring such a fieldset would answer with
 * the very fields the client excluded, which §Sparse Fieldsets forbids ("an
 * endpoint MUST NOT include additional [fields] in resource objects of that
 * type in its response").
 *
 * `page` and `filter` are per member too (#321): on an endpoint that declares
 * an explicit `filter: { key: Schema }` map or a set of page keys
 * (`Query.Page.Offset`'s `page[offset]` / `page[limit]`, `Query.Page.Number`,
 * `Query.Page.Cursor`, a `Query.bracketPageKeys` struct), a member it does
 * not declare — `?filter[stauts]=open` beside a declared `filter[status]`,
 * `?page[sise]=10` beside `page[size]`, a deeper `filter[status][eq]`, or a
 * bare `filter` / `page` — is a 400 naming that parameter as the request
 * spelt it and listing the members the endpoint does declare, under the
 * spec's general rule. The query schema would otherwise drop it, and the
 * client would get an unfiltered or unpaginated collection. A member counts
 * by the name its encoding sends it under, so `Schema.encodeKeys({ state:
 * "filter[status]" })` declares `filter[status]`, not `filter[state]`. The
 * open `filter: true` grammar declares the bare `filter` and every
 * `filter[…]`, so its own codec still rejects a malformed member as before;
 * so does a hand-built open record of a family
 * (`Schema.Record(Schema.TemplateLiteral(["filter[", Schema.String, "]"]), …)`),
 * which admits every member it opens.
 *
 * JSON:API defines only the bare `include` and `sort` (#329), so a bracketed
 * one — `?include[]=author`, `?include[x]=author`, `?sort[title]=1`,
 * `?sort[x][y]=1` — is a 400 naming it under the spec's general rule, on an
 * endpoint that declares the bare parameter as on one that does not; the
 * query schema would otherwise drop it. A hand-built query schema that
 * declares such a name itself (a `"sort[x]"` property) supports that very
 * name, and only it.
 *
 * A handler whose response fails to encode against its endpoint's own schema
 * (`HttpApiSchemaError` kind `"Body"` or `"ResponseHeaders"`) is a server
 * bug, not a bad request: it stays a defect, which the request's error
 * reporting sees at `Error` severity and the client receives as the opaque
 * JSON:API 500 of `ServerErrors.SERVER_ERROR`.
 *
 * So is a 2xx document that, **as encoded**, breaks full linkage: an
 * `included` member its primary data cannot reach through resource linkage
 * (§Compound Documents). The document builders check the value they build,
 * but encoding drops any relationship the endpoint's schema does not declare,
 * so a member linked only through one passes them and is caught here (#250).
 * The walk is the conformance kit's `spec/document/full-linkage` rule's, over
 * the bytes the client receives; {@link schemaErrorsLayer} turns it off
 * ({@link SchemaErrorsOptions.checkLinkage}).
 *
 * @since 0.1.0
 * @category layers
 */
export const SchemaErrorsLive: Layer.Layer<SchemaErrors> = schemaErrorsLayer();

/**
 * Answers a 201 create with a `Location` header (JSON:API v1.1 §Creating
 * Resources → 201 Created), derived from the document the endpoint encoded:
 * the created resource's `data.links.self`, else the document's top-level
 * `links.self`, copied verbatim (a link object contributes its `href`). So
 * when the resource carries `links.self`, the two match by construction, as
 * the spec requires.
 *
 * Only a 201 is touched: a create answering another `status`, a response that
 * already carries `Location`, a body that is not JSON (or not settled bytes,
 * such as a stream), and a document naming no usable `self` link — none, or
 * one that is not a URI-reference — all pass through unchanged. It never
 * fails a request.
 *
 * `Endpoint.create` — and so `Endpoint.resource` / `Group.resource` — attaches
 * it inside `Idempotency.Middleware`, so a recorded 201 keeps its `Location`
 * and a replay returns it. {@link layer}, {@link layerWith} and
 * {@link layerHostNegotiated} provide {@link CreatedLocationLive}, and so do
 * `Registry.layer` / `Registry.webHandler`, beneath any `middleware` they are
 * given; any other api that composes its own middleware set adds it beside
 * the others.
 *
 * @since 0.17.0
 * @category services
 */
export class CreatedLocation extends HttpApiMiddleware.Service<CreatedLocation>()(
  "effect-jsonapi/CreatedLocation",
) {}

/**
 * The live {@link CreatedLocation} implementation. Part of {@link layer},
 * {@link layerWith} and {@link layerHostNegotiated}; provide it yourself only
 * beside a middleware set of your own.
 *
 * @example
 * ```ts
 * import { Layer } from "effect"
 * import { Middleware } from "@thomasfosterau/effect-jsonapi"
 *
 * const HandlersLive: Layer.Layer<never> = Layer.empty
 *
 * // `Middleware.layer`, spelled out piece by piece.
 * const ApiLive = Layer.mergeAll(HandlersLive).pipe(
 *   Layer.provideMerge(
 *     Layer.mergeAll(
 *       Middleware.ContentNegotiationLive,
 *       Middleware.SchemaErrorsLive,
 *       Middleware.CreatedLocationLive
 *     )
 *   )
 * )
 * ```
 *
 * @since 0.17.0
 * @category layers
 */
export const CreatedLocationLive: Layer.Layer<CreatedLocation> = Layer.succeed(
  CreatedLocation,
  (httpEffect) => Effect.map(httpEffect, withCreatedLocation),
);

/**
 * A {@link ContentNegotiation} implementation that performs **no** §5 checks —
 * for apis whose host already negotiated content upstream.
 *
 * The `Endpoint` constructors attach {@link ContentNegotiation} to every
 * endpoint, so an `HttpApi` built from them cannot be provided without it.
 * That is the right default — compliance can't be forgotten — but it assumes
 * the api owns negotiation. A host that serves JSON:API alongside HTML on one
 * URL space negotiates in its own hook instead (see {@link negotiate}), and
 * running §5 twice is at best redundant and at worst contradictory: a host that
 * deliberately accepts `Accept: application/json` for its api would have those
 * requests rejected with a 406 by the middleware after the hook admitted them.
 *
 * Providing this layer in place of {@link ContentNegotiationLive} satisfies the
 * endpoints' requirement while leaving the host the single negotiating
 * authority. Nothing else changes — {@link SchemaErrors} and every endpoint's
 * schemas, errors and documents are untouched. Use
 * {@link layerHostNegotiated} for the whole set.
 *
 * Reach for this only when something upstream genuinely enforces §5; on an api
 * that owns its own URLs, {@link layer} remains the correct choice.
 *
 * @since 0.7.0
 * @category layers
 */
export const ContentNegotiationPassthrough: Layer.Layer<ContentNegotiation> = Layer.effect(
  ContentNegotiation,
  Effect.succeed<typeof ContentNegotiation.Service>((httpEffect) => httpEffect),
);

/**
 * Everything a JSON:API api needs to run **when its host negotiates content**:
 * {@link ContentNegotiationPassthrough} plus the live {@link SchemaErrors} and
 * {@link CreatedLocation}.
 *
 * The drop-in replacement for {@link layer} in an application whose framework
 * hook has already applied §5 — typically with {@link negotiate}, so the rules
 * are the package's either way.
 *
 * @example
 * ```ts
 * import { Layer } from "effect"
 * import { Middleware } from "@thomasfosterau/effect-jsonapi"
 *
 * // `ArticlesLive` etc. are your `HttpApiBuilder.group(...)` implementations.
 * const ArticlesLive: Layer.Layer<never> = Layer.empty
 *
 * // The surrounding framework hook ran `Middleware.negotiate` already, so the
 * // api itself does not re-negotiate — it still emits JSON:API 400s.
 * const ApiLive = Layer.mergeAll(ArticlesLive).pipe(
 *   Layer.provideMerge(Middleware.layerHostNegotiated)
 * )
 * ```
 *
 * @since 0.7.0
 * @category layers
 */
export const layerHostNegotiated: Layer.Layer<ContentNegotiation | SchemaErrors | CreatedLocation> =
  Layer.mergeAll(ContentNegotiationPassthrough, SchemaErrorsLive, CreatedLocationLive);

/**
 * Everything a JSON:API api needs to run — the live {@link ContentNegotiation},
 * {@link SchemaErrors} and {@link CreatedLocation}: provide this layer
 * alongside your `HttpApiBuilder` group implementations.
 *
 * @example
 * ```ts
 * import { Layer } from "effect"
 * import { Middleware } from "@thomasfosterau/effect-jsonapi"
 *
 * // `UsersLive` etc. are your `HttpApiBuilder.group(...)` implementations.
 * const UsersLive: Layer.Layer<never> = Layer.empty
 *
 * // Provide the JSON:API middleware *into* the handler groups so every
 * // endpoint's middleware requirement is satisfied.
 * const ApiLive = Layer.mergeAll(UsersLive).pipe(
 *   Layer.provideMerge(Middleware.layer)
 * )
 * ```
 *
 * @since 0.1.0
 * @category layers
 */
export const layer: Layer.Layer<ContentNegotiation | SchemaErrors | CreatedLocation> =
  Layer.mergeAll(ContentNegotiationLive, SchemaErrorsLive, CreatedLocationLive);

/**
 * Like {@link layer}, with options — content-negotiation options, required
 * when the api uses JSON:API extensions, and the query-parameter options of
 * {@link schemaErrorsLayer} (`allowedQueryParameters`, for a host that must
 * accept its own all-lowercase parameters, and `checkLinkage`, which turns
 * off the full-linkage check on the encoded response; since 0.17.0).
 *
 * Throws {@link InvalidAllowedQueryParameter}, when called, for an
 * `allowedQueryParameters` entry that is not a family base name made only of
 * a-z, or that names one of the specification's families or a bracketed
 * name of one.
 *
 * @example
 * ```ts
 * import { Layer } from "effect"
 * import { Atomic, Middleware } from "@thomasfosterau/effect-jsonapi"
 *
 * const HandlersLive: Layer.Layer<never> = Layer.empty
 *
 * // Accept the atomic operations extension's media type.
 * const ApiLive = Layer.mergeAll(HandlersLive).pipe(
 *   Layer.provideMerge(
 *     Middleware.layerWith({ extensions: [Atomic.EXTENSION_URI] })
 *   )
 * )
 * ```
 *
 * @since 0.1.0
 * @category layers
 */
export const layerWith = (
  options: NegotiationOptions & SchemaErrorsOptions,
): Layer.Layer<ContentNegotiation | SchemaErrors | CreatedLocation> =>
  Layer.mergeAll(contentNegotiationLayer(options), schemaErrorsLayer(options), CreatedLocationLive);
