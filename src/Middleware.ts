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
 *         type carries such parameters, is weighted `q=0`, or carries a
 *         malformed `q` → 406 Not Acceptable (the `q` weight itself is not a
 *         media type parameter, per RFC 9110 §12.4.2, so it never counts
 *         against the whitelist)
 *   - {@link SchemaErrors} — converts request validation failures (malformed
 *     query parameters, payloads, path parameters) into spec-compliant
 *     JSON:API 400 error documents instead of the default HttpApi error shape:
 *     an error object per reported issue, each with a `detail` and a `source`
 *     naming the offending `parameter` (`filter[age][gt]`, `page[limit]`),
 *     `pointer` (`/data/attributes/title`) or `header`. HttpApi decodes each
 *     request part with the default parse options (`errors: "first"`), so a
 *     part yields one error object — except the `filter` family, whose codec
 *     reports every offending key together. It also rejects, with a 400
 *     naming it, a query parameter whose family base name is made only of
 *     a-z and that neither the specification defines nor the endpoint
 *     declares (JSON:API 1.1 §Query Parameters), and an `include` or `sort`
 *     parameter on an endpoint that does not declare it (§Inclusion of
 *     Related Resources; §Sorting on a collection endpoint, the general
 *     §Implementation-Specific Query Parameters rule on any other; see
 *     {@link checkQueryParameters}).
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
  Effect,
  ErrorReporter,
  Layer,
  Option,
  Predicate,
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
  NotAcceptable,
  toDocument,
  UnsupportedMediaType,
  type WireDocument,
} from "./ApiError.js";
import { pointer } from "./Document.js";
import type { ErrorSource } from "./Document.js";
import { indexErrorMeta } from "./internal/errorMeta.js";
import { MEDIA_TYPE, parseMediaType } from "./internal/media.js";
import { withCreatedLocation } from "./internal/responseBody.js";
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
 * `q=abc`) is malformed, and the entry is skipped like a refusal.
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
    // An unparseable `q` is a refusal here, not a default weight.
    if ((weight ?? 0) <= 0) continue;
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
  const leaves = SchemaIssue.makeFormatterStandardSchemaV1()(issue).issues;
  // Error `meta` a schema publishes for its own rejections — the include
  // whitelist, the sortable fields — indexed once per failure and looked up
  // per leaf by the path the leaf sits at.
  const metaAt = indexErrorMeta(issue);
  const errors = leaves.map((leaf) => {
    const keys = (leaf.path ?? []).map((segment) =>
      typeof segment === "object" ? segment.key : segment,
    );
    const path = keys.flatMap((key) =>
      typeof key === "string" || typeof key === "number" ? [key] : [],
    );
    return { detail: leaf.message, source: sourceOf(part, path), meta: metaAt(keys) };
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

// The query parameter families JSON:API 1.1 defines that this check passes
// through: an endpoint's query schema decodes one it declares and ignores one
// it does not. Whether an undeclared one should be a 400 too is an open
// decision (#261).
const SPEC_FAMILIES: ReadonlyArray<string> = ["fields", "page", "filter"];

// The families JSON:API 1.1 requires an endpoint that does not support them to
// answer with a 400, each with the detail its rejection carries: `include`
// under §Inclusion of Related Resources; `sort` under §Sorting on an endpoint
// that responds with a resource collection, and under the general
// §Implementation-Specific Query Parameters rule on any other. An endpoint
// supports one by declaring it.
const SUPPORT_FAMILIES: Readonly<Record<string, string>> = {
  include:
    'This endpoint does not support the "include" parameter. JSON:API requires an ' +
    "endpoint that does not support inclusion of related resources to reject any " +
    "request that carries it.",
  sort:
    'This endpoint does not support the "sort" parameter. JSON:API requires a server ' +
    "that does not support the requested sorting to reject it.",
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
   * `x-lang`) when the host controls it. Listing `include` or `sort` admits
   * it on an endpoint that does not support it, which then ignores it
   * instead of answering the 400 the specification requires. Defaults to
   * none.
   *
   * An entry that is not such a base name — a bracketed member (`lang[x]`),
   * a name with any other character (`Lang`, ` lang`), or `""` — is refused
   * with {@link InvalidAllowedQueryParameter} rather than admitting nothing:
   * {@link schemaErrorsLayer} and {@link layerWith} throw it when the layer is
   * built, {@link checkQueryParameters} when it is called. List a bracketed
   * member by its base name (`lang`) and drop an empty entry; a name with any
   * other character is implementation-specific and never rejected, so it
   * needs no entry.
   */
  readonly allowedQueryParameters?: ReadonlyArray<string> | undefined;
}

/**
 * An `allowedQueryParameters` entry that is not a family base name made only
 * of the letters a-z (see {@link QueryParameterOptions.allowedQueryParameters}).
 * Thrown when {@link schemaErrorsLayer} or {@link layerWith} builds its layer,
 * and by {@link checkQueryParameters}, so a misspelt entry fails at startup
 * instead of leaving the parameter it meant to admit rejected.
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

// The allow-list, every entry checked to be a reserved family base name: any
// other entry could never match a parameter the check rejects.
const allowedBaseNames = (options?: QueryParameterOptions): ReadonlyArray<string> => {
  const allowed = options?.allowedQueryParameters ?? [];
  const invalid = Arr.findFirst(allowed, (entry) => !RESERVED_BASE_NAME.test(entry));
  if (Option.isNone(invalid)) return allowed;
  const parameter = invalid.value;
  const base = baseName(parameter);
  throw new InvalidAllowedQueryParameter({
    parameter,
    message:
      `allowedQueryParameters entry "${parameter}" is not a family base name ` +
      "made only of the letters a-z. " +
      (parameter === ""
        ? "An empty entry names no parameter; remove it."
        : base !== parameter && RESERVED_BASE_NAME.test(base)
          ? `List its base name "${base}", which admits the bare parameter and ` +
            "every bracketed member of its family."
          : "A name with any other character is implementation-specific and never rejected, " +
            "so it needs no entry."),
  });
};

// The check behind `checkQueryParameters`, over an allow-list
// `allowedBaseNames` has already validated: `schemaErrorsLayer` validates
// once, when it is built, rather than on every request.
const rejectQueryParameters = (
  names: Iterable<string>,
  declared: ReadonlyArray<string>,
  allowed: ReadonlyArray<string>,
): Option.Option<typeof WireDocument.Type> => {
  const known = [...SPEC_FAMILIES, ...declared.map(baseName), ...allowed];
  const rejected = Arr.dedupe(
    Arr.filter(Arr.fromIterable(names), (name) => {
      const base = baseName(name);
      return RESERVED_BASE_NAME.test(base) && !known.includes(base);
    }),
  );
  if (!Arr.isReadonlyArrayNonEmpty(rejected)) return Option.none();
  return Option.some({
    errors: rejected.map((parameter) => ({
      status: String(BadRequest.status),
      code: BadRequest.code,
      ...(BadRequest.title !== undefined ? { title: BadRequest.title } : {}),
      detail: Option.getOrElse(
        Rec.get(SUPPORT_FAMILIES, baseName(parameter)),
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
   * (`q`, `page[limit]`, …); each admits its whole family. An endpoint that
   * supports `include` or `sort` lists it here: undeclared, either is
   * rejected. Defaults to none.
   */
  readonly declared?: ReadonlyArray<string> | undefined;
}

