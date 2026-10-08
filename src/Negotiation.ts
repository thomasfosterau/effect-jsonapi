/**
 * The representation verdict for a host that serves JSON:API on the same
 * URLs as its pages.
 *
 * An application whose api lives on bare resource URLs (`/articles`,
 * `/articles/:id`) shared with its rendered pages has to decide, per request
 * and before any routing, whether `/articles/1` answers a page or a document.
 * That decision is made here, from the request line and headers alone, so a
 * web front door and the api it forwards to share one verdict:
 *
 * - a **read** (`GET` / `HEAD`) dispatches to the api when a clean
 *   `application/vnd.api+json` instance wins `Accept` — present with `q > 0`,
 *   carrying no media-type parameters other than `ext` / `profile`, and
 *   ranking at least as high as every other media type;
 * - a **write** (`POST` / `PUT` / `PATCH` / `DELETE`) dispatches when its
 *   `Content-Type` is the JSON:API media type;
 * - either falls through to the host's own representation (HTML by default)
 *   otherwise — a browser navigation's `text/html,…`, an `application/json`
 *   client, a bare `*\/*` — and never matches a path the api does not serve.
 *
 * JSON:API §5's two negotiation errors are emitted at the seam: a read whose
 * every JSON:API instance is parameterised is `406`, a write whose
 * `Content-Type` carries a disallowed parameter is `415`. A read that
 * explicitly refuses JSON:API (`q=0`) and names nothing else acceptable falls
 * through by default; `onExplicitRefusal: "notAcceptable"` answers it `406`
 * instead ({@link NOT_ACCEPTABLE_REFUSED}). The rules are
 * `Middleware`'s (the same parser); what this module adds is the *winning*
 * comparison against the other media types and the path test, which a
 * §5-only check has no need of.
 *
 * `Middleware.layerHostNegotiated` is the pairing on the api side: it leaves
 * the host the single negotiating authority, so a request this module admits
 * is never re-negotiated (and rejected, since {@link requestForRouter} has by
 * then relabelled the write to `application/json`).
 *
 * @since 0.16.0
 */
import { Array as Arr, Option } from "effect";
import { MEDIA_TYPE, parseMediaType } from "./internal/media.js";

/**
 * A JSON:API error emitted at the seam — the §5 negotiation statuses and the
 * host's own guards ({@link CROSS_ORIGIN_REJECTED}, {@link SERVICE_UNAVAILABLE}).
 * Plain data, so a framework hook can render it without Effect
 * ({@link errorResponse}).
 *
 * @since 0.16.0
 * @category models
 */
export interface NegotiationError {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string;
}

/**
 * The outcome of negotiating one request.
 *
 * @since 0.16.0
 * @category models
 */
export interface Verdict {
  /**
   * The normalised representation token: the JSON:API media type when the
   * request dispatches, an alternate's media type when one matched, the
   * host's `fallback` otherwise. Never the raw `Accept` header — however
   * many distinct `Accept` strings clients send, a URL resolves to one of
   * these few tokens, which is what makes it a cache key.
   */
  readonly representation: string;
  /** `true` → serve this request from the Effect `HttpApi`. */
  readonly dispatch: boolean;
  /**
   * A negotiation error to emit instead of dispatching: JSON:API §5's 406 or
   * 415, or the opt-in RFC 9110 refusal ({@link NOT_ACCEPTABLE_REFUSED}).
   */
  readonly error?: NegotiationError;
}

/**
 * A non-JSON:API representation the host serves on a subset of its paths
 * when the client's winning `Accept` names it — a Markdown rendering of a
 * content page for agents, say.
 *
 * @since 0.16.0
 * @category models
 */
export interface Alternate {
  /** The media type the client names and the verdict reports. */
  readonly mediaType: string;
  /** Whether the request path serves this representation. */
  readonly matches: (pathname: string) => boolean;
}

/**
 * What {@link make} needs of the served api: the groups' endpoint paths.
 * Spelled structurally so an `HttpApi` (its `groups` record) or a plain
 * group list passes without a cast.
 *
 * @since 0.16.0
 * @category models
 */
export interface GroupLike {
  readonly identifier: string;
  readonly endpoints: { readonly [name: string]: { readonly path: string } };
}

