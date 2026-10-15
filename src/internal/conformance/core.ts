/**
 * The conformance engine's data model, endpoint discovery and probe plumbing.
 *
 * Everything here is shape and mechanism; the normative rules themselves live
 * in `./spec.ts` (JSON:API v1.1) and `./profile.ts` (this package's profile).
 *
 * @since 0.15.0
 * @internal
 */
import {
  Array as Arr,
  Cause,
  Duration,
  Effect,
  Formatter,
  MutableHashSet,
  Option,
  Predicate,
  Result,
  SchemaAST,
  type Scope,
} from "effect";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
  HttpServerError,
  type HttpServerResponse,
} from "effect/http";
import type { HttpApi, HttpApiEndpoint } from "effect/http-api";
import { declaredNames } from "../declaredQuery.js";
import { ATOMIC_EXTENSION_URI, MEDIA_TYPE } from "../media.js";

// ---------------------------------------------------------------------------
// The rule model
// ---------------------------------------------------------------------------

/** @internal */
export type Tier = "spec" | "profile";

/** @internal */
export type Level = "MUST" | "MUST NOT" | "SHOULD" | "MAY";

/** @internal */
export interface Rule {
  readonly id: string;
  readonly tier: Tier;
  readonly section: string;
  readonly reference: string;
  readonly level: Level;
  readonly requirement: string;
}

