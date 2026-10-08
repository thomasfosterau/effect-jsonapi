/**
 * The conformance engine's data model, endpoint discovery and probe plumbing.
 *
 * Everything here is shape and mechanism; the normative rules themselves live
 * in `./spec.ts` (JSON:API v1.1) and `./profile.ts` (this package's profile).
 *
 * @since 0.15.0
 * @internal
 */
import { Effect, SchemaAST } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { HttpApi, HttpApiEndpoint } from "effect/http-api";
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

/** @internal */
export type Outcome = Passed | Failed | Skipped;

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
  /** `true` when the query admits arbitrary `filter[…]` keys — `filter: true`, the grammar. */
  readonly filterGrammar: boolean;
}

const resolveEncoding = SchemaAST.resolveAt<{ readonly contentType?: string | undefined }>(
  "~httpApiEncoding",
);

const wireKeys = (
  schema: { readonly ast: SchemaAST.AST } | undefined,
): { readonly keys: ReadonlyArray<string>; readonly rest: boolean } => {
  if (schema === undefined) return { keys: [], rest: false };
  const encoded = SchemaAST.toEncoded(schema.ast) as {
    readonly propertySignatures?: ReadonlyArray<{ readonly name: PropertyKey }>;
    readonly indexSignatures?: ReadonlyArray<unknown>;
  };
  return {
    keys: (encoded.propertySignatures ?? []).map((ps) => String(ps.name)),
    rest: (encoded.indexSignatures ?? []).length > 0,
  };
};

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
        queryKeys: query.keys,
        filterGrammar: query.rest,
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
   * for every resource the kit created and did not itself delete — after the
   * rule that made it, whether that rule passed, failed or died.
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
  /** The id the server answered with, or `undefined` when the response named none. */
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
  readonly request: (probe: {
    readonly method?: string;
    readonly url: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: unknown;
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
const clientRequest = (
  method: string,
  url: string,
  headers: Readonly<Record<string, string>>,
  body: unknown,
): HttpClientRequest.HttpClientRequest => {
  const request = HttpClientRequest.make(method as "GET")(url, { headers });
  return body === undefined
    ? request
    : HttpClientRequest.bodyText(
        request,
        JSON.stringify(body),
        headers["content-type"] ?? MEDIA_TYPE,
      );
};

/**
 * Builds the probe runner over an `HttpClient`. A transport failure becomes an
 * `Observation` with `status: 0` rather than an error, so one unreachable
 * endpoint is reported as a finding instead of aborting the whole run.
 *
 * @internal
 */
export const runner =
  (client: HttpClient.HttpClient, baseUrl: string): Context["request"] =>
  (probe) =>
    Effect.gen(function* () {
      const method = probe.method ?? "GET";
      const headers = probe.headers ?? jsonApiAccept;
      const url = probe.url.startsWith("http")
        ? probe.url
        : `${baseUrl.replace(/\/$/, "")}${probe.url}`;
      const record: Probe = { method, url: probe.url, headers, body: probe.body };
      const request = clientRequest(method, url, headers, probe.body);
      const result = yield* Effect.result(client.execute(request));
      if (result._tag === "Failure") {
        return {
          probe: record,
          status: 0,
          headers: {},
          contentType: undefined,
          text: "",
          body: undefined,
          transportError: String(result.failure),
        } satisfies Observation;
      }
      const response = result.success;
      const textResult = yield* Effect.result(response.text);
      const text = textResult._tag === "Success" ? textResult.success : "";
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
        probe: record,
        status: response.status,
        headers: headersOut,
        contentType: headersOut["content-type"],
        text,
        body,
        transportError: undefined,
      } satisfies Observation;
    }).pipe(Effect.scoped, Effect.orDie);

// ---------------------------------------------------------------------------
// Rule authoring helpers
// ---------------------------------------------------------------------------

/** @internal */
export interface RuleImpl {
  readonly rule: Rule;
  readonly run: (ctx: Context) => Effect.Effect<Outcome>;
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
 * The observed status, content type and body excerpt, rendered for a finding's
 * `observed` line — the body is usually what explains the failure.
 *
 * @internal
 */
export const describe = (observation: Observation): string => {
  if (observation.transportError !== undefined)
    return `no response (${observation.transportError})`;
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
 * A resource object's `(type, id)` identity as a comparable string, or
 * `undefined` when it carries no usable identity.
 *
 * @internal
 */
export const identity = (resource: Readonly<Record<string, unknown>>): string | undefined => {
  const type = resource["type"];
  if (typeof type !== "string") return undefined;
  const id = resource["id"];
  if (typeof id === "string") return JSON.stringify(["id", type, id]);
  const lid = resource["lid"];
  if (typeof lid === "string") return JSON.stringify(["lid", type, lid]);
  return undefined;
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

/** @internal */
export const errorObjectsOf = (body: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> => {
  if (!isRecord(body)) return [];
  const errors = body["errors"];
  if (!Array.isArray(errors)) return [];
  return errors.filter(isRecord);
};

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