/**
 * Options of {@link make}.
 *
 * @since 0.16.0
 * @category models
 */
export interface Options {
  /**
   * The served api — an `HttpApi` value or the group list it was assembled
   * from. The route table is derived from every endpoint's path, so adding
   * an endpoint updates the predicate with no second list to maintain.
   */
  readonly api:
    | ReadonlyArray<GroupLike>
    | { readonly groups: { readonly [id: string]: GroupLike } };
  /** The representation a request falls through to. Defaults to `"text/html"`. */
  readonly fallback?: string | undefined;
  /** Representations negotiated ahead of JSON:API on their own paths. */
  readonly alternates?: ReadonlyArray<Alternate> | undefined;
  /**
   * What a read on an api path answers when its `Accept` refuses JSON:API
   * explicitly — a clean JSON:API instance at `q=0` — and no range of any
   * media type carries `q > 0`.
   *
   * - `"fallthrough"` (the default): the host's own representation, as for
   *   any request that does not dispatch. RFC 9110 §12.4.2 reads `q=0` as
   *   "not acceptable", so the JSON:API instance simply does not win.
   * - `"notAcceptable"`: a `406` carrying {@link NOT_ACCEPTABLE_REFUSED}, for
   *   a host that answers a client refusing JSON:API on a JSON:API endpoint
   *   rather than serving it a page.
   *
   * Either way, a request that also names another range with `q > 0` —
   * `text/html;q=0.5`, `application/json`, `*\/*`, an alternate — is
   * negotiated as before: the refusal only applies when nothing is left.
   *
   * @since 0.17.0
   */
  // oxlint-disable-next-line effect/prefer-option-over-null -- a plain options record: `| undefined` lets a caller forward its own optional under exactOptionalPropertyTypes, as the sibling options do
  readonly onExplicitRefusal?: "fallthrough" | "notAcceptable" | undefined;
}

/**
 * The negotiator {@link make} builds.
 *
 * @since 0.16.0
 * @category models
 */
export interface Negotiator {
  /** Whether a request path matches a known api endpoint (trailing slash optional). */
  readonly isApiPath: (pathname: string) => boolean;
  /**
   * Negotiates one request into a {@link Verdict}. Pure: it reads the request
   * line and headers only, so a front door and the api share one verdict.
   */
  readonly negotiate: (request: Request) => Verdict;
}

/**
 * The 406 a read answers when the JSON:API media type appears in `Accept`
 * only with disallowed media-type parameters (JSON:API §5).
 *
 * @since 0.16.0
 * @category constants
 */
export const NOT_ACCEPTABLE: NegotiationError = {
  status: 406,
  code: "not-acceptable",
  title: "Not Acceptable",
  detail:
    "The Accept header carried the JSON:API media type, but every instance was modified with media-type parameters other than `ext` or `profile` (JSON:API §6.3.2).",
};

/**
 * The 406 a read answers, under `onExplicitRefusal: "notAcceptable"`, when
 * its `Accept` refuses the JSON:API media type with `q=0` and names no other
 * acceptable media type (RFC 9110 §12.4.2). Same status and `code` as
 * {@link NOT_ACCEPTABLE}; the `detail` names the rule, so the two 406s can be
 * told apart.
 *
 * @since 0.17.0
 * @category constants
 */
export const NOT_ACCEPTABLE_REFUSED: NegotiationError = {
  status: 406,
  code: "not-acceptable",
  title: "Not Acceptable",
  detail:
    "The Accept header refused the JSON:API media type with `q=0` and named no other acceptable media type (RFC 9110 §12.4.2).",
};

/**
 * The 415 a write answers when its JSON:API `Content-Type` carries a
 * disallowed media-type parameter (JSON:API §5).
 *
 * @since 0.16.0
 * @category constants
 */
export const UNSUPPORTED_MEDIA_TYPE: NegotiationError = {
  status: 415,
  code: "unsupported-media-type",
  title: "Unsupported Media Type",
  detail:
    "The Content-Type header carried the JSON:API media type with media-type parameters other than `ext` or `profile` (JSON:API §6.3.1).",
};

/**
 * The host's cross-origin mutation guard rejection.
 *
 * @since 0.16.0
 * @category constants
 */