/**
 * JSON:API 1.1 §Query Parameters: a query parameter whose family base name is
 * made only of the letters a-z is reserved for the specification, so a server
 * that does not know how to process one MUST answer 400 Bad Request. And
 * §Inclusion of Related Resources and §Sorting require the same 400 for an
 * `include` or `sort` parameter on an endpoint that does not support it —
 * §Sorting on an endpoint that responds with a resource collection; on any
 * other, the general §Implementation-Specific Query Parameters rule applies
 * to `sort`, since the endpoint does not know how to process it.
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
 * - is `fields`, `page` or `filter`, the specification's families the
 *   endpoint's query schema decodes when it declares them and ignores
 *   otherwise;
 * - is the base of a name in `declared` — the only way `include` and `sort`
 *   are acceptable besides the allow-list, since an endpoint that does not
 *   declare them does not support them; or
 * - is listed in `allowedQueryParameters`.
 *
 * Throws {@link InvalidAllowedQueryParameter} for an `allowedQueryParameters`
 * entry that is not a family base name made only of a-z.
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

// What an endpoint's query schema declares, for `checkQueryParameters`:
// the wire names of its encoded (flat) side, or none when that side could
// accept a name this walk cannot enumerate — a record keyed by any string,
// say — in which case the check stands aside rather than reject a parameter
// the endpoint might process. `filter: true`'s `filter[…]` rest is the
// spec's own family and enumerable as such.
const declaredNames = (ast: SchemaAST.AST): Option.Option<ReadonlyArray<string>> => {
  const encoded = SchemaAST.toEncoded(ast);
  if (SchemaAST.isObjects(encoded)) {
    return Option.map(
      Option.all(encoded.indexSignatures.map(({ parameter }) => familyPrefix(parameter))),
      (prefixes) => [
        ...encoded.propertySignatures.map((signature) => String(signature.name)),
        ...prefixes,
      ],
    );
  }
  if (SchemaAST.isUnion(encoded)) {
    return Option.map(Option.all(encoded.types.map(declaredNames)), Arr.flatten);
  }
  if (SchemaAST.isSuspend(encoded)) return declaredNames(encoded.thunk());
  return Option.none();
};

// The family an index signature's key admits, when it names one: a template
// literal whose literal head closes the base name (`filter[`). Any other key
// could match a base name of any spelling.
const familyPrefix = (parameter: SchemaAST.AST): Option.Option<string> => {
  if (!SchemaAST.isTemplateLiteral(parameter)) return Option.none();
  const [head] = parameter.parts;
  return head !== undefined &&
    SchemaAST.isLiteral(head) &&
    Predicate.isString(head.literal) &&
    head.literal.includes("[")
    ? Option.some(head.literal)
    : Option.none();
};

// Endpoints are built once and served many times; walk each query schema once.
const declaredByEndpoint = new WeakMap<HttpApiEndpoint.Top, Option.Option<ReadonlyArray<string>>>();

const declaredFor = (endpoint: HttpApiEndpoint.Top): Option.Option<ReadonlyArray<string>> => {
  const cached = declaredByEndpoint.get(endpoint);
  if (cached !== undefined) return cached;
  const names = endpoint.query === undefined ? Option.some([]) : declaredNames(endpoint.query.ast);
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
 * process (see {@link checkQueryParameters}). A failure to encode the
 * handler's response is left a server error (see {@link SchemaErrorsLive}).
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

// The defect a response-encoding failure dies with. It cannot stay the
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

const transformSchemaError = (error: HttpApiError.HttpApiSchemaError) =>
  isResponsePart(error.kind)
    ? Effect.die(
        new ResponseEncodeError({
          message: `The handler's response failed to encode against its endpoint's schema (${error.kind})`,
          cause: error,
        }),
      )
    : badRequestResponse(error.kind, schemaErrorDocument(error.kind, error.cause));

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
 * `source.parameter` (JSON:API 1.1 §Query Parameters), and so is an
 * `include` or `sort` parameter the endpoint neither declares nor allows
 * (§Inclusion of Related Resources; §Sorting on a collection endpoint, the
 * general §Implementation-Specific Query Parameters rule on any other). Then
 * every request validation failure is answered as {@link SchemaErrorsLive}
 * describes.
 *
 * The `Endpoint` constructors attach {@link SchemaErrors} after
 * {@link ContentNegotiation}, which makes it the outer of the two, so this
 * check runs first: a request that both carries a reserved parameter and
 * fails §5 negotiation is answered with the 400, not the 406 or 415.
 *
 * Throws {@link InvalidAllowedQueryParameter}, when called, for an
 * `allowedQueryParameters` entry that is not a family base name made only of
 * a-z.
 *
 * {@link SchemaErrorsLive} is `schemaErrorsLayer()`; {@link layerWith} takes
 * the same option. A host that negotiates content itself composes this with
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
export const schemaErrorsLayer = (options?: QueryParameterOptions): Layer.Layer<SchemaErrors> => {
  // Checked here, so a misspelt entry fails when the layer is built.
  const allowedQueryParameters = allowedBaseNames(options);
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
      return yield* Effect.catch(httpEffect, (error) =>
        HttpApiError.HttpApiSchemaError.is(error)
          ? transformSchemaError(error)
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
 * `?include=` too). JSON:API 1.1 requires it: §Inclusion of Related
 * Resources for `include`; for `sort`, §Sorting on an endpoint that responds
 * with a resource collection, and on a single-resource endpoint (`GET
 * /articles/1?sort=title`) the general §Implementation-Specific Query
 * Parameters rule, since that endpoint does not know how to process `sort`
 * as a query parameter from the specification. An undeclared
 * `fields[TYPE]`, `page[…]` or `filter[…]` is still ignored.
 *
 * A handler whose response fails to encode against its endpoint's own schema
 * (`HttpApiSchemaError` kind `"Body"` or `"ResponseHeaders"`) is a server
 * bug, not a bad request: it stays a defect, which the request's error
 * reporting sees at `Error` severity and the client receives as the opaque
 * JSON:API 500 of `ServerErrors.SERVER_ERROR`.
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
 * such as a stream), and a document naming no usable `self` link all pass
 * through unchanged. It never fails a request.
 *
 * `Endpoint.create` — and so `Endpoint.resource` / `Group.resource` — attaches
 * it inside `Idempotency.Middleware`, so a recorded 201 keeps its `Location`
 * and a replay returns it. {@link layer}, {@link layerWith} and
 * {@link layerHostNegotiated} provide {@link CreatedLocationLive}; an api that
 * composes its own middleware set adds it beside the others.
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
 * accept its own all-lowercase parameters; since 0.17.0).
 *
 * Throws {@link InvalidAllowedQueryParameter}, when called, for an
 * `allowedQueryParameters` entry that is not a family base name made only of
 * a-z.
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
  options: NegotiationOptions & QueryParameterOptions,
): Layer.Layer<ContentNegotiation | SchemaErrors | CreatedLocation> =>
  Layer.mergeAll(contentNegotiationLayer(options), schemaErrorsLayer(options), CreatedLocationLive);