/** @internal */
export interface Probe {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/** @internal */
export interface Finding {
  readonly rule: Rule;
  readonly detail: string;
  readonly expected: string;
  readonly observed: string;
  readonly probe: Probe | undefined;
}

/** @internal */
export interface Passed {
  readonly _tag: "Passed";
  readonly rule: Rule;
  readonly probes: number;
  readonly note: string | undefined;
}

/** @internal */
export interface Failed {
  readonly _tag: "Failed";
  readonly rule: Rule;
  readonly probes: number;
  readonly findings: ReadonlyArray<Finding>;
}

/** @internal */
export interface Skipped {
  readonly _tag: "Skipped";
  readonly rule: Rule;
  readonly reason: string;
}

/**
 * A rule that died — a defect, not a finding — before it reached a verdict.
 * `message` renders the defect, capped at 500 UTF-16 code units (a longer one
 * ends in `…`; one that cannot be rendered is `[unrenderable defect]`);
 * `defect` is the value as it was thrown.
 *
 * @internal
 */
export interface Errored {
  readonly _tag: "Errored";
  readonly rule: Rule;
  readonly message: string;
  readonly defect: unknown;
}

/** @internal */
export type Outcome = Passed | Failed | Skipped | Errored;

/** @internal */
export interface Gap {
  readonly area: string;
  readonly reason: string;
  readonly tracking: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

/** @internal */
export interface Observation {
  readonly probe: Probe;
  /** `0` when no response was obtained at all (the transport failed). */
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly contentType: string | undefined;
  readonly text: string;
  /** The parsed JSON body, or `undefined` when the body was empty or not JSON. */
  readonly body: unknown;
  readonly transportError: string | undefined;
  /**
   * Each redirect the kit followed to reach this answer, as the absolute URL
   * it then requested, in order; empty when the first answer was the answer.
   * Each is one more request (see {@link runner}).
   */
  readonly redirects: ReadonlyArray<string>;
  /**
   * The redirect the kit did not follow, when the answer was one: `status` is
   * then `0` and `transportError` says why, as for a lost response, since the
   * kit has no answer to read.
   */
  readonly unfollowed: Option.Option<Unfollowed>;
}

/**
 * A redirect the kit did not follow, and why.
 *
 * @internal
 */
export interface Unfollowed {
  /**
   * The `3xx` the server answered; for `"transport"`, the status of the
   * answer the transport ended with, or `0` when it ended in a transport
   * error — the note says which.
   */
  readonly status: number;
  /**
   * Its `Location`, resolved against the URL that answered it when it parses;
   * for `"transport"`, the URL the transport ended at.
   */
  readonly location: string;
  /**
   * Why: it leads off the base URL's origin, it is one hop past
   * {@link HOP_CAP}, the rule's request budget has no request left for it, it
   * would turn a write into a `GET`, its `Location` does not parse, or the
   * transport followed it itself (one wrapped in `HttpClient.followRedirects`,
   * say) to another origin or turning the method into a `GET` — the kit then
   * has an answer, or a transport error, from a request it would not have
   * sent, and does not read it.
   */
  readonly reason: "offsite" | "cap" | "budget" | "method" | "unparseable" | "transport";
  /** The reason as a note names it. */
  readonly why: string;
}

/**
 * Splits a media type into its lowercased base and its parameters, with quoted
 * parameter values unquoted.
 *
 * Deliberately a second implementation rather than a reuse of `Middleware`'s:
 * the kit audits the middleware, so it must read the wire itself.
 *
 * @internal
 */
export const parseMediaType = (
  header: string,
): {
  readonly base: string;
  readonly parameters: ReadonlyArray<readonly [name: string, value: string]>;
} => {
  const [first, ...rest] = header.split(";");
  return {
    base: (first ?? "").trim().toLowerCase(),
    parameters: rest.map((part) => {
      const eq = part.indexOf("=");
      if (eq === -1) return [part.trim().toLowerCase(), ""] as const;
      const name = part.slice(0, eq).trim().toLowerCase();
      const raw = part.slice(eq + 1).trim();
      const value =
        raw.startsWith(`"`) && raw.endsWith(`"`) && raw.length >= 2 ? raw.slice(1, -1) : raw;
      return [name, value] as const;
    }),
  };
};

// ---------------------------------------------------------------------------
// Endpoint discovery
// ---------------------------------------------------------------------------

/**
 * The JSON:API role an endpoint plays, resolved from its method and the shape
 * of its path. Every role but `unknown` has conventional spec semantics the
 * rules can probe.
 *
 * @internal
 */
export type Role =
  | "collection"
  | "resource"
  | "create"
  | "update"
  | "delete"
  | "related"
  | "relationship"
  | "relationshipWrite"
  | "operations"
  | "unknown";

/** @internal */
export interface Discovered {
  readonly group: string;
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly role: Role;
  /** The first literal path segment — the resource type under the conventional paths. */
  readonly segment: string | undefined;
  readonly params: ReadonlyArray<string>;
  /** Flat wire query keys (`include`, `page[limit]`, `fields[articles]`, …). */
  readonly queryKeys: ReadonlyArray<string>;
  /**
   * `false` when the query could accept a name discovery cannot enumerate — a
   * record keyed by any string, say — so `queryKeys` (then empty) cannot say
   * what it does not declare. `Middleware` stands aside for such an endpoint.
   */
  readonly queryEnumerable: boolean;
  /** `true` when the query admits arbitrary `filter[…]` keys — `filter: true`, the grammar. */
  readonly filterGrammar: boolean;
  /**
   * The family prefixes the query declares an open record of (`filter[`, the
   * grammar's; a hand-built `fields[` or `page[`), each admitting every name
   * it opens. `queryKeys` leaves them out.
   */
  readonly queryPrefixes: ReadonlyArray<string>;
}

const resolveEncoding = SchemaAST.resolveAt<{ readonly contentType?: string | undefined }>(
  "~httpApiEncoding",
);

/**
 * What an endpoint's query declares, by the walk `Middleware` checks requests
 * against: its flat keys, and apart from them the family prefixes an open
 * record contributes (`filter[`, a `filter: true` rest's), or nothing
 * enumerable at all.
 */
const wireKeys = (
  schema: { readonly ast: SchemaAST.AST } | undefined,
): Pick<Discovered, "queryKeys" | "queryEnumerable" | "filterGrammar" | "queryPrefixes"> =>
  Option.match(schema === undefined ? Option.some([]) : declaredNames(schema.ast), {
    onNone: () => ({
      queryKeys: [],
      queryEnumerable: false,
      filterGrammar: false,
      queryPrefixes: [],
    }),
    onSome: (names) => ({
      queryKeys: names.filter((name) => !name.endsWith("[")),
      queryEnumerable: true,
      filterGrammar: names.includes("filter["),
      queryPrefixes: names.filter((name) => name.endsWith("[")),
    }),
  });

const roleOf = (method: string, segments: ReadonlyArray<string>): Role => {
  const shape = segments.map((segment) => (segment.startsWith(":") ? "P" : "L")).join("");
  const literals = segments.filter((segment) => !segment.startsWith(":"));
  switch (`${method} ${shape}`) {
    case "GET L":
      return "collection";
    case "GET LP":
      return "resource";
    case "POST L":
      return "create";
    case "PATCH LP":
    case "PUT LP":
      return "update";
    case "DELETE LP":
      return "delete";
    case "GET LPL":
      return "related";
    case "GET LPLL":
      return literals[1] === "relationships" ? "relationship" : "unknown";
    case "PATCH LPLL":
    case "POST LPLL":
    case "DELETE LPLL":
      return literals[1] === "relationships" ? "relationshipWrite" : "unknown";
    default:
      return "unknown";
  }
};

/**
 * Walks an `HttpApi` value and classifies every endpoint. Discovery is static —
 * nothing is requested here — so a report can name both the endpoints it probed
 * and the ones it could not resolve a URL for.
 *
 * @internal
 */
export const discover = (api: HttpApi.HttpApi<string, any>): ReadonlyArray<Discovered> => {
  const out: Array<Discovered> = [];
  const groups = api.groups as unknown as Readonly<
    Record<string, { readonly endpoints: Readonly<Record<string, HttpApiEndpoint.Top>> }>
  >;
  for (const group of Object.keys(groups)) {
    const endpoints = groups[group]!.endpoints;
    for (const name of Object.keys(endpoints)) {
      const endpoint = endpoints[name]!;
      const segments = endpoint.path.split("/").filter((segment) => segment !== "");
      const query = wireKeys(endpoint.query);
      let responseMediaType: string | undefined;
      for (const success of endpoint.success) {
        const encoding = resolveEncoding(success.ast);
        if (encoding?.contentType !== undefined) {
          responseMediaType = encoding.contentType;
          break;
        }
      }
      const atomic =
        responseMediaType !== undefined && responseMediaType.includes(ATOMIC_EXTENSION_URI);
      out.push({
        group,
        name,
        method: endpoint.method,
        path: endpoint.path,
        role: atomic ? "operations" : roleOf(endpoint.method, segments),
        segment: segments.find((segment) => !segment.startsWith(":")),
        params: segments
          .filter((segment) => segment.startsWith(":"))
          .map((segment) => segment.slice(1)),
        ...query,
      });
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// Options and the write fixture
// ---------------------------------------------------------------------------

/**
 * A resource object, without an `id`, that a create endpoint will accept — in
 * its wire (encoded) form, because the kit sends it as raw JSON.
 *
 * @internal
 */
export interface Payload {
  readonly type: string;
  readonly attributes?: Readonly<Record<string, unknown>> | undefined;
  readonly relationships?: Readonly<Record<string, unknown>> | undefined;
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
}

/** @internal */
export interface Fixture {
  /**
   * A resource object the server will accept on `POST /<type>`, without an
   * `id`. Called once per create the kit makes, so a fixture under a
   * uniqueness constraint can return a fresh value each time.
   */
  readonly create?: (() => Payload) | undefined;
  /**
   * The `attributes` / `relationships` of a PATCH that must succeed against a
   * resource `create` made. The kit adds `type` and `id`.
   */
  readonly update?: (() => Omit<Payload, "type">) | undefined;
  /**
   * Removes a resource the kit created, by the id the server assigned it. Run
   * for every resource the kit created, could identify and did not itself
   * delete — after the rule that made it, whether that rule passed, failed or
   * died. It runs uninterruptibly, so one that never completes hangs the run.
   */
  readonly cleanup?: ((id: string) => Effect.Effect<unknown, unknown>) | undefined;
}

/**
 * What became of a resource the kit created: removed by the kit's own DELETE
 * probe, removed by the fixture's `cleanup`, `cleanup` failed, or left behind
 * because the fixture supplied no `cleanup` (or the response named no id).
 *
 * @internal
 */
export type Disposal = "deleted" | "cleaned-up" | "cleanup-failed" | "left";

/** @internal */
export interface WriteRecord {
  readonly type: string;
  /**
   * The id the server answered with, or `undefined` when the response named
   * none — or named one the kit would not act on (`detail` says which).
   */
  readonly id: string | undefined;
  /** The id of the rule whose probe created it. */
  readonly rule: string;
  readonly disposal: Disposal;
  readonly detail: string | undefined;
}

/** @internal */
export interface ResolvedOptions {
  readonly baseUrl: string;
  readonly ids: Readonly<Record<string, string>>;
  readonly paths: Readonly<Record<string, string>>;
  readonly absentId: string;
  readonly extensions: ReadonlyArray<string>;
  readonly mutating: boolean;
  readonly writes: Readonly<Record<string, Fixture>>;
  /**
   * The longest the kit waits for one request's answer, resolved by
   * {@link requestTimeoutOf}; none when the run turned it off.
   */
  readonly requestTimeout: Option.Option<Duration.Duration>;
}

// ---------------------------------------------------------------------------
// URL resolution
// ---------------------------------------------------------------------------

/** @internal */
export type Resolution =
  | { readonly _tag: "Resolved"; readonly path: string }
  | { readonly _tag: "Unresolved"; readonly reason: string };

/**
 * Substitutes a concrete URL path for a discovered endpoint, or explains why it
 * cannot. The explanation is what a `Skipped` outcome reports, so it names the
 * exact option key the caller is missing.
 *
 * @internal
 */
export const resolvePath = (endpoint: Discovered, options: ResolvedOptions): Resolution => {
  const key = `${endpoint.group}.${endpoint.name}`;
  const override = options.paths[key];
  if (override !== undefined) return { _tag: "Resolved", path: override };
  if (endpoint.params.length === 0) return { _tag: "Resolved", path: endpoint.path };
  const type = endpoint.segment;
  if (type === undefined) {
    return {
      _tag: "Unresolved",
      reason: `${endpoint.path} has path parameters and no literal segment to key a sample id on — pass paths["${key}"]`,
    };
  }
  const id = options.ids[type];
  if (id === undefined) {
    return {
      _tag: "Unresolved",
      reason: `no sample id for "${type}" — pass ids["${type}"] or paths["${key}"]`,
    };
  }
  if (endpoint.params.length > 1) {
    return {
      _tag: "Unresolved",
      reason: `${endpoint.path} has ${endpoint.params.length} path parameters — pass paths["${key}"]`,
    };
  }
  return {
    _tag: "Resolved",
    path: endpoint.path.replace(`:${endpoint.params[0]}`, encodeURIComponent(id)),
  };
};

// ---------------------------------------------------------------------------
// The probe runner
// ---------------------------------------------------------------------------

/** @internal */
export interface Context {
  readonly endpoints: ReadonlyArray<Discovered>;
  readonly options: ResolvedOptions;
  /**
   * Every resource a write probe created, in creation order, with what became
   * of it — the run's audit trail. Appended to by `./write.ts` only.
   */
  readonly writes: Array<{ -readonly [K in keyof WriteRecord]: WriteRecord[K] }>;
  /**
   * The `idKey` of every resource a successful `GET` has shown the run —
   * primary, included, or named by a relationship. The server held each of
   * them before the kit asked, so a create response naming one did not make
   * it. Filled by `observing`.
   */
  readonly observed: MutableHashSet.MutableHashSet<string>;
  readonly request: (probe: {
    readonly method?: string;
    readonly url: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: unknown;
    /**
     * The most requests this probe may make, the redirects it follows
     * included — what a budgeted rule has left. Defaults to the first request
     * and {@link HOP_CAP} redirects.
     */
    readonly requests?: number;
  }) => Effect.Effect<Observation>;
}

const headerRecord = (
  headers: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const key of Object.keys(headers)) {
    const value = headers[key];
    if (value !== undefined) out[key.toLowerCase()] = value;
  }
  return out;
};

/**
 * The client request for a probe. A body is sent under the probe's own
 * `Content-Type` — the JSON:API media type unless the probe says otherwise —
 * never `application/json`, which a JSON:API server is entitled to refuse
 * before reading the body.
 */
const clientRequest = (url: string, probe: Probe): HttpClientRequest.HttpClientRequest => {
  // SAFETY: `make` is typed over the `HttpMethod` literals; every probe's method
  // is a literal a rule wrote or a discovered endpoint's method, each of which
  // is one of them, and "GET" is only the narrowest spelling of that union.
  const request = HttpClientRequest.make(probe.method as "GET")(url, { headers: probe.headers });
  return probe.body === undefined
    ? request
    : HttpClientRequest.setBody(
        request,
        HttpBody.jsonUnsafe(probe.body, probe.headers["content-type"] ?? MEDIA_TYPE),
      );
};

/**
 * `effect`, with any redirect a `fetch`-based transport would follow left
 * unfollowed (`redirect: "manual"`), the rest of the run's own
 * `FetchHttpClient.RequestInit` kept — `redirect` is set last, so a run's
 * `redirect: "follow"` cannot override it. A redirect answers the transport as
 * itself, the `3xx` the server sent, and the kit decides whether to follow it
 * (see {@link runner}), checking where it leads before it is requested. A
 * transport that is not `fetch`-based never reads `RequestInit`, and is
 * unaffected.
 */
const unredirected = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(Effect.serviceOption(FetchHttpClient.RequestInit), (init) =>
    Effect.provideService(effect, FetchHttpClient.RequestInit, {
      ...Option.getOrUndefined(init),
      redirect: "manual",
    }),
  );

/**
 * The redirect a transport followed itself (one wrapped in
 * `HttpClient.followRedirects`, say), when where it `ended` — the request
 * behind its answer, or behind its failure — is not `sent`, the request as
 * the client sent it: on another origin, or with another method (a `301` or
 * `302` turns a `POST`, a `303` any method but `GET`, into a `GET`). `sent` is
 * the kit's request after the client's own `preprocess`, so a client that
 * rewrites every request (`HttpClient.mapRequest` onto another origin, say)
 * is read as the server it sends to, not as one that followed a redirect.
 * The kit does not read that answer, so the request is left as one a redirect
 * answered that the kit did not follow — not decided, as for any other (owner
 * decision on #333). `status` is the answer's, or `0` when the transport
 * failed there. Only where the transport ended is checked: a chain that left
 * the origin and came back, keeping the method, is read.
 */
const transportFollowed = (
  sent: { readonly method: string; readonly url: string },
  ended: { readonly status: number; readonly method: string; readonly url: string },
): Option.Option<Unfollowed> => {
  if (!URL.canParse(sent.url) || !URL.canParse(ended.url)) return Option.none();
  const from = new URL(sent.url).origin;
  const to = new URL(ended.url).origin;
  const refusals: ReadonlyArray<readonly [boolean, () => string]> = [
    [
      from !== to,
      () =>
        `${to} is another origin than the one the request was sent to, ${from}, and the transport has already tried the request there`,
    ],
    [
      ended.method !== sent.method,
      () =>
        `the transport turned the ${sent.method} into a ${ended.method} on the way, which the kit does not send in its place`,
    ],
  ];
  return Option.map(
    Option.fromUndefinedOr(refusals.find(([applies]) => applies)),
    ([, why]): Unfollowed => ({
      status: ended.status,
      location: ended.url,
      reason: "transport",
      why: why(),
    }),
  );
};

/** The URL `request` is sent to, its query included. */
const urlOf = (request: HttpClientRequest.HttpClientRequest): string =>
  Option.match(HttpClientRequest.toUrl(request), {
    onNone: () => request.url,
    onSome: (url) => url.href,
  });

/** An `Observation` for a probe the transport returned no answer to read for. */
const unread = (
  probe: Probe,
  transportError: string,
  redirects: ReadonlyArray<string> = [],
  unfollowed: Option.Option<Unfollowed> = Option.none(),
): Observation => ({
  probe,
  status: 0,
  headers: {},
  contentType: undefined,
  text: "",
  body: undefined,
  transportError,
  redirects,
  unfollowed,
});

/**
 * The most redirects the kit follows for one probe. A chain longer than this
 * leaves the probe not decided, naming the `Location` it stopped at.
 *
 * @internal
 */
export const HOP_CAP = 5;

/** The statuses that redirect to their `Location`. */
const REDIRECTS: ReadonlyArray<number> = [301, 302, 303, 307, 308];

/** The longest `Location` a note quotes, in UTF-16 code units. */
const LOCATION_LIMIT = 200;

/**
 * A redirect as a note names it, and why the kit did not follow it: "302 to
 * https://elsewhere.test/articles, another origin than the base URL's
 * (http://fixture.test) — the kit follows a redirect only within that origin".
 *
 * @internal
 */
export const unfollowedNote = ({ status, location, reason, why }: Unfollowed): string =>
  reason === "transport"
    ? `a redirect the transport followed itself, ${status === 0 ? `ending in a transport error at ${capped(location, LOCATION_LIMIT)}` : `ending at ${capped(location, LOCATION_LIMIT)} with a ${status}, whose answer the kit does not read`}: ${why}`
    : `a ${status} redirect to ${capped(location, LOCATION_LIMIT)}, which the kit does not follow: ${why}`;

/** Where a `Location` off the base URL's origin leads, as a note names it. */
const offsiteWhy = (resolved: URL, origin: string): string =>
  `${resolved.origin === "null" ? `a \`${resolved.protocol}\` URL has no origin` : `${resolved.origin} is another origin than the base URL's, ${origin}`} — the kit follows a redirect only within the base URL's origin, and a change of scheme or port is a change of origin`;

/**
 * `true` when following a redirect sends the method it answers: `307` and
 * `308` re-send it; the rest turn it into a `GET`, which only a `GET` keeps.
 * The kit sends no `HEAD`.
 */
const keepsMethod = (status: number, method: string): boolean =>
  status === 307 || status === 308 || method === "GET";

/**
 * Why the kit does not take a hop to `resolved`, the first that applies in
 * order, or none when it takes it.
 */
const refusalOf = (
  status: number,
  resolved: URL,
  sent: { readonly method: string },
  origin: string,
  budget: { readonly hops: number; readonly allowed: number },
): Option.Option<readonly [Unfollowed["reason"], string]> => {
  const refusals: ReadonlyArray<readonly [boolean, Unfollowed["reason"], () => string]> = [
    [resolved.origin !== origin, "offsite", () => offsiteWhy(resolved, origin)],
    [
      !keepsMethod(status, sent.method),
      "method",
      () =>
        `a ${status} turns a ${sent.method} into a \`GET\`, which the kit does not send in its place`,
    ],
    [
      budget.hops >= HOP_CAP,
      "cap",
      () => `it would be redirect ${budget.hops + 1} in a row, past the kit's cap of ${HOP_CAP}`,
    ],
    [
      budget.hops + 1 >= budget.allowed,
      "budget",
      () => "the rule's request budget has no request left for it",
    ],
  ];
  return Option.map(
    Option.fromUndefinedOr(refusals.find(([applies]) => applies)),
    ([, reason, why]) => [reason, why()] as const,
  );
};

/**
 * Where `location` leads, resolved against `sent`, the URL the kit built. A
 * client that rewrites each request onto another origin
 * (`HttpClient.mapRequest` onto a local port, say) sends it to `sentTo`, the
 * URL after its own `preprocess`, and an absolute `Location` on that origin names a path on the
 * server the client sends to: the kit reads it as a `Location` of that path
 * alone, on its own origin, so the hop is a request the kit builds and the
 * client rewrites once, as any other. A client that rewrites the path too
 * (adding a prefix, say) so adds it again to the path a hop names, as it does
 * to a relative `Location`'s. A rewritten URL with no origin (a `data:` or
 * custom-scheme one, whose origin is `"null"`) is never matched, so a
 * `Location` with no origin is not read as a path on the kit's.
 */
const resolvedLocation = (location: string, sent: string, sentTo: string): URL => {
  const resolved = new URL(location, sent);
  const own = new URL(sent).origin;
  const rewritten = URL.canParse(sentTo) ? new URL(sentTo).origin : own;
  return rewritten !== own && rewritten !== "null" && resolved.origin === rewritten
    ? new URL(`${resolved.pathname}${resolved.search}${resolved.hash}`, sent)
    : resolved;
};

/**
 * The next hop of a redirect `answer` to `sent`, which the client sent to
 * `sentTo`, or why the kit does not take it.
 */
const hopOf = (
  answer: { readonly status: number; readonly location: string },
  sent: { readonly method: string; readonly url: string; readonly sentTo: string },
  origin: string,
  budget: { readonly hops: number; readonly allowed: number },
): Result.Result<{ readonly method: string; readonly url: string }, Unfollowed> => {
  const { status, location } = answer;
  if (!URL.canParse(location, sent.url)) {
    return Result.fail({
      status,
      location,
      reason: "unparseable",
      why: "its `Location` is not a URL the kit can resolve",
    });
  }
  const resolved = resolvedLocation(location, sent.url, sent.sentTo);
  return Option.match(refusalOf(status, resolved, sent, origin, budget), {
    onNone: () => Result.succeed({ method: sent.method, url: resolved.href }),
    // Named as the server sent it, not as the kit translated it to its own origin.
    onSome: ([reason, why]) =>
      Result.fail({ status, location: new URL(location, sent.url).href, reason, why }),
  });
};

/** What one request came to: the probe's observation, or a redirect hop to take. */
type Step =
  | { readonly _tag: "Answered"; readonly observation: Observation }
  | { readonly _tag: "Hop"; readonly next: { readonly method: string; readonly url: string } };

const answered = (observation: Observation): Step => ({ _tag: "Answered", observation });

/**
 * The note a request `requestTimeout` cut short is named by, in
 * `transportError`.
 *
 * @internal
 */
export const timedOutNote = (timeout: Duration.Duration): string =>
  `no answer within ${Duration.format(timeout)}, the run's \`requestTimeout\``;

/**
 * How long the kit waits for one request when the run does not say:
 * thirty seconds (owner decision on #302).
 *
 * @internal
 */
export const DEFAULT_REQUEST_TIMEOUT: Duration.Duration = Duration.seconds(30);

/**
 * `Options.requestTimeout` resolved: {@link DEFAULT_REQUEST_TIMEOUT} when
 * unset, none (no timeout) for `"Infinity"` or `Duration.infinity`, and the
 * duration given otherwise. A duration that is not positive — zero, negative,
 * `NaN` (which `Duration` reads as zero) — or that is not a duration at all
 * would cut every request short before it was sent, so it is a defect in the
 * caller's options, not a run to report.
 *
 * @internal
 */
export const requestTimeoutOf = (
  given: Option.Option<Duration.Input>,
): Effect.Effect<Option.Option<Duration.Duration>> => {
  if (Option.isNone(given)) return Effect.succeed(Option.some(DEFAULT_REQUEST_TIMEOUT));
  const input = given.value;
  const timeout = Duration.fromInput(input);
  if (Option.isSome(timeout) && Duration.isPositive(timeout.value)) {
    return Effect.succeed(Duration.isFinite(timeout.value) ? timeout : Option.none());
  }
  return Effect.die(
    new RangeError(
      `Conformance: \`requestTimeout\` must be a positive duration \`Duration\` can read, or "Infinity" for no timeout; got ${Formatter.format(input)}`,
    ),
  );
};

/**
 * `request`, one request and the reading of its answer, bounded by `timeout`
 * when there is one. A request still unanswered then is interrupted — over
 * `fetch`, aborted — and read as a lost response: `status: 0`, with
 * {@link timedOutNote} in `transportError` and no redirect in `unfollowed`, so
 * a rule reads it as it reads any transport error (not as a redirect the kit
 * did not follow). It covers the whole of the client's `execute`, so a
 * client's own `retry` runs within it, and the answer's body, so a server
 * that sends its headers and holds the body open is cut short too. Each
 * redirect hop is a request of its own, with a timeout of its own.
 */
const timed = (
  request: Effect.Effect<Step, never, Scope.Scope>,
  probe: Probe,
  redirects: ReadonlyArray<string>,
  timeout: Option.Option<Duration.Duration>,
): Effect.Effect<Step, never, Scope.Scope> =>
  Option.match(timeout, {
    onNone: () => request,
    onSome: (bound) =>
      Effect.map(
        Effect.timeoutOption(request, bound),
        Option.getOrElse(() => answered(unread(probe, timedOutNote(bound), redirects))),
      ),
  });

/**
 * Builds the probe runner over an `HttpClient`. A transport failure becomes an
 * `Observation` with `status: 0` rather than an error, so one unreachable
 * endpoint is reported as a finding instead of aborting the whole run.
 *
 * A redirect is followed only when its `Location` stays on the base URL's
 * origin (owner decision on #168): the kit requests each hop itself, after
 * checking where it leads, so no request is ever sent to another origin on a
 * server's say-so. A `301`, `302` or `303` is followed only for a `GET`,
 * since `fetch` would turn any other method into a `GET`; a `307` or `308`
 * re-sends the same method and body. At most {@link HOP_CAP} hops are
 * followed, and no more than `requests` allows, the first request included.
 * The final answer is the observation, with the hops in `redirects`. A redirect
 * the kit does not follow leaves the probe with no answer to read: `status: 0`,
 * with the redirect in `unfollowed` and named in `transportError`.
 *
 * The kit runs each request through the client as its own `execute` does —
 * `postprocess` over `preprocess` — and keeps the request `preprocess` last
 * produced, where `HttpClient.mapRequest` rewrites it: the request the client
 * sent. A `Location` on that request's origin is followed as one on the base
 * URL's (see {@link resolvedLocation}).
 *
 * The transport itself follows nothing (see {@link unredirected}). An answer,
 * or a transport error, a transport brought back all the same from a redirect
 * it followed on its own — to another origin than the request the client
 * sent, or turning the method into a `GET` — is not read: it is recorded as a
 * redirect the kit did not follow (`reason: "transport"`), naming where the
 * transport ended up, so it leaves the rule not decided as any other does
 * (see {@link transportFollowed}). A failure of `preprocess` itself, with no
 * request sent, is read as any other transport error.
 *
 * With a `requestTimeout` (none when the run turned it off), each request —
 * the first and each hop — has that long to be answered and read, the
 * client's `execute` and the body both, and one that is not reads as a lost
 * response naming the timeout (see {@link timed}).
 * The timeout wraps the client's `postprocess` from outside, so the request
 * still runs through the client exactly as its `execute` runs it.
 *
 * @internal
 */
export const runner =
  (
    client: HttpClient.HttpClient,
    baseUrl: string,
    requestTimeout: Option.Option<Duration.Duration>,
  ): Context["request"] =>
  (probe) => {
    const method = probe.method ?? "GET";
    const headers = probe.headers ?? jsonApiAccept;
    const first = probe.url.startsWith("http")
      ? probe.url
      : `${baseUrl.replace(/\/$/, "")}${probe.url}`;
    const record: Probe = { method, url: probe.url, headers, body: probe.body };
    const origin = new URL(URL.canParse(baseUrl) ? baseUrl : first).origin;
    const allowed = probe.requests ?? HOP_CAP + 1;
    /**
     * Sends one request and reads its answer: the observation, or the hop its
     * redirect leads to when the kit takes it. One request, so what
     * `requestTimeout` bounds (see {@link timed}).
     */
    const step = (
      sent: { readonly method: string; readonly url: string },
      redirects: ReadonlyArray<string>,
    ): Effect.Effect<Step, never, Scope.Scope> =>
      Effect.gen(function* () {
        const request = clientRequest(sent.url, { ...record, method: sent.method });
        // The request as the client sends it: what its own `preprocess` — where
        // `HttpClient.mapRequest` rewrites it (onto another origin, say) — last
        // produced. `postprocess` is handed `preprocess` itself, as `execute`
        // hands it, so a client's `retry` or `catchTag` (built on its
        // `postprocess`) still runs `preprocess` again for each attempt, and
        // recovers from its failure; `HttpClient.followRedirects` follows in
        // `postprocess`, after it. Reset each attempt, so none when the last
        // one never sent a request.
        // `preprocess` is built once, as `execute` builds it, so a
        // `HttpClient.mapRequestInput` runs its function once per request, not
        // once per attempt.
        let prepared = Option.none<HttpClientRequest.HttpClientRequest>();
        const preprocessed = Effect.tap(client.preprocess(request), (sentAs) =>
          Effect.sync(() => {
            prepared = Option.some(sentAs);
          }),
        );
        const result = yield* Effect.result(
          unredirected(
            client.postprocess(
              Effect.suspend(() => {
                prepared = Option.none();
                return preprocessed;
              }),
            ),
          ),
        );
        // A `preprocess` that failed sent nothing, so no redirect was followed.
        if (Option.isNone(prepared) && Result.isFailure(result)) {
          return answered(unread(record, String(result.failure), redirects));
        }
        const sentAs = Option.getOrElse(prepared, () => request);
        // Where the transport ended: the request behind its failure or its
        // answer, which is not the one the client sent when it followed a
        // redirect.
        const ended = Result.match(result, {
          onFailure: ({ request: failed }) => ({
            status: 0,
            method: failed.method,
            url: urlOf(failed),
          }),
          onSuccess: (response) => ({
            status: response.status,
            method: response.request.method,
            url: response.url,
          }),
        });
        const sentTo = urlOf(sentAs);
        const followed = transportFollowed({ method: sentAs.method, url: sentTo }, ended);
        if (Option.isSome(followed)) {
          return answered(unread(record, unfollowedNote(followed.value), redirects, followed));
        }
        if (Result.isFailure(result)) {
          return answered(unread(record, String(result.failure), redirects));
        }
        const response = result.success;
        const location = response.headers["location"];
        // An empty `Location` names nothing to follow, as a missing one does.
        if (!REDIRECTS.includes(response.status) || location === undefined || location === "") {
          return answered(yield* answerOf(record, response, redirects));
        }
        const hop = hopOf({ status: response.status, location }, { ...sent, sentTo }, origin, {
          hops: redirects.length,
          allowed,
        });
        return Result.match(hop, {
          onFailure: (unfollowed): Step =>
            answered(
              unread(record, unfollowedNote(unfollowed), redirects, Option.some(unfollowed)),
            ),
          onSuccess: (next): Step => ({ _tag: "Hop", next }),
        });
      });
    /**
     * Sends one request, then the hop its redirect leads to, if the kit takes
     * it, each under its own `requestTimeout`.
     */
    const send = (
      sent: { readonly method: string; readonly url: string },
      redirects: ReadonlyArray<string>,
    ): Effect.Effect<Observation, never, Scope.Scope> =>
      Effect.flatMap(timed(step(sent, redirects), record, redirects, requestTimeout), (taken) =>
        Predicate.isTagged(taken, "Answered")
          ? Effect.succeed(taken.observation)
          : send(taken.next, [...redirects, taken.next.url]),
      );
    return send({ method, url: first }, []).pipe(Effect.scoped, Effect.orDie);
  };

/** The observation of an answer the kit reads: its status, headers and body. */
const answerOf = (
  probe: Probe,
  response: HttpClientResponse.HttpClientResponse,
  redirects: ReadonlyArray<string>,
): Effect.Effect<Observation> =>
  Effect.gen(function* () {
    const textResult = yield* Effect.result(response.text);
    const text = Result.isSuccess(textResult) ? textResult.success : "";
    const headersOut = headerRecord(response.headers);
    let body: unknown;
    if (text !== "") {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = undefined;
      }
    }
    return {
      probe,
      status: response.status,
      headers: headersOut,
      contentType: headersOut["content-type"],
      text,
      body,
      transportError: undefined,
      redirects,
      unfollowed: Option.none(),
    } satisfies Observation;
  });

/**
 * A router's answer as a deployed server gives it, for the in-process
 * transport: a request no route serves (`RouteNotFound`) is the router's own
 * empty 404, not a defect that kills the rule that sent it — a link the server
 * emitted can lead to such a path. Any other failure is not something a
 * deployed server answers in a known way, so it dies, as before.
 *
 * @internal
 */
export const answeredAsDeployed = <R>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, HttpServerError.HttpServerError, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> =>
  handler.pipe(
    Effect.catchReason("HttpServerError", "RouteNotFound", (reason) =>
      Effect.map(HttpServerError.causeResponse(Cause.fail(reason)), ([answer]) => answer),
    ),
    Effect.orDie,
  );

// ---------------------------------------------------------------------------
// Rule authoring helpers
// ---------------------------------------------------------------------------

/** @internal */
export interface RuleImpl {
  readonly rule: Rule;
  readonly run: (ctx: Context) => Effect.Effect<Outcome>;
  /**
   * Set on a rule that creates resources (through `./write.ts`). A run sends
   * every other rule's requests first, so that what the reads show is known
   * before any create is vetted against it — see `Context.observed`.
   */
  readonly creates?: true;
  /**
   * Set on the one rule that decides for itself what a redirect the kit did
   * not follow means: `spec/target/reachable`, which reports a read endpoint
   * that answers with one. Every other rule — the link rules and the
   * pagination walk included — is held to {@link undecidedByRedirects}.
   */
  readonly ownsRedirects?: true;
}

/** @internal */
export const pass = (rule: Rule, probes: number, note?: string): Passed => ({
  _tag: "Passed",
  rule,
  probes,
  note,
});

/** @internal */
export const skip = (rule: Rule, reason: string): Skipped => ({ _tag: "Skipped", rule, reason });

/**
 * An `Error` as `Name: message`, or the name alone when it carries no message.
 * Both go through a template, so a `name` or `message` that is not a string
 * but coerces to one (a number, say) still renders; one that cannot coerce (a
 * Symbol, or an object whose `toString` throws) throws here, and the defect's
 * message falls back to {@link UNRENDERABLE}.
 */
const errorMessage = (error: Error): string =>
  error.message === "" ? `${error.name}` : `${error.name}: ${error.message}`;

/** The longest `Errored.message`, in UTF-16 code units, the marker included. */
const MESSAGE_LIMIT = 500;

/**
 * `message` cut to {@link MESSAGE_LIMIT}, ending in `…` when it was cut. The
 * cut never splits a surrogate pair: a high surrogate it would leave last is
 * dropped too.
 */
const capped = (message: string, limit: number = MESSAGE_LIMIT): string => {
  if (message.length <= limit) return message;
  const end = limit - 1;
  const last = message.charCodeAt(end - 1);
  return `${message.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end)}…`;
};

/** `Errored.message` for a defect the kit cannot read at all — see {@link renderThrown}. */
const UNRENDERABLE = "[unrenderable defect]";

/**
 * A thrown or failed value as one report line: an `Error` by its name and
 * message, so a thrown tagged error with no message still says what it was;
 * anything else — a string, `null`, a plain object — as itself, not dressed up
 * as an `Error`; capped at {@link MESSAGE_LIMIT}. Total, so the report the
 * caller is building survives whatever it is given. Only a value that cannot be
 * read at all renders as {@link UNRENDERABLE}: one `Predicate.isError` throws
 * on (a revoked `Proxy`, or one whose `getPrototypeOf` trap throws), or an
 * `Error` whose `name` or `message` throws when read or cannot become a string
 * (a Symbol, or an object whose `toString` throws). `Formatter.format` reads
 * past a part of any other value that throws and marks that part itself —
 * `[toString threw]` for an object whose `toString` throws,
 * `[property access threw]` for a getter that throws, `[inspection threw]` for
 * a `Proxy` whose `get` trap throws.
 *
 * Shared by a rule's `Errored.message` and the write fixture's skip reasons and
 * `cleanup-failed` details, so a value renders the same wherever it surfaces.
 *
 * @internal
 */
// oxlint-disable-next-line effect/no-unknown-parameters -- renders whatever a rule or fixture threw or failed with; a thrown value has no schema to parse it by
export const renderThrown = (thrown: unknown): string =>
  Result.merge(
    Result.try({
      try: () =>
        capped(
          Predicate.isError(thrown)
            ? errorMessage(thrown)
            : Predicate.isString(thrown)
              ? thrown
              : Formatter.format(thrown),
        ),
      catch: () => UNRENDERABLE,
    }),
  );

/**
 * Runs one rule, turning a defect into its `Errored` outcome so that one rule
 * that dies cannot cost the run every other rule's outcome and its writes
 * ledger. `run` is suspended, so a throw before it returns its Effect — kit
 * code that works out a rule's targets up front — is caught the same way.
 * Interruption is not caught: it is a request to stop the whole run, not
 * something one rule did, so it still propagates.
 *
 * @internal
 */
export const runRule = (implementation: RuleImpl, ctx: Context): Effect.Effect<Outcome> =>
  Effect.suspend(() => {
    if (implementation.ownsRedirects === true) return implementation.run(ctx);
    const sent: Array<Observation> = [];
    const watched: Context = {
      ...ctx,
      request: (probe) =>
        Effect.tap(ctx.request(probe), (observation) => Effect.sync(() => sent.push(observation))),
    };
    return Effect.map(implementation.run(watched), (outcome) =>
      undecidedByRedirects(outcome, sent),
    );
  }).pipe(
    Effect.catchDefect((defect) =>
      Effect.succeed<Outcome>({
        _tag: "Errored",
        rule: implementation.rule,
        message: renderThrown(defect),
        defect,
      }),
    ),
  );

/** How many reasons a note or skip reason names; the rest are counted. */
const REASON_LIMIT = 3;

/**
 * A rule's outcome once the requests a redirect the kit did not follow
 * answered are taken out of it: such a request has no answer to read, so it
 * decides nothing — not a "was not rejected", and not a pass (owner decision
 * on #333). A finding it produced is dropped; a finding on an answer the kit
 * did read still fails the rule. With none left, the rule is skipped, naming
 * the redirects and keeping its own note: never a partial pass on the answers
 * it did read, whether those are a source, a link or a page. A rule that
 * skipped on its own keeps its reason, the redirects named after it. When
 * every request was redirected off the base URL's origin, `baseUrl` does not
 * serve the api, which `spec/target/reachable` says.
 *
 * @internal
 */
export const undecidedByRedirects = (
  outcome: Outcome,
  sent: ReadonlyArray<Observation>,
): Outcome => {
  const unread = sent.filter(({ unfollowed }) => Option.isSome(unfollowed));
  // A rule's `run` never returns `Errored` itself — `runRule` makes one from a
  // defect, after this — but `Outcome` admits it, and it is kept as it is.
  if (Arr.isReadonlyArrayEmpty(unread) || Predicate.isTagged(outcome, "Errored")) {
    return outcome;
  }
  const every = unread.length === sent.length;
  const redirected = `${every ? "every request the rule sent was" : `${unread.length} of ${sent.length} requests the rule sent were`} answered by a redirect the kit does not follow or read (${redirectsNamed(unread)})`;
  if (Predicate.isTagged(outcome, "Skipped")) {
    return { ...outcome, reason: `${outcome.reason}; ${redirected}` };
  }
  const stands = failedOnRead(outcome, unread);
  if (Option.isSome(stands)) return stands.value;
  const own =
    Predicate.isTagged(outcome, "Passed") && outcome.note !== undefined
      ? `; the rule's own note: ${outcome.note}`
      : "";
  return skip(
    outcome.rule,
    every
      ? `no answer to decide on: ${redirected}${own}`
      : `not decided: ${redirected}, and a rule is not passed on the answers it did read alone${own}`,
  );
};

/** `outcome`, failed on the findings no request in `unread` produced, when there are any. */
const failedOnRead = (
  outcome: Passed | Failed,
  unread: ReadonlyArray<Observation>,
): Option.Option<Failed> => {
  if (Predicate.isTagged(outcome, "Passed")) return Option.none();
  const lost = unread.map(({ probe }) => probe);
  const findings = outcome.findings.filter(
    ({ probe }) => probe === undefined || !lost.includes(probe),
  );
  return Arr.isReadonlyArrayNonEmpty(findings)
    ? Option.some({ ...outcome, findings })
    : Option.none();
};

/** The redirects that answered `unread`, the first {@link REASON_LIMIT} named and the rest counted. */
const redirectsNamed = (unread: ReadonlyArray<Observation>): string => {
  const notes = Arr.dedupe(
    unread.map(
      (observation) =>
        `${observation.probe.method} ${observation.probe.url} answered ${statusOf(observation)}`,
    ),
  );
  return notes.length > REASON_LIMIT
    ? `${notes.slice(0, REASON_LIMIT).join("; ")}; and ${notes.length - REASON_LIMIT} more`
    : notes.join("; ");
};

/**
 * Turns a rule's collected findings into its outcome: no findings is a pass,
 * any finding is a failure. Rules never decide their own verdict, so "ran but
 * found nothing" and "could not run" stay distinguishable in the report.
 *
 * @internal
 */
export const settle = (
  rule: Rule,
  probes: number,
  findings: ReadonlyArray<Finding>,
  note?: string,
): Outcome =>
  findings.length === 0 ? pass(rule, probes, note) : { _tag: "Failed", rule, probes, findings };

/** @internal */
export const finding = (
  rule: Rule,
  args: {
    readonly detail: string;
    readonly expected: string;
    readonly observed: string;
    readonly probe?: Probe | undefined;
  },
): Finding => ({
  rule,
  detail: args.detail,
  expected: args.expected,
  observed: args.observed,
  probe: args.probe,
});

/**
 * A response's status, or why there was none, for a skip reason.
 *
 * @internal
 */
export const statusOf = (observation: Observation): string =>
  observation.transportError === undefined
    ? `${observation.status}`
    : unansweredAs(observation, observation.transportError);

/**
 * A probe with no answer to read, as a finding or a note names it: the
 * redirect the kit did not follow, or the lost response.
 */
const unansweredAs = (observation: Observation, transportError: string): string =>
  Option.match(observation.unfollowed, {
    onNone: () => `no response (${transportError})`,
    onSome: unfollowedNote,
  });

/**
 * `true` when a response came back 2xx.
 *
 * @internal
 */
export const succeeded = (observation: Observation): boolean =>
  observation.status >= 200 && observation.status < 300;

/**
 * The observed status, content type and body excerpt, rendered for a finding's
 * `observed` line — the body is usually what explains the failure.
 *
 * @internal
 */
export const describe = (observation: Observation): string => {
  if (observation.transportError !== undefined)
    return unansweredAs(observation, observation.transportError);
  const type = observation.contentType === undefined ? "" : ` ${observation.contentType}`;
  const excerpt =
    observation.text === ""
      ? ""
      : ` — ${observation.text.length > 220 ? `${observation.text.slice(0, 220)}…` : observation.text}`;
  return `${observation.status}${type}${excerpt}`;
};

/** @internal */
export const isRecord = (u: unknown): u is Readonly<Record<string, unknown>> =>
  typeof u === "object" && u !== null && !Array.isArray(u);

/**
 * Every resource object a document carries, primary and included, paired with
 * the JSON pointer it sits at so a finding can name it.
 *
 * @internal
 */
export const resourcesOf = (
  body: unknown,
): ReadonlyArray<{
  readonly pointer: string;
  readonly resource: Readonly<Record<string, unknown>>;
}> => {
  if (!isRecord(body)) return [];
  const out: Array<{ pointer: string; resource: Readonly<Record<string, unknown>> }> = [];
  const data = body["data"];
  if (isRecord(data)) {
    out.push({ pointer: "/data", resource: data });
  } else if (Array.isArray(data)) {
    data.forEach((item, index) => {
      if (isRecord(item)) out.push({ pointer: `/data/${index}`, resource: item });
    });
  }
  const included = body["included"];
  if (Array.isArray(included)) {
    included.forEach((item, index) => {
      if (isRecord(item)) out.push({ pointer: `/included/${index}`, resource: item });
    });
  }
  return out;
};

/**
 * The comparable string `identity` gives a resource with this `type` and `id`.
 *
 * @internal
 */
export const idKey = (type: string, id: string): string => JSON.stringify(["id", type, id]);

/**
 * A resource object's `(type, id)` identity as a comparable string, or
 * `undefined` when it carries no usable identity.
 *
 * @internal
 */
export const identity = (resource: Readonly<Record<string, unknown>>): string | undefined => {
  const type = resource["type"];
  if (typeof type !== "string") return undefined;
  const id = resource["id"];
  if (typeof id === "string") return idKey(type, id);
  const lid = resource["lid"];
  if (typeof lid === "string") return JSON.stringify(["lid", type, lid]);
  return undefined;
};

/**
 * A resource as `type:id` for a finding's `observed`, naming the member
 * `identity` keys it on: its `id` when that is a string, else its `lid` when
 * that is — so a duplicate keyed on `lid` is not named by an `id` the
 * comparison ignored. With neither a string, there is no key, and the label
 * falls back to whichever of the two is present. A string member reads as
 * itself; anything else through `Formatter.format`, because the server's JSON
 * can put an object there and `String({"toString":1})` throws: naming a
 * malformed resource must not kill the rule that reports it.
 *
 * @internal
 */
export const resourceLabel = (resource: {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly lid?: unknown;
}): string => {
  const { id, lid } = resource;
  const member = Predicate.isString(id) ? id : Predicate.isString(lid) ? lid : (id ?? lid);
  return Arr.map([resource.type, member], (value) =>
    Predicate.isString(value) ? value : Formatter.format(value),
  ).join(":");
};

/**
 * The identities a resource object's `relationships` point at — the edges
 * full-linkage is computed over.
 *
 * @internal
 */
export const linkageOf = (resource: Readonly<Record<string, unknown>>): ReadonlyArray<string> => {
  const relationships = resource["relationships"];
  if (!isRecord(relationships)) return [];
  const out: Array<string> = [];
  const take = (value: unknown): void => {
    if (!isRecord(value)) return;
    const key = identity(value);
    if (key !== undefined) out.push(key);
  };
  for (const name of Object.keys(relationships)) {
    const relationship = relationships[name];
    if (!isRecord(relationship)) continue;
    const data = relationship["data"];
    if (Array.isArray(data)) data.forEach(take);
    else take(data);
  }
  return out;
};

/** Every identity a response's document shows: its resource objects' own, and those their relationships name. */
const shownBy = (observation: Observation): ReadonlyArray<string> =>
  Arr.flatMap(resourcesOf(observation.body), ({ resource }) => [
    ...Option.toArray(Option.fromUndefinedOr(identity(resource))),
    ...linkageOf(resource),
  ]);

/**
 * Wraps a probe runner so that every resource a 2xx `GET` shows is added to
 * `observed` — see `Context.observed`.
 *
 * @internal
 */
export const observing =
  (
    request: Context["request"],
    observed: MutableHashSet.MutableHashSet<string>,
  ): Context["request"] =>
  (probe) =>
    request(probe).pipe(
      Effect.tap((observation) =>
        Effect.sync(() => {
          const read = (probe.method ?? "GET") === "GET";
          if (!read || observation.status < 200 || observation.status >= 300) return;
          Arr.forEach(shownBy(observation), (key) => MutableHashSet.add(observed, key));
        }),
      ),
    );

/** @internal */
export const errorObjectsOf = (body: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> => {
  if (!isRecord(body)) return [];
  const errors = body["errors"];
  if (!Array.isArray(errors)) return [];
  return errors.filter(isRecord);
};

/**
 * The `source.parameter` of every error object a response's document carries
 * that has one — the query parameters the server says caused the errors.
 *
 * @internal
 */
export const sourceParametersOf = (observation: Observation): ReadonlyArray<string> =>
  errorObjectsOf(observation.body)
    .map((error) => error["source"])
    .filter(isRecord)
    .map((source) => source["parameter"])
    .filter(Predicate.isString);

/**
 * Appends query pairs to a path, percent-encoding values but leaving brackets
 * readable in keys — the spelling `Query.serialise` emits, and the one a server
 * actually receives from a browser.
 *
 * @internal
 */
export const withQuery = (
  path: string,
  pairs: ReadonlyArray<readonly [string, string]>,
): string => {
  if (pairs.length === 0) return path;
  const query = pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
  return `${path}${path.includes("?") ? "&" : "?"}${query}`;
};

/** @internal */
export const jsonApiAccept: Readonly<Record<string, string>> = { accept: MEDIA_TYPE };

/** @internal */
export const atomicMediaType = `${MEDIA_TYPE};ext="${ATOMIC_EXTENSION_URI}"`;

/**
 * The endpoints a rule can probe for a given role, in discovery order, already
 * filtered to the ones whose URL resolves.
 *
 * @internal
 */
export const probeable = (
  ctx: Context,
  roles: ReadonlyArray<Role>,
): {
  readonly resolved: ReadonlyArray<{ readonly endpoint: Discovered; readonly path: string }>;
  readonly unresolved: ReadonlyArray<string>;
} => {
  const resolved: Array<{ endpoint: Discovered; path: string }> = [];
  const unresolved: Array<string> = [];
  for (const endpoint of ctx.endpoints) {
    if (!roles.includes(endpoint.role)) continue;
    const resolution = resolvePath(endpoint, ctx.options);
    if (resolution._tag === "Resolved") resolved.push({ endpoint, path: resolution.path });
    else unresolved.push(resolution.reason);
  }
  return { resolved, unresolved };
};

/**
 * The note a rule carries when it probed some endpoints but could not build a
 * URL for others. Without it a partially-covered rule would report a clean pass
 * and say nothing about the endpoints it never reached.
 *
 * @internal
 */
export const coverageNote = (unresolved: ReadonlyArray<string>): string | undefined =>
  unresolved.length === 0
    ? undefined
    : `${unresolved.length} endpoint${unresolved.length === 1 ? "" : "s"} not probed: ${unresolved.join("; ")}`;

/**
 * The standard skip reason when a rule found no endpoint of the shape it needs:
 * says whether none exists at all, or whether one exists but no URL for it
 * could be built.
 *
 * @internal
 */
export const noProbeReason = (what: string, unresolved: ReadonlyArray<string>): string =>
  unresolved.length === 0
    ? `no ${what} in this api`
    : `no ${what} with a resolvable URL: ${unresolved.join("; ")}`;