export const CROSS_ORIGIN_REJECTED: NegotiationError = {
  status: 403,
  code: "auth.forbidden",
  title: "Forbidden",
  detail: "Cross-origin request rejected.",
};

/**
 * No per-request runtime — the api cannot serve without its services.
 *
 * @since 0.16.0
 * @category constants
 */
export const SERVICE_UNAVAILABLE: NegotiationError = {
  status: 503,
  code: "unavailable",
  title: "Service Unavailable",
  detail: "The API is temporarily unavailable.",
};

const WRITE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Whether a method mutates state — the methods negotiated on `Content-Type`,
 * and the ones a cross-origin guard applies to.
 *
 * @example
 * ```ts
 * import { Negotiation } from "@thomasfosterau/effect-jsonapi"
 *
 * console.log(Negotiation.isMutatingMethod("patch"), Negotiation.isMutatingMethod("HEAD"))
 * // → true false
 * ```
 *
 * @since 0.16.0
 * @category guards
 */
export const isMutatingMethod = (method: string): boolean =>
  WRITE_METHODS.has(method.toUpperCase());

// ---------------------------------------------------------------------------
// Known-endpoint path matching
// ---------------------------------------------------------------------------

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Compiles one endpoint path (`/articles/:id`, `/articles/`) into a matcher:
 * `:param` segments become a single-segment wildcard and a trailing slash is
 * optional. `none` for a root (`/`) path, which would over-match every URL.
 */
const routePattern = (path: string): Option.Option<RegExp> => {
  const segments = path
    .replace(/\/+$/, "")
    .split("/")
    .filter((segment) => segment !== "");
  if (segments.length === 0) return Option.none();
  const body = segments
    .map((segment) => (segment.startsWith(":") ? "[^/]+" : escapeRegExp(segment)))
    .join("/");
  return Option.some(new RegExp(`^/${body}/?$`));
};

const groupsOf = (api: Options["api"]): ReadonlyArray<GroupLike> =>
  Array.isArray(api)
    ? (api as ReadonlyArray<GroupLike>)
    : Object.values((api as { readonly groups: { readonly [id: string]: GroupLike } }).groups);

/**
 * A matcher for the detail page of each listed URL segment — `/posts/<id>`,
 * `/notes/<id>` — the shape an {@link Alternate} over content pages needs.
 *
 * @example
 * ```ts
 * import { Negotiation } from "@thomasfosterau/effect-jsonapi"
 *
 * const isPage = Negotiation.detailPages(["posts", "notes"])
 * console.log(isPage("/posts/42"), isPage("/posts/42/"), isPage("/posts"), isPage("/posts/42/edit"))
 * // → true true false false
 * ```
 *
 * @since 0.16.0
 * @category constructors
 */
export const detailPages = (segments: ReadonlyArray<string>): ((pathname: string) => boolean) => {
  const pattern = new RegExp(`^/(?:${segments.map(escapeRegExp).join("|")})/[^/]+/?$`);
  return (pathname) => pattern.test(pathname);
};

// ---------------------------------------------------------------------------
// Accept analysis
// ---------------------------------------------------------------------------

interface AcceptEntry {
  readonly base: string;
  readonly clean: boolean;
  readonly weight: number;
}

const ALLOWED_PARAMETERS: ReadonlySet<string> = new Set(["ext", "profile"]);

/**
 * The entries of an `Accept` header. An unparseable `q` is the default
 * weight here (the client named the type; a malformed weight is not a
 * refusal), where `Middleware`'s §5 check treats it as one — the parser
 * reports the distinction and each caller decides.
 */
const acceptEntries = (header: string | null): ReadonlyArray<AcceptEntry> =>
  (header ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const { base, parameters, weight } = parseMediaType(entry);
      return {
        base,
        clean: parameters.every(([name]) => ALLOWED_PARAMETERS.has(name)),
        weight: weight ?? 1,
      };
    });

const maxWeight = (entries: ReadonlyArray<AcceptEntry>): number =>
  entries.reduce((max, entry) => Math.max(max, entry.weight), 0);

/**
 * Whether the entries a `predicate` selects are the client's **winning**
 * media type: at least one selected, clean entry has `q > 0`, and its weight
 * is at least every other entry's.
 */
const wins = (entries: ReadonlyArray<AcceptEntry>, predicate: (entry: AcceptEntry) => boolean) => {
  const selected = entries.filter((entry) => predicate(entry) && entry.clean && entry.weight > 0);
  if (selected.length === 0) return false;
  return maxWeight(selected) >= maxWeight(entries.filter((entry) => !predicate(entry)));
};

/**
 * The negotiation error a read on an api path answers, given its `Accept`
 * entries and the JSON:API ones among them (at least one).
 */
const readError = (
  entries: ReadonlyArray<AcceptEntry>,
  jsonapi: ReadonlyArray<AcceptEntry>,
  refuseExplicitly: boolean,
): Option.Option<NegotiationError> => {
  // `allParameterised` keys off whether any clean instance *exists*: a
  // clean `q=0` instance is an explicit refusal, not a §5 parameterisation.
  if (!jsonapi.some((entry) => entry.clean)) return Option.some(NOT_ACCEPTABLE);
  // Past that check a clean instance exists, so when no entry carries
  // `q > 0` it is a clean `q=0`: the client refused JSON:API and named
  // nothing else it would take.
  return refuseExplicitly && entries.every((entry) => entry.weight <= 0)
    ? Option.some(NOT_ACCEPTABLE_REFUSED)
    : Option.none();
};

// ---------------------------------------------------------------------------
// make
// ---------------------------------------------------------------------------

/**
 * Builds the negotiator for one api: {@link Negotiator.isApiPath} over every
 * endpoint path the api declares, and {@link Negotiator.negotiate} for the
 * per-request verdict.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { HttpApi } from "effect/http-api"
 * import { Endpoint, Group, MEDIA_TYPE, Negotiation, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", { attributes: { title: Schema.NonEmptyString } })
 * const Api = HttpApi.make("blog").add(
 *   Group.make(Article, Endpoint.get(Article), Endpoint.list(Article))
 * )
 * const { isApiPath, negotiate } = Negotiation.make({ api: Api })
 *
 * console.log(isApiPath("/articles/1"), isApiPath("/about"))
 * // → true false
 *
 * const read = (path: string, accept: string) =>
 *   negotiate(new Request(`https://example.test${path}`, { headers: { accept } }))
 *
 * console.log(read("/articles", MEDIA_TYPE))
 * // → { representation: "application/vnd.api+json", dispatch: true }
 * console.log(read("/articles", "text/html,*\/*;q=0.8"))
 * // → { representation: "text/html", dispatch: false }
 * console.log(read("/articles", `${MEDIA_TYPE};version=1`).error?.status)
 * // → 406
 * ```
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { HttpApi } from "effect/http-api"
 * import { Endpoint, Group, MEDIA_TYPE, Negotiation, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", { attributes: { title: Schema.NonEmptyString } })
 * const Api = HttpApi.make("blog").add(
 *   Group.make(Article, Endpoint.get(Article), Endpoint.list(Article))
 * )
 * // A client that refuses JSON:API on a JSON:API endpoint gets a 406, not a page.
 * const { negotiate } = Negotiation.make({ api: Api, onExplicitRefusal: "notAcceptable" })
 *
 * const read = (accept: string) =>
 *   negotiate(new Request("https://example.test/articles", { headers: { accept } }))
 *
 * console.log(read(`${MEDIA_TYPE};q=0`).error === Negotiation.NOT_ACCEPTABLE_REFUSED)
 * // → true
 * console.log(read(`${MEDIA_TYPE};q=0, text/html;q=0.5`))
 * // → { representation: "text/html", dispatch: false }
 * console.log(read(`${MEDIA_TYPE};q=0, application/json`).error)
 * // → undefined
 * ```
 *
 * @since 0.16.0
 * @category constructors
 */
export const make = (options: Options): Negotiator => {
  const fallback = options.fallback ?? "text/html";
  const alternates = options.alternates ?? [];
  const refuseExplicitly = options.onExplicitRefusal === "notAcceptable";
  const patterns = groupsOf(options.api).flatMap((group) =>
    Object.values(group.endpoints).flatMap((endpoint) =>
      Arr.fromOption(routePattern(endpoint.path)),
    ),
  );
  const isApiPath = (pathname: string): boolean =>
    patterns.some((pattern) => pattern.test(pathname));

  const html: Verdict = { representation: fallback, dispatch: false };
  const dispatch: Verdict = { representation: MEDIA_TYPE, dispatch: true };

  const negotiateRead = (request: Request): Verdict => {
    const pathname = new URL(request.url).pathname;
    const entries = acceptEntries(request.headers.get("accept"));
    // Alternates are negotiated first: they apply to their own paths, an
    // orthogonal media type / path set from the JSON:API surface.
    for (const alternate of alternates) {
      if (alternate.matches(pathname) && wins(entries, (e) => e.base === alternate.mediaType)) {
        return { representation: alternate.mediaType, dispatch: false };
      }
    }
    const jsonapi = entries.filter((entry) => entry.base === MEDIA_TYPE);
    if (jsonapi.length === 0 || !isApiPath(pathname)) return html;
    return Option.match(readError(entries, jsonapi, refuseExplicitly), {
      onSome: (error) => ({ ...html, error }),
      onNone: () => (wins(entries, (entry) => entry.base === MEDIA_TYPE) ? dispatch : html),
    });
  };

  const negotiateWrite = (request: Request): Verdict => {
    const header = request.headers.get("content-type");
    if (header === null) return html;
    const { base, parameters } = parseMediaType(header.trim());
    if (base !== MEDIA_TYPE || !isApiPath(new URL(request.url).pathname)) return html;
    if (!parameters.every(([name]) => ALLOWED_PARAMETERS.has(name))) {
      return { ...html, error: UNSUPPORTED_MEDIA_TYPE };
    }
    return dispatch;
  };

  const negotiate = (request: Request): Verdict => {
    const method = request.method.toUpperCase();
    if (method === "GET" || method === "HEAD") return negotiateRead(request);
    if (isMutatingMethod(method)) return negotiateWrite(request);
    return html;
  };

  return { isApiPath, negotiate };
};

// ---------------------------------------------------------------------------
// Seam helpers
// ---------------------------------------------------------------------------

/**
 * Serialises a {@link NegotiationError} into a JSON:API error `Response` —
 * for the framework hook that emits it, which has no Effect runtime at hand.
 *
 * @example
 * ```ts
 * import { Negotiation } from "@thomasfosterau/effect-jsonapi"
 *
 * const response = Negotiation.errorResponse(Negotiation.SERVICE_UNAVAILABLE)
 * console.log(response.status, response.headers.get("content-type"))
 * // → 503 application/vnd.api+json
 * ```
 *
 * @since 0.16.0
 * @category constructors
 */
export const errorResponse = (error: NegotiationError): Response =>
  new Response(
    JSON.stringify({
      errors: [
        {
          status: String(error.status),
          code: error.code,
          title: error.title,
          detail: error.detail,
        },
      ],
      jsonapi: { version: "1.1" },
    }),
    { status: error.status, headers: { "content-type": MEDIA_TYPE } },
  );

/**
 * Prepares a dispatched request for the internal `HttpApi` router.
 *
 * The router registers JSON payloads under the default `application/json`
 * encoding (`Group.flat` registers every write with
 * `payloadMediaType: "application/json"`), while the negotiated *external*
 * contract carries the JSON:API media type. The media-type discrimination
 * and the §5 rules are already enforced by {@link Negotiator.negotiate} at
 * the seam, so a write's `Content-Type` is relabelled to `application/json`
 * for the router to decode the (already-JSON) body. Reads pass through
 * unchanged, as the same object.
 *
 * @example
 * ```ts
 * import { MEDIA_TYPE, Negotiation } from "@thomasfosterau/effect-jsonapi"
 *
 * const write = new Request("https://example.test/articles", {
 *   method: "POST",
 *   headers: { "content-type": MEDIA_TYPE },
 *   body: "{}"
 * })
 * console.log(Negotiation.requestForRouter(write).headers.get("content-type"))
 * // → application/json
 * ```
 *
 * @since 0.16.0
 * @category constructors
 */
export const requestForRouter = (request: Request): Request => {
  if (!isMutatingMethod(request.method)) return request;
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  return new Request(request, { headers });
};
