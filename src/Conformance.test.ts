/**
 * Tests for the conformance kit.
 *
 * The important ones are at the bottom: a deliberately broken server, served by
 * a canned transport, that the kit must catch — and a correct one it must not
 * flag. A kit that reports nothing against a real server is only trustworthy
 * once it has been shown to report the right things against a broken one.
 */
import { assert, describe, expect, it } from "vite-plus/test";
import {
  Array as Arr,
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  HashMap,
  Layer,
  Match,
  MutableHashMap,
  MutableHashSet,
  Option,
  Predicate,
  Record as Rec,
  Result,
  Schema,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { HttpClientRequest } from "effect/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { TestClock } from "effect/testing";
import * as ApiError from "./ApiError.js";
import * as Conformance from "./Conformance.js";
import * as Endpoint from "./Endpoint.js";
import * as Filter from "./Filter.js";
import * as Group from "./Group.js";
import * as Handlers from "./Handlers.js";
import * as Idempotency from "./Idempotency.js";
import * as Middleware from "./Middleware.js";
import * as Query from "./Query.js";
import * as Registry from "./Registry.js";
import * as Relationship from "./Relationship.js";
import * as Resource from "./Resource.js";
import { ATOMIC_EXTENSION_URI, MEDIA_TYPE } from "./internal/media.js";
import { definedMember } from "./internal/members.js";

// ---------------------------------------------------------------------------
// A tiny api, used for endpoint discovery by both the real and canned targets
// ---------------------------------------------------------------------------

const Person = Resource.make("people", {
  attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString },
});

const Article = Resource.make("articles", {
  attributes: { title: Schema.NonEmptyString, body: Schema.String },
  relationships: { author: Relationship.one(() => Person) },
});

const api = HttpApi.make("fixture").add(
  Group.make(
    Article,
    Endpoint.get(Article, { include: true, fields: true }),
    Endpoint.list(Article, { include: true, fields: true }),
  ),
);

const author = Person.make({
  id: Person.Id.make("9"),
  attributes: { firstName: "Dan", lastName: "Gebhardt" },
});

const article = Article.make({
  id: Article.Id.make("1"),
  attributes: { title: "JSON:API paints my bikeshed!", body: "The shortest article. Ever." },
  relationships: { author: { data: Person.ref(author.id) } },
});

// ---------------------------------------------------------------------------
// A canned transport: every probe answered from one function, so a fixture can
// break exactly one rule and nothing else.
// ---------------------------------------------------------------------------

interface Canned {
  readonly status?: number;
  readonly contentType?: string;
  readonly body?: unknown;
  /** Response headers beyond `Content-Type` — a `Location`, say. */
  readonly headers?: Readonly<Record<string, string>>;
}

interface CannedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Headers;
  /** The parsed JSON request body, when there is one. */
  readonly body?: unknown;
}

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** The JSON a request carries, or `undefined` when it carries none. */
const requestJson = (body: HttpClientRequest.HttpClientRequest["body"]) =>
  Match.value(body).pipe(
    Match.tag("Uint8Array", ({ body: bytes }) =>
      Option.getOrUndefined(parseJson(new TextDecoder().decode(bytes))),
    ),
    Match.orElse(() => undefined),
  );

const cannedClient = (serve: (request: CannedRequest) => Canned): HttpClient.HttpClient =>
  HttpClient.make((request, url) =>
    Effect.sync(() => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers.set(name, value);
      }
      const canned = serve({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers,
        body: requestJson(request.body),
      });
      const status = canned.status ?? 200;
      const contentType = canned.contentType ?? MEDIA_TYPE;
      const hasBody = canned.body !== undefined && status !== 204;
      return HttpClientResponse.fromWeb(
        request,
        new Response(hasBody ? JSON.stringify(canned.body) : null, {
          status,
          headers: hasBody
            ? { ...canned.headers, "content-type": contentType }
            : { ...canned.headers },
        }),
      );
    }),
  );

/**
 * A run of `target` against the canned server `serve`, through `client` — the
 * canned client as it is, unless a test wraps it.
 */
const verifyOver =
  <ApiId extends string, Groups extends HttpApiGroup.Constraint>(
    target: HttpApi.HttpApi<ApiId, Groups>,
  ) =>
  (
    serve: (request: CannedRequest) => Canned,
    options?: Conformance.Options,
    client: (canned: HttpClient.HttpClient) => HttpClient.HttpClient = (canned) => canned,
  ) =>
    Effect.runPromise(
      Conformance.verifyWith(target, {
        client: client(cannedClient(serve)),
        baseUrl: "http://fixture.test",
        ids: { articles: "1" },
        ...options,
      }),
    );

/** A run of `target` in process, its handlers and middleware from `live`. */
const runOver =
  <ApiId extends string, Groups extends HttpApiGroup.Constraint, ROut>(
    target: HttpApi.HttpApi<ApiId, Groups>,
    live: Layer.Layer<ROut>,
  ) =>
  (options?: Conformance.Options) =>
    Effect.runPromise(
      // SAFETY: `live` and `Middleware.layer` provide every service the router
      // needs; the platform services `verify` names are never used.
      Conformance.verify(target, { ids: { articles: "1" }, ...options }).pipe(
        Effect.provide(live),
        Effect.scoped,
      ) as Effect.Effect<Conformance.Report, never, never>,
    );

const verifyCanned = verifyOver(api);

const failed = (report: Conformance.Report): ReadonlyArray<string> =>
  report.outcomes
    .filter((outcome) => Predicate.isTagged(outcome, "Failed"))
    .map((outcome) => outcome.rule.id);

const outcomeFor = (report: Conformance.Report, id: string): Conformance.Outcome => {
  const found = report.outcomes.find((outcome) => outcome.rule.id === id);
  if (found === undefined) throw new Error(`no outcome for ${id}`);
  return found;
};

/** The client-generated id rules, each run only for the case its fixture declares. */
const CLIENT_ID_RULES = [
  "spec/status/create-client-id",
  "spec/status/create-conflict-id",
  "spec/status/create-client-id-unsupported",
];

/** The client-generated id rules for an atomic `add` (#471), likewise opt-in. */
const ATOMIC_CLIENT_ID_RULES = [
  "spec/atomic/add-client-id",
  "spec/atomic/add-conflict-id",
  "spec/atomic/add-client-id-unsupported",
];

/** The relationship mutation rules. */
const RELATIONSHIP_RULES = [
  "spec/relationships/update-replaces",
  "spec/relationships/update-to-one-null",
  "spec/relationships/add-appends",
  "spec/relationships/remove-deletes",
  "spec/relationships/write-response",
  "spec/relationships/absent-related-404",
  "spec/relationships/remove-absent-succeeds",
];

/** A 400 error document whose one error object carries `members` too. */
const badRequest = (
  members: { readonly source?: { readonly parameter: string } } = {},
): Canned => ({
  status: 400,
  body: { errors: [{ status: "400", title: "Bad Request", ...members }] },
});

/** The query a canned request carries. */
const queryOf = (request: { readonly path: string }): URLSearchParams =>
  new URLSearchParams(request.path.split("?")[1] ?? "");

/** A canned request's path without its query. */
const withoutQuery = <R extends { readonly path: string }>(request: R): R => ({
  ...request,
  path: request.path.replace(/\?.*$/, ""),
});

/** A note naming a `302` to `https://elsewhere.test` + `path`, which the kit does not follow. */
const offsite = (path: string) =>
  `a 302 redirect to https://elsewhere.test${path}, which the kit does not follow: https://elsewhere.test is another origin than the base URL's, http://fixture.test — the kit follows a redirect only within the base URL's origin, and a change of scheme or port is a change of origin`;

/**
 * A transport that follows each redirect itself (`HttpClient.followRedirects`)
 * in front of `canned`: each request `moved` picks is answered with a `302` to
 * the same path on `https://elsewhere.test`, which the transport then requests,
 * and whose answer — a 200 with an empty document — is all the kit is handed;
 * or, when `ends` is `"refused"`, which fails there as a refused connection or
 * a DNS failure does over real sockets.
 */
const followingOffsite =
  (
    moved: (request: HttpClientRequest.HttpClientRequest, url: URL) => boolean,
    ends: "answered" | "refused" = "answered",
  ) =>
  (canned: HttpClient.HttpClient) =>
    HttpClient.followRedirects(
      HttpClient.make((request, url) => {
        if (url.origin === "https://elsewhere.test") {
          return ends === "refused"
            ? Effect.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({ request }),
                }),
              )
            : Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response('{"meta":{}}', {
                    headers: { "content-type": MEDIA_TYPE },
                  }),
                ),
              );
        }
        return moved(request, url)
          ? Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(null, {
                  status: 302,
                  headers: { location: `https://elsewhere.test${url.pathname}${url.search}` },
                }),
              ),
            )
          : canned.execute(request);
      }),
    );

/** A redirect the transport followed to `https://elsewhere.test` + `path`, as a note names it. */
const followed = (path: string) =>
  `a redirect the transport followed itself, ending at https://elsewhere.test${path} with a 200, whose answer the kit does not read: https://elsewhere.test is another origin than the one the request was sent to, http://fixture.test, and the transport has already tried the request there`;

/** A redirect the transport followed to `https://elsewhere.test` + `path` and failed at, as a note names it. */
const refused = (path: string) =>
  `a redirect the transport followed itself, ending in a transport error at https://elsewhere.test${path}: https://elsewhere.test is another origin than the one the request was sent to, http://fixture.test, and the transport has already tried the request there`;

/** The families of query parameter JSON:API defines. */
const FAMILIES = ["include", "sort", "page", "filter", "fields"];

/**
 * The names of the specification's families `conformantServe` processes: the
 * bare `include` and `sort` (it refuses every `sort`), and a sparse fieldset
 * for each type it serves. It does not paginate or filter, so any other name
 * of a family is one it does not know how to process (#310).
 */
const PROCESSED = ["include", "sort", "fields[articles]", "fields[people]"];

/**
 * Whether `conformantServe` refuses a query parameter with a 400: a name of a
 * family the specification defines that it does not process, or — §Query
 * Parameters: an implementation-specific name must carry a non a-z character
 * — a purely a-z name it does not know; or a name that does not follow the
 * naming conventions or is an extension's (it supports none): a base name
 * that is not a legal member name (#425).
 */
const refusesParameter = (key: string): boolean => {
  const base = key.split("[")[0] ?? key;
  return FAMILIES.includes(base)
    ? !PROCESSED.includes(key)
    : /^[a-z]+$/.test(key) || !/^[A-Za-z0-9](?:[\w -]*[A-Za-z0-9])?$/.test(base);
};

/**
 * §Fetching Includes: a request that supplies `include`, even empty, gets an
 * `included` key, `[]` when nothing is included; one without it gets none.
 */
const includedMember = <A>(
  params: URLSearchParams,
  resources: ReadonlyArray<A>,
): { readonly included?: ReadonlyArray<A> } =>
  params.has("include") ? { included: resources } : {};

/**
 * The article's `relationships` under the request's `fields[articles]`: a
 * relationship is a field (#494), so `author` is kept only when no fieldset
 * leaves it out.
 */
const articleRelationships = (params: URLSearchParams) => {
  const requested = params.get("fields[articles]");
  if (requested !== null && !requested.split(",").includes("author")) return {};
  return { relationships: { author: { data: { type: "people", id: "9" } } } };
};

/**
 * A correct-enough server: negotiates per §5, answers well-formed documents,
 * projects sparse fieldsets, rejects unknown query parameters and absent ids.
 * The baseline every broken fixture below is one deviation from.
 */
const conformantServe = (request: {
  readonly method: string;
  readonly path: string;
  readonly headers: Headers;
}): Canned => {
  const accept = request.headers.get("accept") ?? "";
  const contentType = request.headers.get("content-type") ?? "";

  // §5: a JSON:API instance is acceptable when its only media type parameters
  // are ext / profile. `q` terminates the media type's parameters (RFC 9110).
  const mediaTypeParameters = (entry: string): ReadonlyArray<string> => {
    const parts = entry
      .split(";")
      .slice(1)
      .map((part) => part.trim().toLowerCase());
    const out: Array<string> = [];
    for (const part of parts) {
      const name = part.split("=")[0]!.trim();
      if (name === "q") break;
      out.push(name);
    }
    return out;
  };
  const weightOf = (entry: string): number => {
    const match = /;\s*q=([0-9.]+)/.exec(entry);
    return match === null ? 1 : Number(match[1]);
  };

  if (contentType !== "" && contentType.split(";")[0]!.trim() === MEDIA_TYPE) {
    if (mediaTypeParameters(contentType).some((name) => name !== "ext" && name !== "profile")) {
      return {
        status: 415,
        body: { errors: [{ status: "415", title: "Unsupported Media Type" }] },
      };
    }
  }
  if (accept !== "") {
    const entries = accept.split(",").map((entry) => entry.trim());
    const jsonApi = entries.filter((entry) => entry.split(";")[0]!.trim() === MEDIA_TYPE);
    const wildcard = entries.some((entry) => {
      const base = entry.split(";")[0]!.trim();
      return base === "*/*" || base === "application/*";
    });
    if (Arr.isReadonlyArrayNonEmpty(jsonApi) || !wildcard) {
      const usable = jsonApi.filter((entry) => {
        if (weightOf(entry) === 0) return false;
        if (!mediaTypeParameters(entry).every((name) => name === "ext" || name === "profile"))
          return false;
        // §Extensions: this fixture supports no extension, so any `ext` is unsupported.
        return !/;\s*ext=/.test(entry);
      });
      if (Arr.isReadonlyArrayEmpty(usable)) {
        return { status: 406, body: { errors: [{ status: "406", title: "Not Acceptable" }] } };
      }
    }
  }

  const [pathname, search = ""] = request.path.split("?");
  const raw = new URLSearchParams(search);
  // The comma grammar and the repeated-key spelling denote the same set, so the
  // baseline unions repeated keys before reading any of them.
  const params = new URLSearchParams();
  for (const key of new Set(raw.keys())) params.set(key, raw.getAll(key).join(","));
  const refused = Arr.findFirst([...params.keys()], refusesParameter);
  if (Option.isSome(refused)) return badRequest({ source: { parameter: refused.value } });

  const include =
    params
      .get("include")
      ?.split(",")
      .filter((path) => path !== "") ?? [];
  if (include.some((path) => path !== "author")) {
    return {
      status: 400,
      body: { errors: [{ status: "400", title: "Bad Request", source: { parameter: "include" } }] },
    };
  }
  const sort = params.get("sort");
  if (sort !== null && sort !== "") {
    return {
      status: 400,
      body: { errors: [{ status: "400", title: "Bad Request", source: { parameter: "sort" } }] },
    };
  }

  const project = (type: string, attributes: Readonly<Record<string, unknown>>) => {
    const requested = params.get(`fields[${type}]`);
    if (requested === null) return attributes;
    const keep = new Set(requested.split(","));
    return Object.fromEntries(Object.entries(attributes).filter(([key]) => keep.has(key)));
  };

  const articleObject = {
    type: "articles",
    id: "1",
    attributes: project("articles", {
      title: article.attributes.title,
      body: article.attributes.body,
    }),
    ...articleRelationships(params),
  };
  const personObject = {
    type: "people",
    id: "9",
    attributes: project("people", {
      firstName: author.attributes.firstName,
      lastName: author.attributes.lastName,
    }),
  };
  const included = includedMember(
    params,
    Arr.filter([personObject], () => include.includes("author")),
  );

  if (pathname === "/articles")
    return { body: { jsonapi: { version: "1.1" }, data: [articleObject], ...included } };
  if (pathname === "/articles/1")
    return { body: { jsonapi: { version: "1.1" }, data: articleObject, ...included } };
  return { status: 404, body: { errors: [{ status: "404", title: "Not Found" }] } };
};

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

describe("Conformance: the catalogue", () => {
  it("every rule has a unique id, a citation and a normative sentence", () => {
    const ids = Conformance.rules.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of Conformance.rules) {
      expect(rule.requirement.length).toBeGreaterThan(20);
      expect(rule.reference).toMatch(/^https:\/\//);
      expect(rule.section).not.toBe("");
      expect(rule.id.startsWith(`${rule.tier}/`)).toBe(true);
    }
  });

  it("separates spec rules from profile rules", () => {
    const spec = Conformance.rules.filter((rule) => rule.tier === "spec");
    const profile = Conformance.rules.filter((rule) => rule.tier === "profile");
    expect(spec.length).toBeGreaterThan(0);
    expect(profile.length).toBeGreaterThan(0);
    // The profile tier never cites the specification as its authority.
    for (const rule of profile) expect(rule.reference).not.toContain("jsonapi.org/format");
  });

  it("declares its coverage gaps, each explained and some tracked", () => {
    expect(Conformance.gaps.length).toBeGreaterThan(0);
    for (const gap of Conformance.gaps) {
      expect(gap.area).not.toBe("");
      expect(gap.reason.length).toBeGreaterThan(40);
    }
    // The filter semantics gap is the one coupled to the profile's completion.
    expect(Conformance.gaps.some((gap) => gap.tracking.includes("#116"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

describe("Conformance: the report", () => {
  const rule = Conformance.rules[0]!;

  it("prints passes, failures, skips and the coverage gaps", () => {
    const text = Conformance.format({
      target: "fixture",
      version: "1.1",
      transport: "in-process",
      outcomes: [
        { _tag: "Passed", rule, probes: 2, note: undefined },
        {
          _tag: "Failed",
          rule: Conformance.rules[1]!,
          probes: 1,
          findings: [
            {
              rule: Conformance.rules[1]!,
              detail: "the thing went wrong",
              expected: "a 415",
              observed: "a 200",
              probe: {
                method: "GET",
                url: "/articles",
                headers: { accept: MEDIA_TYPE },
                body: undefined,
              },
            },
          ],
        },
        { _tag: "Skipped", rule: Conformance.rules[2]!, reason: "no write endpoint in this api" },
      ],
      gaps: Conformance.gaps,
    });

    expect(text).toContain("PASS");
    expect(text).toContain("FAIL");
    expect(text).toContain("the thing went wrong");
    expect(text).toContain("expected: a 415");
    expect(text).toContain("observed: a 200");
    expect(text).toContain("GET /articles");
    expect(text).toContain("not checked: no write endpoint in this api");
    expect(text).toContain("NOT COVERED BY THIS KIT");
    expect(text).toContain("SUMMARY");
    // The citation is what makes it a report rather than a diff.
    expect(text).toContain(Conformance.rules[1]!.reference);
  });

  it("marks only the first line of a finding that spans lines as a finding", () => {
    // A detail can quote what the server sent — a member name, say — and that
    // can hold a newline: its next line hangs under it, not as a second `·`.
    const text = Conformance.format({
      target: "fixture",
      version: "1.1",
      transport: "in-process",
      outcomes: [
        {
          _tag: "Failed",
          rule,
          probes: 1,
          findings: [
            {
              rule,
              detail: "the member `a\nb` is not allowed",
              expected: "x",
              observed: "y",
              probe: undefined,
            },
          ],
        },
      ],
      gaps: [],
    });
    expect(text).toContain(
      "        · the member `a\n          b` is not allowed\n          expected: x\n",
    );
  });

  it("hangs an expected or observed value that spans lines under its label", () => {
    // `observed` quotes the server — a `type` of `"a\nb"`, say: its next line
    // must not start at the label column, where it would read as a field.
    const text = Conformance.format({
      target: "fixture",
      version: "1.1",
      transport: "in-process",
      outcomes: [
        {
          _tag: "Failed",
          rule,
          probes: 1,
          findings: [
            {
              rule,
              detail: "d",
              expected: "x\ny",
              observed: "a\nb:1",
              probe: undefined,
            },
          ],
        },
      ],
      gaps: [],
    });
    expect(text).toContain(
      "          expected: x\n            y\n          observed: a\n            b:1",
    );
  });

  it("lists the writes still in place before those that are gone", () => {
    const text = Conformance.format({
      target: "fixture",
      version: "1.1",
      transport: "http",
      outcomes: [],
      gaps: [],
      writes: [
        { type: "articles", id: "1", rule: "r/a", disposal: "deleted", detail: undefined },
        { type: "articles", id: "2", rule: "r/b", disposal: "left", detail: "no cleanup" },
        { type: "articles", id: undefined, rule: "r/c", disposal: "left", detail: "named x" },
      ],
    });
    expect(text).toContain("3 resources created · 2 still in place");
    expect(text.indexOf("articles:2")).toBeLessThan(text.indexOf("articles:1"));
    expect(text.indexOf("articles:(id unknown)")).toBeLessThan(text.indexOf("articles:1"));
    expect(text.indexOf("articles:2")).toBeLessThan(text.indexOf("articles:(id unknown)"));
  });

  it("counts skips separately from passes, so a vacuous run cannot read as a clean one", () => {
    const summary = Conformance.summarise({
      target: "t",
      version: "1.1",
      transport: "in-process",
      outcomes: [
        { _tag: "Passed", rule, probes: 3, note: undefined },
        { _tag: "Skipped", rule: Conformance.rules[1]!, reason: "nope" },
      ],
      gaps: [],
    });
    expect(summary).toMatchObject({ passed: 1, failed: 0, skipped: 1, probes: 3 });
  });

  it("assert succeeds on a clean report and fails naming the rule otherwise", async () => {
    const clean: Conformance.Report = {
      target: "t",
      version: "1.1",
      transport: "in-process",
      outcomes: [{ _tag: "Skipped", rule, reason: "nope" }],
      gaps: [],
    };
    expect((await Effect.runPromise(Conformance.assert(clean))).target).toBe("t");

    const broken: Conformance.Report = {
      ...clean,
      outcomes: [
        {
          _tag: "Failed",
          rule,
          probes: 1,
          findings: [
            { rule, detail: "first", expected: "e", observed: "o", probe: undefined },
            { rule, detail: "second", expected: "e", observed: "o", probe: undefined },
          ],
        },
      ],
    };
    const exit = await Effect.runPromiseExit(Conformance.assert(broken));
    expect(exit._tag).toBe("Failure");
    const violation = await Effect.runPromise(Conformance.assert(broken).pipe(Effect.flip));
    expect(violation._tag).toBe("ContractViolation");
    expect(violation.rule.id).toBe(rule.id);
    expect(violation.remaining).toBe(1);
    expect(violation.message).toContain(rule.requirement);
    expect(violation.message).toContain(rule.reference);
  });

  it("prints and counts a rule that died apart from failures, and assert dies on it", async () => {
    const defect = { reason: "fell over" };
    const report: Conformance.Report = {
      target: "t",
      version: "1.1",
      transport: "in-process",
      outcomes: [
        { _tag: "Passed", rule, probes: 2, note: undefined },
        { _tag: "Errored", rule, message: "the transport fell over", defect },
      ],
      gaps: [],
    };
    expect(Conformance.summarise(report)).toMatchObject({ passed: 1, failed: 0, errored: 1 });
    const text = Conformance.format(report);
    expect(text).toContain(`DIED  ${rule.id}`);
    expect(text).toContain("not decided — the rule died: the transport fell over");
    expect(text).toContain("1 died");
    // A rule that died is listed before one that passed.
    expect(text.indexOf("DIED")).toBeLessThan(text.indexOf("PASS"));
    // Nothing died, nothing said.
    expect(Conformance.format({ ...report, outcomes: report.outcomes.slice(0, 1) })).not.toContain(
      "died",
    );

    // The gate does not pass a run that could not decide a rule: it dies,
    // naming the rule, even when another rule also failed.
    const diesNaming = async (gated: Conformance.Report) => {
      const exit = await Effect.runPromiseExit(Conformance.assert(gated));
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
      expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(
        `${rule.id} died: the transport fell over`,
      );
      // A tagged defect carrying the rule's id and, as its `cause`, the very
      // value the rule died with.
      const died = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
      expect(died).toMatchObject({ _tag: "RuleDied", rule: rule.id });
      expect(Predicate.hasProperty(died, "cause") && died.cause).toBe(defect);
    };
    await diesNaming(report);
    await diesNaming({
      ...report,
      outcomes: [
        ...report.outcomes,
        {
          _tag: "Failed",
          rule,
          probes: 1,
          findings: [{ rule, detail: "d", expected: "e", observed: "o", probe: undefined }],
        },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// Discovery and selection
// ---------------------------------------------------------------------------

describe("Conformance: discovery and selection", () => {
  it("runs only the selected tier", async () => {
    const report = await verifyCanned(conformantServe, { tiers: ["spec"] });
    expect(report.outcomes.every((outcome) => outcome.rule.tier === "spec")).toBe(true);
  });

  it("runs only the selected rule ids, matching on prefix", async () => {
    const report = await verifyCanned(conformantServe, { only: ["spec/content-negotiation"] });
    expect(report.outcomes.length).toBeGreaterThan(3);
    expect(
      report.outcomes.every((outcome) => outcome.rule.id.startsWith("spec/content-negotiation")),
    ).toBe(true);
  });

  it("skips — never passes — a rule whose URL it cannot build, naming the missing option", async () => {
    const report = await verifyCanned(conformantServe, {
      ids: {},
      only: ["spec/status/resource-not-found"],
    });
    const outcome = outcomeFor(report, "spec/status/resource-not-found");
    // The absent-id probe needs no sample id, so this one still runs; the
    // document rules are the ones that go unresolved.
    expect(outcome._tag).not.toBe("Failed");

    // `/articles` still resolves, so the rule runs — but the report must say
    // which endpoints it never reached rather than reading as full coverage.
    const documents = await verifyCanned(conformantServe, {
      ids: {},
      only: ["spec/document/top-level-members"],
    });
    const partial = outcomeFor(documents, "spec/document/top-level-members");
    assert(Predicate.isTagged(partial, "Passed"));
    expect(partial.note).toContain("not probed");
    expect(partial.note).toContain(`ids["articles"]`);

    // With no resolvable endpoint at all, the rule skips outright and names the
    // option that would have let it run.
    const parameterisedOnly = HttpApi.make("parameterised").add(
      Group.make(Article, Endpoint.get(Article)),
    );
    const none = await Effect.runPromise(
      Conformance.verifyWith(parameterisedOnly, {
        client: cannedClient(conformantServe),
        baseUrl: "http://fixture.test",
        only: ["spec/document/top-level-members"],
      }),
    );
    const skipped = outcomeFor(none, "spec/document/top-level-members");
    assert(Predicate.isTagged(skipped, "Skipped"));
    expect(skipped.reason).toContain(`ids["articles"]`);
  });

  const ids = (report: Conformance.Report) => report.outcomes.map((outcome) => outcome.rule.id);

  // Matching by path segment (#367): the id itself, or ids continuing it with `/`.
  const underPrefix = (prefix: string) => (id: string) =>
    id === prefix || id.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);

  it("leaves out the skipped rule ids, matching on prefix as `only` does", async () => {
    const all = ids(await verifyCanned(conformantServe));
    const skip = [
      "spec/pagination/links-enumerate-collection",
      "spec/links/",
      "spec/content-negotiation",
    ];
    const report = await verifyCanned(conformantServe, { skip });
    const left = all.filter((id) => !skip.some((prefix) => underPrefix(prefix)(id)));
    // Each prefix leaves something out, and nothing else is.
    expect(skip.every((prefix) => all.some(underPrefix(prefix)))).toBe(true);
    expect(left.length).toBeLessThan(all.length - 5);
    expect(ids(report)).toEqual(left);
    // A skipped rule is absent from the report, as one `only` did not select
    // is — never a `Skipped` outcome that would read as a rule the run tried.
    expect(Conformance.summarise(report).skipped).toBe(
      Conformance.summarise(await verifyCanned(conformantServe, { only: left })).skipped,
    );
  });

  it("leaves out the skipped rules from what `only` and `tiers` select", async () => {
    const selected = ids(
      await verifyCanned(conformantServe, { only: ["spec/content-negotiation"] }),
    );
    const weight = [
      "spec/content-negotiation/accept-weight-is-not-a-parameter",
      "spec/content-negotiation/accept-weight-zero-refuses",
    ];
    const report = await verifyCanned(conformantServe, {
      only: ["spec/content-negotiation"],
      skip: weight,
    });
    expect(selected.filter((id) => weight.includes(id))).toEqual(weight);
    expect(ids(report)).toEqual(selected.filter((id) => !weight.includes(id)));
    // A rule both name is left out; `skip` naming everything leaves nothing.
    const both = await verifyCanned(conformantServe, {
      only: ["spec/document/top-level-members"],
      skip: ["spec/document/top-level-members"],
    });
    expect(both.outcomes).toEqual([]);
    const profile = await verifyCanned(conformantServe, { tiers: ["profile"], skip: ["spec/"] });
    expect(profile.outcomes.length).toBeGreaterThan(0);
    const spec = await verifyCanned(conformantServe, { tiers: ["spec"], skip: ["spec/"] });
    expect(spec.outcomes).toEqual([]);
  });

  it("matches `only` and `skip` prefixes by path segment, never past one", async () => {
    const all = ids(await verifyCanned(conformantServe));
    const location = "spec/status/create-location";
    const matchesSelf = "spec/status/create-location-matches-self";
    expect(all).toContain(location);
    expect(all).toContain(matchesSelf);

    // A complete rule id names that rule alone, though another id continues it.
    expect(ids(await verifyCanned(conformantServe, { only: [location] }))).toEqual([location]);
    const skipped = ids(await verifyCanned(conformantServe, { skip: [location] }));
    expect(skipped).not.toContain(location);
    expect(skipped).toContain(matchesSelf);
    expect(skipped).toEqual(all.filter((id) => id !== location));

    // A section matches with or without its trailing `/`; a partial segment
    // matches nothing.
    const section = all.filter((id) => id.startsWith("spec/content-negotiation/"));
    expect(section.length).toBeGreaterThan(3);
    const rest = all.filter((id) => !section.includes(id));
    const prefixes = ["spec/content-negotiation", "spec/content-negotiation/"];
    const selections = await Promise.all(
      prefixes.map(async (prefix) => [
        ids(await verifyCanned(conformantServe, { only: [prefix] })),
        ids(await verifyCanned(conformantServe, { skip: [prefix] })),
      ]),
    );
    expect(selections).toEqual([
      [section, rest],
      [section, rest],
    ]);
    expect((await verifyCanned(conformantServe, { only: ["spec/content-neg"] })).outcomes).toEqual(
      [],
    );
    expect(ids(await verifyCanned(conformantServe, { skip: ["spec/content-neg"] }))).toEqual(all);
  });

  it("records the transport it drove", async () => {
    const report = await verifyCanned(conformantServe);
    expect(report.transport).toBe("http");
    expect(report.target).toBe("fixture");
  });
});

describe("Conformance: requestTimeout", () => {
  /** A client that never answers, counting the requests the timeout cut short. */
  const silent = () => {
    let interrupted = 0;
    const client = HttpClient.make(() =>
      Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted += 1;
          }),
        ),
      ),
    );
    return { client: () => client, interrupted: () => interrupted };
  };

  const rules = ["spec/target/reachable", "spec/content-negotiation/response-media-type"];

  it("reads a server that never answers as a lost response, rather than hanging", async () => {
    const server = silent();
    const report = await verifyCanned(
      conformantServe,
      { requestTimeout: 10, only: rules },
      server.client,
    );
    const note = "no answer within 10ms, the run's `requestTimeout`";
    expect(outcomeFor(report, "spec/target/reachable")).toMatchObject({
      _tag: "Failed",
      findings: [
        { detail: "/articles/1 produced no HTTP response", observed: `no response (${note})` },
        { detail: "/articles produced no HTTP response", observed: `no response (${note})` },
      ],
    });
    // Every request was cut short, not left running.
    expect(server.interrupted()).toBe(Conformance.summarise(report).probes);
    // Exactly what a transport that fails at once reports, but for the note: a
    // timeout is a transport error, never a redirect the kit did not follow.
    const lost = await verifyCanned(conformantServe, { only: rules }, () =>
      HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, description: "reset" }),
          }),
        ),
      ),
    );
    const why = (outcomes: ReadonlyArray<Conformance.Outcome>) =>
      Arr.map(outcomes, (outcome) =>
        Predicate.isTagged(outcome, "Failed")
          ? {
              ...outcome,
              findings: Arr.map(outcome.findings, (found) => ({
                ...found,
                observed: found.observed.replace(/^no response \(.*\)$/, "no response (…)"),
              })),
            }
          : outcome,
      );
    expect(why(report.outcomes)).toEqual(why(lost.outcomes));
  });

  /**
   * A run of `reachable` against a server that never answers, under the test
   * clock, advanced by each of `steps` in turn; `settled` says, after each
   * step, whether the run had finished. A run still going after the last step
   * is interrupted.
   */
  const clocked = (options: Conformance.Options, steps: ReadonlyArray<Duration.Input>) => {
    const server = silent();
    return Effect.runPromiseExit(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Conformance.verifyWith(api, {
            client: server.client(),
            baseUrl: "http://fixture.test",
            ids: { articles: "1" },
            only: ["spec/target/reachable"],
            ...options,
          }),
        );
        const settled = yield* Effect.forEach(
          steps,
          (step) => Effect.map(TestClock.adjust(step), () => fiber.pollUnsafe() !== undefined),
          { concurrency: 1 },
        );
        const report =
          settled.at(-1) === true ? Option.some(yield* Fiber.join(fiber)) : Option.none();
        yield* Fiber.interrupt(fiber);
        return { settled, report, interrupted: server.interrupted() };
      }).pipe(Effect.provide(TestClock.layer())),
    );
  };

  it("waits thirty seconds for each request by default", async () => {
    const exit = await clocked({}, ["29999 millis", "1 millis", "30 seconds"]);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isFailure(exit)) return;
    const run = exit.value;
    // The first request is cut short at thirty seconds, the second thirty after.
    expect(run.settled).toEqual([false, false, true]);
    expect(run.interrupted).toBe(2);
    const note = "no answer within 30s, the run's `requestTimeout`";
    expect(Option.map(run.report, (report) => outcomeFor(report, "spec/target/reachable"))).toEqual(
      Option.some(
        expect.objectContaining({
          _tag: "Failed",
          findings: [
            expect.objectContaining({ observed: `no response (${note})` }),
            expect.objectContaining({ observed: `no response (${note})` }),
          ],
        }),
      ),
    );
  });

  it("waits thirty seconds for each request in process too", async () => {
    // Handlers that never answer, through the real router: the default is
    // the same for `verify` as for `verifyWith`.
    let interrupted = 0;
    const hang = Effect.never.pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          interrupted += 1;
        }),
      ),
    );
    const Live = HttpApiBuilder.group(api, "articles", (handlers) =>
      handlers.handle("get", () => hang).handle("list", () => hang),
    ).pipe(Layer.provideMerge(Middleware.layer));
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Conformance.verify(api, { ids: { articles: "1" }, only: ["spec/target/reachable"] }),
        );
        // After each step: whether the run had finished, and how many
        // requests had been cut short.
        const steps = yield* Effect.forEach(
          ["29999 millis", "1 millis", "30 seconds"] as const,
          (step) =>
            Effect.map(TestClock.adjust(step), () => ({
              settled: fiber.pollUnsafe() !== undefined,
              interrupted,
            })),
          { concurrency: 1 },
        );
        const report =
          steps.at(-1)?.settled === true ? Option.some(yield* Fiber.join(fiber)) : Option.none();
        yield* Fiber.interrupt(fiber);
        return { steps, report };
      }).pipe(
        Effect.provide(Layer.mergeAll(Live, Registry.platformLayer, TestClock.layer())),
        Effect.scoped,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isFailure(exit)) return;
    // Still waiting a millisecond before thirty seconds; the first request is
    // cut short at thirty, the second thirty after.
    expect(exit.value.steps).toEqual([
      { settled: false, interrupted: 0 },
      { settled: false, interrupted: 1 },
      { settled: true, interrupted: 2 },
    ]);
    const note = "no answer within 30s, the run's `requestTimeout`";
    expect(
      Option.map(exit.value.report, (report) => outcomeFor(report, "spec/target/reachable")),
    ).toEqual(
      Option.some(
        expect.objectContaining({
          _tag: "Failed",
          findings: [
            expect.objectContaining({ observed: `no response (${note})` }),
            expect.objectContaining({ observed: `no response (${note})` }),
          ],
        }),
      ),
    );
  });

  it.each(["Infinity", Duration.infinity] as const)(
    "waits as long as the transport does when the run turns it off with %s",
    async (requestTimeout) => {
      const exit = await clocked({ requestTimeout }, ["30 seconds", "1 hour"]);
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isFailure(exit)) return;
      const run = exit.value;
      expect(run.settled).toEqual([false, false]);
      // Only the first request was sent; it was still waiting.
      expect(run.interrupted).toBe(1);
    },
  );

  it.each([0, -1, Number.NaN, "-Infinity", "1e3 seconds"] as const)(
    "dies on a `requestTimeout` of %s before it sends a request",
    async (requestTimeout) => {
      let sent = 0;
      // The client answers every request at once, so a run that sent one
      // before reading its options still finishes, and fails on `sent`
      // rather than hanging.
      const exit = await Effect.runPromiseExit(
        Conformance.verifyWith(api, {
          client: HttpClient.make((request) =>
            Effect.suspend(() => {
              sent += 1;
              return Effect.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({ request, description: "reset" }),
                }),
              );
            }),
          ),
          baseUrl: "http://fixture.test",
          ids: { articles: "1" },
          only: ["spec/target/reachable"],
          requestTimeout,
        }),
      );
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
      expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toContain(
        "`requestTimeout` must be a positive duration",
      );
      expect(sent).toBe(0);
    },
  );

  it("changes nothing for a server that answers within it", async () => {
    const report = await verifyCanned(conformantServe, { requestTimeout: "1 minute" });
    expect(failed(report)).toEqual([]);
    expect(report.outcomes).toEqual((await verifyCanned(conformantServe)).outcomes);
  });
});

// ---------------------------------------------------------------------------
// The control: a conformant server
// ---------------------------------------------------------------------------

describe("Conformance: against a conformant server", () => {
  it("reports no failures", async () => {
    const report = await verifyCanned(conformantServe);
    expect(failed(report)).toEqual([]);
  });

  it("still reports what it could not check, rather than implying completeness", async () => {
    const report = await verifyCanned(conformantServe);
    const summary = Conformance.summarise(report);
    expect(summary.passed).toBeGreaterThan(10);
    expect(summary.skipped).toBeGreaterThan(0);
    expect(report.gaps.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Detection: one deliberate defect at a time
// ---------------------------------------------------------------------------

/**
 * Each case takes the conformant server and breaks exactly one thing, then
 * asserts the kit reports that rule — and, just as importantly, that the rest of
 * the suite stays green, so a defect cannot be "caught" by a kit that simply
 * fails everything.
 */
const broken = (
  name: string,
  id: string,
  mutate: (
    canned: Canned,
    request: { readonly method: string; readonly path: string; readonly headers: Headers },
  ) => Canned,
) =>
  it(name, async () => {
    const report = await verifyCanned((request) => mutate(conformantServe(request), request));
    expect(failed(report)).toContain(id);
    const outcome = outcomeFor(report, id);
    assert(Predicate.isTagged(outcome, "Failed"));
    expect(outcome.findings.length).toBeGreaterThan(0);
    // A finding always says what it wanted and what it got.
    for (const found of outcome.findings) {
      expect(found.expected).not.toBe("");
      expect(found.observed).not.toBe("");
    }
  });

const withData = (
  canned: Canned,
  change: (body: Record<string, unknown>) => Record<string, unknown>,
): Canned => {
  const body = canned.body;
  if (typeof body !== "object" || body === null || !("data" in body)) return canned;
  return { ...canned, body: change(body as Record<string, unknown>) };
};

describe("Conformance: detects a deliberately broken server", () => {
  broken(
    "a non-JSON:API response media type",
    "spec/content-negotiation/response-media-type",
    (canned) =>
      (canned.status ?? 200) === 200 ? { ...canned, contentType: "application/json" } : canned,
  );

  broken(
    "a response media type carrying a disallowed parameter",
    "spec/content-negotiation/response-media-type",
    (canned) =>
      (canned.status ?? 200) === 200
        ? { ...canned, contentType: `${MEDIA_TYPE};charset=utf-8` }
        : canned,
  );

  broken(
    "a parameterised Accept that is answered instead of refused",
    "spec/content-negotiation/accept-parameters",
    (canned, request) =>
      request.headers.get("accept")?.includes("charset") === true
        ? conformantServe({ ...request, headers: new Headers() })
        : canned,
  );

  broken(
    "a q-weight treated as a media type parameter",
    "spec/content-negotiation/accept-weight-is-not-a-parameter",
    (canned, request) =>
      request.headers.get("accept")?.includes("q=") === true
        ? { status: 406, body: { errors: [{ status: "406", title: "Not Acceptable" }] } }
        : canned,
  );

  broken(
    "an unrecognised profile that is rejected instead of ignored",
    "spec/content-negotiation/unknown-profile-ignored",
    (canned, request) =>
      request.headers.get("accept")?.includes("unrecognised-profile") === true
        ? { status: 406, body: { errors: [{ status: "406", title: "Not Acceptable" }] } }
        : canned,
  );

  broken(
    "a document with neither data, errors nor meta",
    "spec/document/top-level-members",
    (canned) =>
      (canned.status ?? 200) === 200
        ? { ...canned, body: { links: { self: "/articles" } } }
        : canned,
  );

  broken(
    "a document carrying both data and errors",
    "spec/document/data-and-errors-exclusive",
    (canned) => withData(canned, (body) => ({ ...body, errors: [{ status: "200", title: "?" }] })),
  );

  broken("included without a top-level data", "spec/document/included-requires-data", (canned) =>
    (canned.status ?? 200) === 200
      ? {
          ...canned,
          body: { meta: { total: 0 }, included: [{ type: "people", id: "9", attributes: {} }] },
        }
      : canned,
  );

  broken(
    "an included resource nothing in the document links to",
    "spec/document/full-linkage",
    (canned) =>
      withData(canned, (body) => ({
        ...body,
        included: [
          ...(Array.isArray(body["included"]) ? body["included"] : []),
          { type: "people", id: "404", attributes: { firstName: "Nobody", lastName: "Here" } },
        ],
      })),
  );

  broken(
    "the same (type, id) twice in one document",
    "spec/document/no-duplicate-resources",
    (canned) =>
      withData(canned, (body) => {
        const included = Array.isArray(body["included"]) ? body["included"] : [];
        return Arr.match(included, {
          onEmpty: () => body,
          onNonEmpty: (present) => ({ ...body, included: [...present, present[0]] }),
        });
      }),
  );

  broken(
    "a response to `?include=` with no `included` key",
    "spec/document/included-on-include",
    (canned, request) =>
      queryOf(request).has("include")
        ? withData(canned, (body) => Rec.remove(body, "included"))
        : canned,
  );

  it("asks a bare `?include=` for an empty `included` array", async () => {
    // Drops `included` only where it is empty, as a builder that omits `[]` does.
    const report = await verifyCanned((request) =>
      withData(conformantServe(request), (body) =>
        Array.isArray(body["included"]) && Arr.isArrayEmpty(body["included"])
          ? Rec.remove(body, "included")
          : body,
      ),
    );
    const outcome = outcomeFor(report, "spec/document/included-on-include");
    expect(outcome._tag).toBe("Failed");
    expect(
      Predicate.isTagged(outcome, "Failed") ? outcome.findings.map((found) => found.detail) : [],
    ).toEqual([
      "/articles/1?include= answered a request carrying `include` with no top-level `included` array",
      "/articles?include= answered a request carrying `include` with no top-level `included` array",
    ]);
  });

  it("passes `included: []` and does not flag a response to a request without `include`", async () => {
    // The baseline answers bare requests with no `included` at all; only the four
    // requests carrying `include` (a compound and a bare `?include=` per endpoint) count.
    const report = await verifyCanned(conformantServe, {
      only: ["spec/document/included-on-include"],
    });
    expect(outcomeFor(report, "spec/document/included-on-include")).toMatchObject({
      _tag: "Passed",
      probes: 4,
    });
  });

  it("skips when no endpoint answers a request carrying `include` with a 2xx", async () => {
    const report = await verifyCanned((request) =>
      queryOf(request).has("include") ? badRequest() : conformantServe(request),
    );
    expect(outcomeFor(report, "spec/document/included-on-include")).toMatchObject({
      _tag: "Skipped",
      reason: "no endpoint declaring `include` answered a request carrying it with a 2xx",
    });
  });

  /** The `observed` of `id`'s findings against a server whose documents carry `included`. */
  const observedWith = async (id: string, included: ReadonlyArray<unknown>) => {
    const report = await verifyCanned((request) =>
      withData(conformantServe(request), (body) => ({ ...body, included })),
    );
    const outcome = outcomeFor(report, id);
    expect(outcome._tag).toBe("Failed");
    return Predicate.isTagged(outcome, "Failed")
      ? Arr.dedupe(outcome.findings.map((found) => found.observed))
      : [];
  };

  // `{"toString":1}` is valid JSON that `String` cannot convert: an orphan
  // carrying one is still a finding, not a rule that dies rendering it.
  it("names an orphaned included resource whose type or id is not a string", async () => {
    expect(
      await observedWith("spec/document/full-linkage", [
        { type: { toString: 1 }, id: "2", attributes: {} },
        { type: "people", id: { valueOf: 1 }, attributes: {} },
        { type: "people", lid: "9", attributes: {} },
      ]),
    ).toEqual([`{"toString":1}:2, people:{"valueOf":1}, people:9`]);
  });

  it("names a duplicated included resource by its lid when it has no id", async () => {
    const twice = { type: "people", lid: "9", attributes: {} };
    expect(await observedWith("spec/document/no-duplicate-resources", [twice, twice])).toEqual([
      "people:9 at /included/0 and /included/1",
    ]);
  });

  // `String({"toString":1})` throws: naming the duplicate must not kill the rule.
  it("names a duplicated included resource whose id is not a string by its lid", async () => {
    const twice = { type: "people", id: { toString: 1 }, lid: "9", attributes: {} };
    expect(await observedWith("spec/document/no-duplicate-resources", [twice, twice])).toEqual([
      "people:9 at /included/0 and /included/1",
    ]);
  });

  // The kit keys a resource by its `lid` whenever its `id` is not a string, so
  // the label names the `lid` too, not an `id` the comparison ignored.
  it("names an included resource by the member its identity is keyed on", async () => {
    const twice = { type: "people", id: 7, lid: "8", attributes: {} };
    expect(await observedWith("spec/document/no-duplicate-resources", [twice, twice])).toEqual([
      "people:8 at /included/0 and /included/1",
    ]);
    expect(await observedWith("spec/document/full-linkage", [twice])).toEqual(["people:8"]);
  });

  // #423: a relationship document's primary data is resource linkage, and
  // its identifiers are where the full-linkage walk starts.
  it("walks a relationship document's included members from its primary identifiers", async () => {
    const reads = HttpApi.make("reads").add(
      Group.make(Article, Endpoint.get(Article), Endpoint.getRelationship(Article, "author")),
    );
    const person = (id: string) => ({
      type: "people",
      id,
      attributes: { firstName: "Dan", lastName: "Gebhardt" },
    });
    const serving =
      (included: ReadonlyArray<unknown>) =>
      (request: CannedRequest): Canned =>
        request.path === "/articles/1"
          ? { body: { data: { type: "articles", id: "1", attributes: {} } } }
          : request.path === "/articles/1/relationships/author"
            ? { body: { data: { type: "people", id: "9" }, included } }
            : { status: 404, body: { errors: [{ status: "404" }] } };
    const linked = await verifyOver(reads)(serving([person("9")]), {
      only: ["spec/document/full-linkage"],
    });
    expect(outcomeFor(linked, "spec/document/full-linkage")).toMatchObject({
      _tag: "Passed",
      probes: 1,
    });
    const orphaned = await verifyOver(reads)(serving([person("9"), person("7")]), {
      only: ["spec/document/full-linkage"],
    });
    const outcome = outcomeFor(orphaned, "spec/document/full-linkage");
    expect(
      Predicate.isTagged(outcome, "Failed") ? outcome.findings.map((found) => found.observed) : [],
    ).toEqual(["people:7"]);
  });

  // #443: a relationship document's primary data is resource linkage, not
  // resource objects, so the full resource for a primary identifier may sit in
  // `included` without duplicating anything.
  it("does not count a relationship document's primary identifiers as resources", async () => {
    const reads = HttpApi.make("reads").add(
      Group.make(Article, Endpoint.get(Article), Endpoint.getRelationship(Article, "author")),
    );
    const person = (id: string) => ({
      type: "people",
      id,
      attributes: { firstName: "Dan", lastName: "Gebhardt" },
    });
    const serving =
      (included: ReadonlyArray<unknown>) =>
      (request: CannedRequest): Canned =>
        request.path === "/articles/1"
          ? { body: { data: { type: "articles", id: "1", attributes: {} } } }
          : request.path === "/articles/1/relationships/author"
            ? { body: { data: { type: "people", id: "9" }, included } }
            : { status: 404, body: { errors: [{ status: "404" }] } };
    const findingsOf = async (included: ReadonlyArray<unknown>) => {
      const report = await verifyOver(reads)(serving(included), {
        only: ["spec/document/no-duplicate-resources"],
      });
      const outcome = outcomeFor(report, "spec/document/no-duplicate-resources");
      return Predicate.isTagged(outcome, "Failed")
        ? outcome.findings.map((found) => found.observed)
        : [];
    };
    expect(await findingsOf([person("9")])).toEqual([]);
    expect(await findingsOf([person("9"), person("2")])).toEqual([]);
    expect(await findingsOf([person("9"), person("9")])).toEqual([
      "people:9 at /included/0 and /included/1",
    ]);
  });

  broken(
    "a resource object with a non-string id",
    "spec/document/resource-identification",
    (canned) =>
      withData(canned, (body) => {
        const data = body["data"];
        const bad = <A>(resource: A) => ({ ...(resource as object), id: 1 });
        return { ...body, data: Array.isArray(data) ? data.map(bad) : bad(data) };
      }),
  );

  broken(
    "a jsonapi member whose version is not a string",
    "spec/document/jsonapi-object",
    (canned) => withData(canned, (body) => ({ ...body, jsonapi: { version: 1.1 } })),
  );

  broken(
    "an error response that is not an error document",
    "spec/errors/error-document-shape",
    (canned) =>
      canned.status !== undefined && canned.status >= 400
        ? { ...canned, body: { message: "nope" } }
        : canned,
  );

  broken(
    "an error object whose status is not a string",
    "spec/errors/error-member-types",
    (canned) =>
      canned.status !== undefined && canned.status >= 400
        ? { ...canned, body: { errors: [{ status: canned.status, title: "Bad Request" }] } }
        : canned,
  );

  broken(
    "an error source that is not a JSON Pointer",
    "spec/errors/error-source-discrimination",
    (canned) =>
      canned.status === 400
        ? {
            ...canned,
            body: {
              errors: [{ status: "400", title: "Bad Request", source: { pointer: "data/id" } }],
            },
          }
        : canned,
  );

  broken(
    "an error status that disagrees with the response status",
    "spec/errors/error-status-matches-response",
    (canned) =>
      canned.status === 404
        ? { ...canned, body: { errors: [{ status: "500", title: "Not Found" }] } }
        : canned,
  );

  broken(
    "sparse fieldsets ignored on primary data",
    "spec/query/sparse-fieldsets-primary",
    (canned, request) =>
      request.path.includes("fields[articles]")
        ? conformantServe({
            ...request,
            path: request.path.split("&fields")[0]!.split("?fields")[0]!,
          })
        : canned,
  );

  // #494: a relationship is a field, so a fieldset that leaves it out drops it.
  const withAuthor = (body: Record<string, unknown>) => {
    const data = body["data"];
    return typeof data === "object" && data !== null && "type" in data && data.type === "articles"
      ? {
          ...body,
          data: { ...data, relationships: { author: { data: { type: "people", id: "9" } } } },
        }
      : body;
  };
  broken(
    "a relationship kept under a sparse fieldset that leaves it out",
    "spec/query/sparse-fieldsets-primary",
    (canned, request) =>
      request.path.includes("fields[articles]") ? withData(canned, withAuthor) : canned,
  );
  broken(
    "a relationship kept under an empty sparse fieldset",
    "spec/query/sparse-fieldsets-empty",
    (canned, request) =>
      /fields\[articles\]=(&|$)/.test(request.path) ? withData(canned, withAuthor) : canned,
  );

  // #488: an empty `fields[TYPE]=` read as the absent parameter.
  broken(
    "an empty sparse fieldset read as every field",
    "spec/query/sparse-fieldsets-empty",
    (canned, request) =>
      /fields\[[a-z]+\]=(&|$)/.test(request.path)
        ? conformantServe({
            ...request,
            path: request.path.replace(/[?&]fields\[[a-z]+\]=(?=&|$)/g, ""),
          })
        : canned,
  );

  broken(
    "an unknown query parameter that is not rejected",
    "spec/query/unknown-query-parameter",
    (canned, request) =>
      request.path.includes("unknown=")
        ? conformantServe({ ...request, path: request.path.split("?")[0]! })
        : canned,
  );

  broken(
    "an illegal query parameter name that is not rejected",
    "spec/query/illegal-parameter-name",
    (canned, request) =>
      request.path.includes("foo!=")
        ? conformantServe({ ...request, path: request.path.split("?")[0] ?? request.path })
        : canned,
  );

  broken(
    "an unsupported extension's query parameter that is not rejected",
    "spec/query/unsupported-extension-parameter",
    (canned, request) =>
      request.path.includes("unsupported:param=")
        ? conformantServe({ ...request, path: request.path.split("?")[0] ?? request.path })
        : canned,
  );

  broken(
    "an unidentifiable include path that is not rejected",
    "spec/query/unsupported-include-path",
    (canned, request) =>
      request.path.includes("include=notARelationshipPath")
        ? conformantServe({ ...request, path: request.path.split("?")[0]! })
        : canned,
  );

  broken(
    "an absent resource answered with 200",
    "spec/status/resource-not-found",
    (canned, request) =>
      request.path.includes("conformance-absent-id")
        ? conformantServe({ ...request, path: "/articles/1" })
        : canned,
  );

  broken(
    "a document that does not advertise the JSON:API version",
    "profile/document/jsonapi-member",
    (canned) =>
      withData(canned, (body) => {
        const { jsonapi: _jsonapi, ...rest } = body;
        return rest;
      }),
  );

  broken(
    "the repeated-key spelling of a comma-separated family rejected",
    "profile/query/repeated-key-spelling",
    (canned, request) => {
      const params = new URLSearchParams(request.path.split("?")[1] ?? "");
      for (const key of new Set(params.keys())) {
        if (params.getAll(key).length > 1) {
          return { status: 400, body: { errors: [{ status: "400", source: { parameter: key } }] } };
        }
      }
      return canned;
    },
  );

  // `/articles` declares no `sort`: a server that drops it instead of refusing
  // it answers the collection as if it had never been sent (#278).
  broken(
    "a sort on a collection endpoint that does not declare it, ignored",
    "spec/query/sort-unsupported-endpoint",
    (canned, request) =>
      queryOf(request).has("sort") ? conformantServe(withoutQuery(request)) : canned,
  );

  // No endpoint of the fixture paginates or filters, and each declares only
  // the bare `include`: a server that drops a parameter of either family, or a
  // bracketed `include[]`, answers as if it had never been sent (#310).
  broken(
    "a `page[…]` on an endpoint that declares no `page`, ignored",
    "spec/query/page-unsupported-endpoint",
    (canned, request) =>
      queryOf(request).has("page[limit]") ? conformantServe(withoutQuery(request)) : canned,
  );

  broken(
    "a `filter[…]` on an endpoint that declares no `filter`, ignored",
    "spec/query/filter-unsupported-endpoint",
    (canned, request) =>
      [...queryOf(request).keys()].some((key) => key.startsWith("filter["))
        ? conformantServe(withoutQuery(request))
        : canned,
  );

  broken(
    "a bracketed `include[]` read as `include`",
    "spec/query/include-bracketed",
    (canned, request) =>
      queryOf(request).has("include[]")
        ? conformantServe({
            ...request,
            path: `${withoutQuery(request).path}?include=${queryOf(request).get("include[]")}`,
          })
        : canned,
  );

  it("does not flag anything else when one rule is broken", async () => {
    const report = await verifyCanned((request) => {
      const canned = conformantServe(request);
      return (canned.status ?? 200) === 200
        ? { ...canned, contentType: "application/json" }
        : canned;
    });
    // Exactly the media-type rule, and nothing riding along with it.
    expect(failed(report)).toEqual(["spec/content-negotiation/response-media-type"]);
  });
});

// ---------------------------------------------------------------------------
// `include` / `sort` on an endpoint that does not declare them (#278)
// ---------------------------------------------------------------------------

/**
 * The main fixture declares `include` on every read endpoint, so the include
 * rule has nothing to probe there. This api drops it from `get` and keeps it on
 * `list`, which declares no `sort`: one endpoint for each rule to probe.
 */
/**
 * Twenty-one list endpoints, `/burner0` … `/burner20`, declaring no query
 * parameter: more candidates than a refusal rule's budget of 20 requests
 * reaches when their baselines are unusable.
 */
const burners = HttpApi.make("burners").add(
  ...Arr.map(
    Arr.makeBy(21, (n) => `burner${n}`),
    (type) => {
      const Burner = Resource.make(type, { attributes: { name: Schema.String } });
      return Group.make(Burner, Endpoint.list(Burner));
    },
  ),
);

/** A 500 error document, the answer that makes a baseline unusable. */
const serverError: Canned = { status: 500, body: { errors: [{ status: "500" }] } };

describe("Conformance: include / sort on an endpoint that does not declare them", () => {
  const INCLUDE = "spec/query/include-unsupported-endpoint";
  const SORT = "spec/query/sort-unsupported-endpoint";

  const undeclaredApi = HttpApi.make("undeclared").add(
    Group.make(
      Article,
      Endpoint.get(Article, { fields: true }),
      Endpoint.list(Article, { include: true, fields: true }),
    ),
  );
  const verifyUndeclared = verifyOver(undeclaredApi);

  /** The baseline server, refusing `include` on `/articles/1`, which does not declare it. */
  const undeclaredServe = (request: CannedRequest): Canned =>
    request.path.startsWith("/articles/1") && queryOf(request).has("include")
      ? badRequest({ source: { parameter: "include" } })
      : conformantServe(request);

  it("passes against a server that refuses both, each having probed its endpoint", async () => {
    const report = await verifyUndeclared(undeclaredServe);
    expect(failed(report)).toEqual([]);
    const include = outcomeFor(report, INCLUDE);
    const sort = outcomeFor(report, SORT);
    expect(include).toMatchObject({ _tag: "Passed", probes: 2, note: undefined });
    expect(sort).toMatchObject({ _tag: "Passed", probes: 2, note: undefined });
  });

  it("probes with a relationship name and an attribute name the baseline response shows", async () => {
    const seen: Array<string> = [];
    await verifyUndeclared(
      (request) => {
        seen.push(request.path);
        return undeclaredServe(request);
      },
      { only: [INCLUDE, SORT] },
    );
    expect(seen).toEqual([
      "/articles/1",
      "/articles/1?include=author",
      "/articles",
      "/articles?sort=title",
    ]);
  });

  it("fails the include rule alone when the endpoint ignores `include`", async () => {
    // `conformantServe` serves `?include=author` on `/articles/1` as a compound
    // document — exactly what an endpoint without `include` must not do.
    const report = await verifyUndeclared(conformantServe);
    expect(failed(report)).toEqual([INCLUDE]);
    expect(outcomeFor(report, INCLUDE)).toMatchObject({
      _tag: "Failed",
      findings: [
        {
          detail:
            "`?include=author` on /articles/1, which does not declare `include`, was not rejected",
          expected: "400 Bad Request",
          observed: expect.stringMatching(/^200 /),
          probe: { url: "/articles/1?include=author" },
        },
      ],
    });
  });

  it("fails the sort rule alone when the collection endpoint ignores `sort`", async () => {
    const report = await verifyUndeclared((request) =>
      undeclaredServe(queryOf(request).has("sort") ? withoutQuery(request) : request),
    );
    expect(failed(report)).toEqual([SORT]);
    expect(outcomeFor(report, SORT)).toMatchObject({
      _tag: "Failed",
      findings: [
        {
          detail: "`?sort=title` on /articles, which does not declare `sort`, was not rejected",
          observed: expect.stringMatching(/^200 /),
          probe: { url: "/articles?sort=title" },
        },
      ],
    });
  });

  it("does not take a 4xx other than 400 for the refusal", async () => {
    const report = await verifyUndeclared((request) =>
      queryOf(request).has("include") || queryOf(request).has("sort")
        ? { status: 422, body: { errors: [{ status: "422", source: { parameter: "include" } }] } }
        : undeclaredServe(request),
    );
    const unprocessable = {
      _tag: "Failed",
      findings: [{ observed: expect.stringMatching(/^422 /) }],
    };
    expect(outcomeFor(report, INCLUDE)).toMatchObject(unprocessable);
    expect(outcomeFor(report, SORT)).toMatchObject(unprocessable);
  });

  it("fails a 400 whose `source.parameter` blames another parameter", async () => {
    const report = await verifyUndeclared((request) =>
      queryOf(request).has("include") && request.path.startsWith("/articles/1")
        ? badRequest({ source: { parameter: "fields[articles]" } })
        : undeclaredServe(request),
    );
    expect(failed(report)).toEqual([INCLUDE]);
    expect(outcomeFor(report, INCLUDE)).toMatchObject({
      _tag: "Failed",
      findings: [
        {
          expected: `source: { parameter: "include" }`,
          observed: "source.parameter: `fields[articles]`",
        },
      ],
    });
  });

  it("passes a 400 that names no `source.parameter` — JSON:API makes `source` optional — and says so", async () => {
    const report = await verifyUndeclared((request) => {
      const canned = undeclaredServe(request);
      return canned.status === 400 ? badRequest() : canned;
    });
    expect(failed(report)).toEqual([]);
    const noted = { _tag: "Passed", note: expect.stringContaining("named no `source.parameter`") };
    expect(outcomeFor(report, INCLUDE)).toMatchObject(noted);
    expect(outcomeFor(report, SORT)).toMatchObject(noted);
  });

  it("probes with a placeholder when the baseline shows no name to use", async () => {
    const seen: Array<string> = [];
    await verifyUndeclared(
      (request) => {
        seen.push(request.path);
        // Every baseline resource bare: no attributes or relationships to learn from.
        const bare = { type: "articles", id: "1" };
        if (request.path === "/articles/1") return { body: { data: bare } };
        if (request.path === "/articles") return { body: { data: [bare] } };
        return undeclaredServe(request);
      },
      { only: [INCLUDE, SORT] },
    );
    expect(seen).toContain("/articles/1?include=notARelationshipPath");
    expect(seen).toContain("/articles?sort=notASortableField");
  });

  it("skips — never passes — when every read endpoint declares `include`", async () => {
    const report = await verifyCanned(conformantServe, { only: [INCLUDE] });
    expect(outcomeFor(report, INCLUDE)).toMatchObject({
      _tag: "Skipped",
      reason: "every read endpoint declares `include`",
    });
  });

  it("skips, naming the missing option, when no endpoint without `include` resolves", async () => {
    const report = await verifyUndeclared(undeclaredServe, { ids: {}, only: [INCLUDE] });
    expect(outcomeFor(report, INCLUDE)).toMatchObject({
      _tag: "Skipped",
      reason: expect.stringContaining(`ids["articles"]`),
    });
  });

  it("skips when every collection endpoint declares `sort`", async () => {
    const sorted = HttpApi.make("sorted").add(
      Group.make(Article, Endpoint.list(Article, { sort: true })),
    );
    const report = await verifyOver(sorted)(conformantServe, { only: [SORT] });
    expect(outcomeFor(report, SORT)).toMatchObject({
      _tag: "Skipped",
      reason: "every list and related endpoint declares `sort`",
    });
  });

  it("does not probe `sort` on an endpoint that answers a single resource", async () => {
    // §Sorting's MUST covers collection endpoints only: a to-one related
    // endpoint answering one resource is not one, whatever its role.
    const toOne = HttpApi.make("toOne").add(
      Group.make(Article, Endpoint.get(Article), Endpoint.related(Article, "author")),
    );
    const seen: Array<string> = [];
    const report = await verifyOver(toOne)(
      (request) => {
        seen.push(request.path);
        return request.path.startsWith("/articles/1/author")
          ? { body: { data: { type: "people", id: "9", attributes: { firstName: "Dan" } } } }
          : conformantServe(request);
      },
      { only: [SORT] },
    );
    expect(outcomeFor(report, SORT)).toMatchObject({
      _tag: "Skipped",
      reason:
        "no list or related endpoint without `sort` answered with a resource collection as primary data (/articles/1/author: 200, not a resource collection)",
    });
    expect(seen.some((path) => path.includes("sort="))).toBe(false);
  });

  it("moves past a to-one related endpoint to the collection endpoint after it", async () => {
    // Discovery order puts the to-one `author` endpoint first: the rule must
    // pass over it, not give up on it.
    const mixed = HttpApi.make("mixed").add(
      Group.make(
        Article,
        Endpoint.related(Article, "author"),
        Endpoint.list(Article, { include: true, fields: true }),
      ),
    );
    const seen: Array<string> = [];
    const report = await verifyOver(mixed)(
      (request) => {
        seen.push(request.path);
        return request.path.startsWith("/articles/1/author")
          ? { body: { data: { type: "people", id: "9", attributes: { firstName: "Dan" } } } }
          : conformantServe(request);
      },
      { only: [SORT] },
    );
    expect(outcomeFor(report, SORT)).toMatchObject({ _tag: "Passed", probes: 3, note: undefined });
    expect(seen).toEqual(["/articles/1/author", "/articles", "/articles?sort=title"]);
  });

  it("names each baseline's status when no candidate answered a collection", async () => {
    const report = await verifyUndeclared(
      (request) =>
        request.path === "/articles"
          ? { status: 503, body: { errors: [{ status: "503" }] } }
          : undeclaredServe(request),
      { only: [SORT] },
    );
    expect(outcomeFor(report, SORT)).toMatchObject({
      _tag: "Skipped",
      reason:
        "no list or related endpoint without `sort` answered with a resource collection as primary data (/articles: 503)",
    });
  });

  // #352: a probe that got no response says nothing of whether the server
  // refuses the parameter, so neither rule is decided on it — and neither is
  // failed as "not rejected".
  it("does not decide either on a probe that got no response", async () => {
    const report = await verifyUndeclared(undeclaredServe, { only: [INCLUDE, SORT] }, (client) =>
      HttpClient.make((request) =>
        /[?&](include|sort)=/.test(request.url)
          ? Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request, description: "reset" }),
              }),
            )
          : client.execute(request),
      ),
    );
    const SAYS_NOTHING =
      ", and a rate limit, a request timeout or a lost response says nothing of whether the server refuses the parameter";
    // The transport's own words, between the parentheses, are not pinned.
    expect(
      [outcomeFor(report, INCLUDE), outcomeFor(report, SORT)].map((outcome) =>
        Predicate.isTagged(outcome, "Skipped")
          ? outcome.reason.replace(/no response \(.*\),/, "no response (…),")
          : outcome._tag,
      ),
    ).toEqual([
      `not decided: \`?include=author\` on /articles/1 answered no response (…)${SAYS_NOTHING}`,
      `not decided: \`?sort=title\` on /articles answered no response (…)${SAYS_NOTHING}`,
    ]);
  });

  it.each([429, 408])("does not decide either on a probe answered %i", async (status) => {
    const report = await verifyUndeclared((request) =>
      queryOf(request).size > 0
        ? { status, body: { errors: [{ status: `${status}` }] } }
        : undeclaredServe(request),
    );
    const undecided = (sent: string) => ({
      _tag: "Skipped",
      reason: `not decided: ${sent} answered ${status}, and a rate limit, a request timeout or a lost response says nothing of whether the server refuses the parameter`,
    });
    expect(outcomeFor(report, INCLUDE)).toMatchObject(
      undecided("`?include=author` on /articles/1"),
    );
    expect(outcomeFor(report, SORT)).toMatchObject(undecided("`?sort=title` on /articles"));
  });

  it.each([500, 503])("fails both on a probe answered %i", async (status) => {
    const report = await verifyUndeclared((request) =>
      queryOf(request).size > 0
        ? { status, body: { errors: [{ status: `${status}` }] } }
        : undeclaredServe(request),
    );
    const mishandled = (sent: string, parameter: string, url: string) => ({
      _tag: "Failed",
      findings: [
        {
          detail: `${sent}, which does not declare \`${parameter}\`, was not rejected`,
          expected: "400 Bad Request",
          observed: expect.stringMatching(new RegExp(`^${status} `)),
          probe: { url },
        },
      ],
    });
    expect(outcomeFor(report, INCLUDE)).toMatchObject(
      mishandled("`?include=author` on /articles/1", "include", "/articles/1?include=author"),
    );
    expect(outcomeFor(report, SORT)).toMatchObject(
      mishandled("`?sort=title` on /articles", "sort", "/articles?sort=title"),
    );
  });

  // A `3xx` the kit reads as the answer itself — one with no `Location`, or a
  // `304` — is an answer, not silence, so it fails both as before #352.
  it.each([
    ["a 302 with no `Location`", 302],
    ["a 304", 304],
  ])("fails both on a probe answered %s, the answer itself", async (_, status) => {
    const report = await verifyUndeclared((request) =>
      queryOf(request).size > 0 ? { status } : undeclaredServe(request),
    );
    const notRejected = (sent: string, parameter: string) => ({
      _tag: "Failed",
      findings: [
        {
          detail: `${sent}, which does not declare \`${parameter}\`, was not rejected`,
          expected: "400 Bad Request",
          observed: expect.stringMatching(new RegExp(`^${status}\\b`)),
        },
      ],
    });
    expect(outcomeFor(report, INCLUDE)).toMatchObject(
      notRejected("`?include=author` on /articles/1", "include"),
    );
    expect(outcomeFor(report, SORT)).toMatchObject(
      notRejected("`?sort=title` on /articles", "sort"),
    );
  });

  it("passes a 400 that carries no error objects, and says that is what it carried", async () => {
    const report = await verifyUndeclared((request) => {
      const canned = undeclaredServe(request);
      return canned.status === 400
        ? { status: 400, contentType: "text/plain", body: "no" }
        : canned;
    });
    const noted = {
      _tag: "Passed",
      note: expect.stringContaining("carried no JSON:API error objects"),
    };
    expect(outcomeFor(report, INCLUDE)).toMatchObject(noted);
    expect(outcomeFor(report, SORT)).toMatchObject(noted);
  });

  it("probes `include` only on an endpoint whose baseline succeeded", async () => {
    // Both read endpoints lack `include`; the first one's baseline fails, so a
    // probe there could only fail for that reason. The rule moves on.
    const bare = HttpApi.make("bare").add(
      Group.make(Article, Endpoint.get(Article, { fields: true }), Endpoint.list(Article)),
    );
    const seen: Array<string> = [];
    const report = await verifyOver(bare)(
      (request) => {
        seen.push(request.path);
        if (request.path === "/articles/1")
          return { status: 500, body: { errors: [{ status: "500" }] } };
        return queryOf(request).has("include")
          ? badRequest({ source: { parameter: "include" } })
          : conformantServe(request);
      },
      { only: [INCLUDE] },
    );
    expect(outcomeFor(report, INCLUDE)).toMatchObject({ _tag: "Passed", probes: 3 });
    expect(seen).toEqual(["/articles/1", "/articles", "/articles?include=author"]);
  });

  it("skips `include`, naming each status, when no baseline succeeded", async () => {
    const seen: Array<string> = [];
    const report = await verifyUndeclared(
      (request) => {
        seen.push(request.path);
        return request.path === "/articles/1"
          ? { status: 500, body: { errors: [{ status: "500" }] } }
          : undeclaredServe(request);
      },
      { only: [INCLUDE] },
    );
    expect(outcomeFor(report, INCLUDE)).toMatchObject({
      _tag: "Skipped",
      reason:
        "no read endpoint without `include` answered its baseline request with 2xx (/articles/1: 500)",
    });
    expect(seen).toEqual(["/articles/1"]);
  });

  it.each([INCLUDE, SORT])(
    "stops %s at the refusal rules' budget of 20 requests, skipping rather than passing",
    async (id) => {
      // The #278 rules share the #310 rules' driver, and with it its budget:
      // twenty-one candidates, every baseline a 500, and nineteen are tried.
      const seen: Array<string> = [];
      const report = await verifyOver(burners)(
        (request) => {
          seen.push(request.path);
          return serverError;
        },
        { only: [id] },
      );
      expect(outcomeFor(report, id)).toMatchObject({
        _tag: "Skipped",
        reason: expect.stringMatching(
          /^the rule's budget of 20 requests ran out with 2 endpoints left untried \(\/burner0: 500; .*\/burner18: 500\)$/,
        ),
      });
      expect(seen).toEqual(Arr.makeBy(19, (n) => `/burner${n}`));
    },
  );
});

// ---------------------------------------------------------------------------
// A parameter whose name alone requires a 400 (#438)
// ---------------------------------------------------------------------------

describe("Conformance: a parameter whose name alone requires a 400", () => {
  const rules = [
    [
      "spec/query/unknown-query-parameter",
      "unknown",
      "a name with no non a-z character that the specification does not define",
    ],
    ["spec/query/illegal-parameter-name", "foo!", "a base name that is not a legal member name"],
    [
      "spec/query/unsupported-extension-parameter",
      "unsupported:param",
      "a parameter of an extension the server does not support",
    ],
  ] as const;

  /** `conformantServe`, with `probe` answering every request that carries `name`. */
  const answering =
    (name: string, probe: (request: CannedRequest) => Canned) => (request: CannedRequest) =>
      queryOf(request).has(name) ? probe(request) : conformantServe(request);

  it.each(rules)("%s passes on a 400 naming `%s`, sent after a 2xx baseline", async (id, name) => {
    const seen: Array<string> = [];
    const report = await verifyCanned(
      (request) => {
        seen.push(request.path);
        return conformantServe(request);
      },
      { only: [id] },
    );
    expect(outcomeFor(report, id)).toMatchObject({ _tag: "Passed", probes: 2, note: undefined });
    expect(seen).toEqual(["/articles/1", `/articles/1?${name}=1`]);
  });

  it.each(rules)(
    "%s fails a 400 whose `source.parameter` names another parameter",
    async (id, name) => {
      const report = await verifyCanned(
        answering(name, () => badRequest({ source: { parameter: "include" } })),
        { only: [id] },
      );
      expect(outcomeFor(report, id)).toMatchObject({
        _tag: "Failed",
        findings: [
          {
            detail: `the 400 for \`?${name}=1\` on /articles/1 does not name \`${name}\` in \`source.parameter\`, so it refused something else`,
            expected: `source: { parameter: "${name}" }`,
            observed: "source.parameter: `include`",
            probe: { url: `/articles/1?${name}=1` },
          },
        ],
      });
    },
  );

  it.each(rules)("%s passes a 400 naming no `source.parameter`, and says so", async (id, name) => {
    const report = await verifyCanned(
      answering(name, () => badRequest()),
      { only: [id] },
    );
    expect(outcomeFor(report, id)).toMatchObject({
      _tag: "Passed",
      note: expect.stringContaining("named no `source.parameter`"),
    });
  });

  it.each(Arr.flatMap(rules, ([id, name]) => [[id, name, 429] as const, [id, name, 408] as const]))(
    "%s does not decide on a probe `%s` answered %i",
    async (id, name, status) => {
      const report = await verifyCanned(
        answering(name, () => ({ status, body: { errors: [{ status: `${status}` }] } })),
        { only: [id] },
      );
      expect(outcomeFor(report, id)).toMatchObject({
        _tag: "Skipped",
        reason: `not decided: \`?${name}=1\` on /articles/1 answered ${status}, and a rate limit, a request timeout or a lost response says nothing of whether the server refuses the parameter`,
      });
    },
  );

  it.each(rules)("%s fails a probe answered 500, as not rejected", async (id, name, why) => {
    const report = await verifyCanned(
      answering(name, () => serverError),
      { only: [id] },
    );
    expect(outcomeFor(report, id)).toMatchObject({
      _tag: "Failed",
      findings: [
        {
          detail: `\`?${name}=1\` on /articles/1, ${why}, was not rejected`,
          expected: "400 Bad Request",
          observed: expect.stringMatching(/^500 /),
        },
      ],
    });
  });

  it.each(rules)("%s passes over an endpoint whose baseline fails", async (id, name) => {
    const seen: Array<string> = [];
    const report = await verifyCanned(
      (request) => {
        seen.push(request.path);
        return request.path === "/articles/1" ? serverError : conformantServe(request);
      },
      { only: [id] },
    );
    expect(outcomeFor(report, id)).toMatchObject({ _tag: "Passed", probes: 3 });
    // The next read endpoint's baseline, then the probe on it.
    expect(seen).toHaveLength(3);
    expect(seen[0]).toBe("/articles/1");
    expect(seen[1]).not.toContain("?");
    expect(seen[2]).toBe(`${seen[1]}?${name}=1`);
  });
});

// ---------------------------------------------------------------------------
// Discovery of a hand-built endpoint whose query is not a plain struct (#278)
// ---------------------------------------------------------------------------

/**
 * A hand-built endpoint can declare its query as a union, a suspended schema or
 * a record — shapes the middleware reads (a union's members, a suspend's
 * target) or stands aside for (a record). Discovery must read them the same
 * way, or the unsupported-parameter rules probe an endpoint that does accept
 * the parameter and report a failure against the library's own middleware.
 */
describe("Conformance: a hand-built query that is not a plain struct", () => {
  const INCLUDE = "spec/query/include-unsupported-endpoint";
  const SORT = "spec/query/sort-unsupported-endpoint";

  const handBuilt = <E extends HttpApiEndpoint.Constraint>(endpoint: E) =>
    HttpApi.make("handBuilt").add(HttpApiGroup.make("articles").add(endpoint));

  /** A server that honours `sort` on `/articles` — as an endpoint declaring it would. */
  const sorting = (request: CannedRequest): Canned =>
    conformantServe(queryOf(request).has("sort") ? withoutQuery(request) : request);

  it("reads the members of a union query", async () => {
    const get = HttpApiEndpoint.get("get", "/articles/:id", {
      params: { id: Schema.String },
      query: Schema.Union([
        Schema.Struct({ include: Schema.optional(Schema.String) }),
        Schema.Struct({ "fields[articles]": Schema.optional(Schema.String) }),
      ]),
      success: Schema.Unknown,
    });
    // `conformantServe` honours `include` on /articles/1, as the endpoint declares it.
    const report = await verifyOver(handBuilt(get))(conformantServe, { only: [INCLUDE] });
    expect(outcomeFor(report, INCLUDE)).toMatchObject({
      _tag: "Skipped",
      reason: "every read endpoint declares `include`",
    });
  });

  it("follows a suspended query", async () => {
    const list = HttpApiEndpoint.get("list", "/articles", {
      query: Schema.suspend(() => Schema.Struct({ sort: Schema.optional(Schema.String) })),
      success: Schema.Unknown,
    });
    const report = await verifyOver(handBuilt(list))(sorting, { only: [SORT] });
    expect(outcomeFor(report, SORT)).toMatchObject({
      _tag: "Skipped",
      reason: "every list and related endpoint declares `sort`",
    });
  });

  it("does not probe an endpoint whose query names cannot be enumerated", async () => {
    const list = HttpApiEndpoint.get("list", "/articles", {
      query: Schema.Record(Schema.String, Schema.String),
      success: Schema.Unknown,
    });
    const seen: Array<string> = [];
    const report = await verifyOver(handBuilt(list))(
      (request) => {
        seen.push(request.path);
        return sorting(request);
      },
      { only: [SORT] },
    );
    expect(outcomeFor(report, SORT)).toMatchObject({
      _tag: "Skipped",
      reason:
        "every list and related endpoint declares `sort` or has a query whose parameter names cannot be enumerated (/articles)",
    });
    expect(seen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A family or member the endpoint does not declare (#310)
// ---------------------------------------------------------------------------

/**
 * `get` declares no query at all, so it must refuse `fields[articles]`,
 * `page[…]` and `filter[…]`; `list` declares the bare `include` and `sort`,
 * offset page keys and a `filter[title]` member, so it must refuse a
 * bracketed `include[]` / `sort[]` and an undeclared `page` / `filter` member.
 */
describe("Conformance: a family or member the endpoint does not declare", () => {
  const RULES = {
    fields: "spec/query/fields-unsupported-endpoint",
    page: "spec/query/page-unsupported-endpoint",
    filter: "spec/query/filter-unsupported-endpoint",
    pageMember: "spec/query/page-undeclared-member",
    filterMember: "spec/query/filter-undeclared-member",
    include: "spec/query/include-bracketed",
    sort: "spec/query/sort-bracketed",
  } as const;
  const ALL = [
    RULES.fields,
    RULES.page,
    RULES.filter,
    RULES.pageMember,
    RULES.filterMember,
    RULES.include,
    RULES.sort,
  ];

  const familyApi = HttpApi.make("families").add(
    Group.make(
      Article,
      Endpoint.get(Article),
      Endpoint.list(Article, {
        include: true,
        sort: true,
        page: Query.Page.Offset,
        filter: { title: Schema.optionalKey(Schema.String) },
      }),
    ),
  );
  const verifyFamily = verifyOver(familyApi);

  /** The names of the specification's families the endpoint at `path` declares. */
  const declaredAt = (path: string): ReadonlyArray<string> =>
    path === "/articles" ? ["include", "sort", "page[offset]", "page[limit]", "filter[title]"] : [];
  const FAMILY = /^(include|sort|page|filter|fields)(\[|$)/;

  /**
   * A server that refuses a name of a family its endpoint does not declare,
   * naming it, as `Middleware.SchemaErrors` does — except the ones `ignored`
   * picks, which it drops, answering as if they had never been sent.
   */
  const familyServe =
    (ignored: (key: string) => boolean = () => false) =>
    (request: CannedRequest): Canned => {
      const { path } = withoutQuery(request);
      const sent = Arr.filter([...queryOf(request)], ([key]) => !ignored(key));
      const refused = Arr.findFirst(
        sent,
        ([key]) => FAMILY.test(key) && !declaredAt(path).includes(key),
      );
      if (Option.isSome(refused)) return badRequest({ source: { parameter: refused.value[0] } });
      const kept = new URLSearchParams(sent);
      return conformantServe({ ...request, path: kept.size === 0 ? path : `${path}?${kept}` });
    };

  /** Each rule, the parameter it sends, and the URL it sends it to. */
  const PROBES = [
    [RULES.fields, "fields[articles]", "/articles/1?fields[articles]=title"],
    [RULES.page, "page[limit]", "/articles/1?page[limit]=1"],
    [RULES.filter, "filter[title]", "/articles/1?filter[title]=1"],
    [RULES.pageMember, "page[offset_x]", "/articles?page[offset_x]=1"],
    [RULES.filterMember, "filter[title_x]", "/articles?filter[title_x]=1"],
    [RULES.include, "include[]", "/articles?include[]=author"],
    [RULES.sort, "sort[]", "/articles?sort[]=title"],
  ] as const;

  it("passes against a server that refuses each, having probed only an undeclared name", async () => {
    const seen: Array<string> = [];
    const report = await verifyFamily((request) => {
      seen.push(request.path);
      return familyServe()(request);
    });
    expect(failed(report)).toEqual([]);
    expect(Arr.map(ALL, (id) => outcomeFor(report, id))).toEqual(
      Arr.map(ALL, () => expect.objectContaining({ _tag: "Passed", probes: 2, note: undefined })),
    );
    // A baseline, then the probe, for each rule in turn: never a declared name.
    const probed = seen.filter((path) => PROBES.some(([, , url]) => url === path));
    expect(probed).toEqual(PROBES.map(([, , url]) => url));
  });

  it("decides none on a probe a transport followed off the origin itself", async () => {
    // Every baseline is answered; every probe is followed to another origin.
    const report = await verifyFamily(
      familyServe(),
      undefined,
      followingOffsite((_, url) =>
        PROBES.some(([, , probe]) => probe === decodeURIComponent(`${url.pathname}${url.search}`)),
      ),
    );
    expect(failed(report)).toEqual([]);
    expect(Arr.map(PROBES, ([id]) => outcomeFor(report, id))).toEqual(
      Arr.map(PROBES, ([, , url]) =>
        expect.objectContaining({
          _tag: "Skipped",
          reason: expect.stringContaining(
            // The URL the transport ended at is named as it sent it, brackets encoded.
            `1 of 2 requests the rule sent were answered by a redirect the kit does not follow or read (GET ${url} answered ${followed(url.replaceAll("[", "%5B").replaceAll("]", "%5D"))})`,
          ),
        }),
      ),
    );
    // A redirect is no lost response, so the rule's own reason does not say
    // that a lost response says nothing.
    expect(
      Arr.filter(PROBES, ([id]) => {
        const outcome = outcomeFor(report, id);
        return (
          Predicate.isTagged(outcome, "Skipped") &&
          outcome.reason.includes("a lost response says nothing")
        );
      }),
    ).toEqual([]);
  });

  it.each(PROBES)("fails %s alone when the server ignores `%s`", async (id, parameter, url) => {
    const report = await verifyFamily(familyServe((key) => key === parameter));
    expect(failed(report)).toEqual([id]);
    expect(outcomeFor(report, id)).toMatchObject({
      _tag: "Failed",
      findings: [
        {
          detail: `\`${url.slice(url.indexOf("?"))}\` on ${url.split("?")[0]}, which does not declare \`${parameter}\`, was not rejected`,
          expected: "400 Bad Request",
          observed: expect.stringMatching(/^200 /),
          probe: { url },
        },
      ],
    });
  });

  it("fails a 400 whose `source.parameter` blames another parameter", async () => {
    const report = await verifyFamily(
      (request) => {
        const canned = familyServe()(request);
        return canned.status === 400 ? badRequest({ source: { parameter: "include" } }) : canned;
      },
      { only: [RULES.page] },
    );
    expect(outcomeFor(report, RULES.page)).toMatchObject({
      _tag: "Failed",
      findings: [
        {
          expected: `source: { parameter: "page[limit]" }`,
          observed: "source.parameter: `include`",
        },
      ],
    });
  });

  it.each([429, 408])("does not decide on a probe answered %i", async (status) => {
    const report = await verifyFamily((request) =>
      queryOf(request).size > 0
        ? { status, body: { errors: [{ status: `${status}` }] } }
        : familyServe()(request),
    );
    expect(Arr.map(PROBES, ([id]) => outcomeFor(report, id))).toEqual(
      Arr.map(PROBES, ([id, , url]) => ({
        _tag: "Skipped",
        rule: expect.objectContaining({ id }),
        reason: `not decided: \`${url.slice(url.indexOf("?"))}\` on ${url.split("?")[0]} answered ${status}, and a rate limit, a request timeout or a lost response says nothing of whether the server refuses the parameter`,
      })),
    );
  });

  // #352: a server that answers 5xx to a parameter it does not support
  // mishandled it.
  it.each([500, 503])("fails each on a probe answered %i", async (status) => {
    const report = await verifyFamily((request) =>
      queryOf(request).size > 0
        ? { status, body: { errors: [{ status: `${status}` }] } }
        : familyServe()(request),
    );
    expect(failed(report)).toEqual(expect.arrayContaining(PROBES.map(([id]) => id)));
    expect(Arr.map(PROBES, ([id]) => outcomeFor(report, id))).toEqual(
      Arr.map(PROBES, ([id, parameter, url]) =>
        expect.objectContaining({
          _tag: "Failed",
          rule: expect.objectContaining({ id }),
          findings: [
            expect.objectContaining({
              detail: `\`${url.slice(url.indexOf("?"))}\` on ${url.split("?")[0]}, which does not declare \`${parameter}\`, was not rejected`,
              expected: "400 Bad Request",
              observed: expect.stringMatching(new RegExp(`^${status} `)),
              probe: expect.objectContaining({ url }),
            }),
          ],
        }),
      ),
    );
  });

  it("does not decide on a probe that got no response", async () => {
    const report = await verifyFamily(familyServe(), { only: ALL }, (client) =>
      HttpClient.make((request) =>
        request.url.includes("?")
          ? Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request, description: "reset" }),
              }),
            )
          : client.execute(request),
      ),
    );
    expect(Arr.map(ALL, (id) => outcomeFor(report, id))).toEqual(
      Arr.map(ALL, () =>
        expect.objectContaining({
          _tag: "Skipped",
          reason: expect.stringMatching(
            /^not decided: .* answered no response \(.*\), and a rate limit, a request timeout or a lost response says nothing of whether the server refuses the parameter$/,
          ),
        }),
      ),
    );
  });

  it("probes a member derived past every name the endpoint declares", async () => {
    const crowded = HttpApi.make("crowded").add(
      Group.make(
        Article,
        Endpoint.list(Article, {
          filter: {
            title: Schema.optionalKey(Schema.String),
            title_x: Schema.optionalKey(Schema.String),
          },
        }),
      ),
    );
    const seen: Array<string> = [];
    const report = await verifyOver(crowded)(
      (request) => {
        seen.push(request.path);
        return queryOf(request).has("filter[title_x_x]")
          ? badRequest({ source: { parameter: "filter[title_x_x]" } })
          : conformantServe(request);
      },
      { only: [RULES.filterMember] },
    );
    expect(outcomeFor(report, RULES.filterMember)).toMatchObject({ _tag: "Passed" });
    expect(seen).toEqual(["/articles", "/articles?filter[title_x_x]=1"]);
  });

  it("probes `fields` only for a type the endpoint does not declare", async () => {
    // Every endpoint of the main fixture declares `fields[TYPE]` for every type
    // it can show, so there is no undeclared fieldset to probe.
    const seen: Array<string> = [];
    const report = await verifyCanned(
      (request) => {
        seen.push(request.path);
        return conformantServe(request);
      },
      { only: [RULES.fields] },
    );
    expect(outcomeFor(report, RULES.fields)).toMatchObject({
      _tag: "Skipped",
      reason:
        "no read endpoint answered its baseline request with 2xx showing a type it does not declare `fields[TYPE]` for (/articles/1: declares `fields[TYPE]` for every type its baseline shows (articles); /articles: declares `fields[TYPE]` for every type its baseline shows (articles))",
    });
    expect(seen).toEqual(["/articles/1", "/articles"]);
  });

  it("skips, naming why, when no endpoint has the shape a rule probes", async () => {
    const report = await verifyCanned(conformantServe, {
      only: [RULES.pageMember, RULES.filterMember, RULES.sort],
    });
    expect(outcomeFor(report, RULES.pageMember)).toMatchObject({
      _tag: "Skipped",
      reason: "no read endpoint declares `page[…]` members by name without an open `page[` record",
    });
    expect(outcomeFor(report, RULES.filterMember)).toMatchObject({
      _tag: "Skipped",
      reason:
        "no read endpoint declares `filter[…]` members by name without an open `filter[` record",
    });
    expect(outcomeFor(report, RULES.sort)).toMatchObject({
      _tag: "Skipped",
      reason: "no read endpoint declares the bare `sort` and not `sort[]`",
    });
  });

  it.each(["include", "sort"] as const)(
    "never probes `%s[]` on an endpoint that declares it beside the bare parameter",
    async (family) => {
      // A hand-built query may accept the bracketed spelling too; the
      // endpoint then knows how to process it, so there is nothing to refuse.
      const both = Schema.Struct({
        [family]: Schema.optional(Schema.String),
        [`${family}[]`]: Schema.optional(Schema.String),
      });
      const handBuilt = HttpApi.make("bracketed").add(
        HttpApiGroup.make("articles")
          .add(
            HttpApiEndpoint.get("get", "/articles/:id", {
              params: { id: Schema.String },
              query: both,
              success: Schema.Unknown,
            }),
          )
          .add(HttpApiEndpoint.get("list", "/articles", { query: both, success: Schema.Unknown })),
      );
      const seen: Array<string> = [];
      const report = await verifyOver(handBuilt)(
        (request) => {
          seen.push(request.path);
          return conformantServe(request);
        },
        { only: [RULES[family]] },
      );
      expect(outcomeFor(report, RULES[family])).toEqual({
        _tag: "Skipped",
        rule: expect.objectContaining({ id: RULES[family] }),
        reason: `no read endpoint declares the bare \`${family}\` and not \`${family}[]\``,
      });
      expect(seen).toEqual([]);
    },
  );

  it("never puts a type or attribute name that needs encoding into a probe's parameter", async () => {
    // Every baseline shows an attribute `a b` first, and `/articles/1` a
    // primary resource of type `a b` beside an included `articles`: each rule
    // reaches past them for a name that goes into a parameter as itself, or
    // falls back on its placeholder.
    const awkward = { "a b": "x", title: "t" };
    const seen: Array<string> = [];
    const report = await verifyFamily(
      (request) => {
        seen.push(request.path);
        if (request.path === "/articles/1")
          return {
            body: {
              data: { type: "a b", id: "1", attributes: { "a b": "x" } },
              included: [{ type: "articles", id: "1", attributes: awkward }],
            },
          };
        if (request.path === "/articles")
          return { body: { data: [{ type: "articles", id: "1", attributes: awkward }] } };
        return familyServe()(request);
      },
      { only: [RULES.fields, RULES.filter, RULES.sort] },
    );
    expect(failed(report)).toEqual([]);
    expect(seen.filter((path) => path.includes("?"))).toEqual([
      "/articles/1?fields[articles]=title",
      "/articles/1?filter[x]=1",
      "/articles?sort[]=title",
    ]);
  });

  it("never probes an open `filter[…]` grammar, which validates every member itself", async () => {
    const Product = Resource.make("products", {
      attributes: { name: Schema.String.pipe(Filter.able([Filter.Op.eq])) },
    });
    const grammar = HttpApi.make("grammar").add(
      Group.make(Product, Endpoint.list(Product, { filter: true, page: Query.Page.Offset })),
    );
    const seen: Array<string> = [];
    const report = await verifyOver(grammar)(
      (request) => {
        seen.push(request.path);
        return conformantServe(request);
      },
      { only: [RULES.filter, RULES.filterMember, RULES.page] },
    );
    expect(outcomeFor(report, RULES.filter)).toMatchObject({
      _tag: "Skipped",
      reason: "every read endpoint declares a `filter` parameter",
    });
    expect(outcomeFor(report, RULES.filterMember)).toMatchObject({
      _tag: "Skipped",
      reason:
        "no read endpoint declares `filter[…]` members by name without an open `filter[` record",
    });
    expect(outcomeFor(report, RULES.page)).toMatchObject({
      _tag: "Skipped",
      reason: "every read endpoint declares a `page` parameter",
    });
    expect(seen).toEqual([]);
  });

  it("reads a hand-built open record of a family as declaring all of it", async () => {
    // `/articles` declares `filter[status]` beside an open `filter[…]` record,
    // `/articles/:id` an open `page[…]` record alone: each admits every member
    // of its family, so neither is probed for one.
    const open = (head: string) =>
      Schema.Record(Schema.TemplateLiteral([head, Schema.String, "]"]), Schema.String);
    const handBuilt = HttpApi.make("open").add(
      HttpApiGroup.make("articles")
        .add(
          HttpApiEndpoint.get("get", "/articles/:id", {
            params: { id: Schema.String },
            query: Schema.StructWithRest(Schema.Struct({}), [open("page[")]),
            success: Schema.Unknown,
          }),
        )
        .add(
          HttpApiEndpoint.get("list", "/articles", {
            query: Schema.StructWithRest(
              Schema.Struct({ "filter[status]": Schema.optional(Schema.String) }),
              [open("filter[")],
            ),
            success: Schema.Unknown,
          }),
        ),
    );
    const seen: Array<string> = [];
    const report = await verifyOver(handBuilt)(
      (request) => {
        seen.push(request.path);
        return conformantServe(request);
      },
      { only: [RULES.filterMember, RULES.page] },
    );
    expect(outcomeFor(report, RULES.filterMember)).toMatchObject({
      _tag: "Skipped",
      reason:
        "no read endpoint declares `filter[…]` members by name without an open `filter[` record",
    });
    // `/articles/1`, first, declares every `page[…]`; `/articles` declares no
    // `page`, so it is the one `page[limit]` is sent to.
    expect(outcomeFor(report, RULES.page)).toMatchObject({ _tag: "Passed" });
    expect(seen).toEqual(["/articles", "/articles?page[limit]=1"]);
  });

  it("stops at its request budget, skipping rather than passing", async () => {
    // Twenty-one read endpoints without `page`, every baseline a 500: the rule
    // tries nineteen, which leaves no room for a baseline and its probe.
    const seen: Array<string> = [];
    const report = await verifyOver(burners)(
      (request) => {
        seen.push(request.path);
        return serverError;
      },
      { only: [RULES.page] },
    );
    expect(outcomeFor(report, RULES.page)).toMatchObject({
      _tag: "Skipped",
      reason: expect.stringMatching(
        /^the rule's budget of 20 requests ran out with 2 endpoints left untried \(\/burner0: 500; .*\/burner18: 500\)$/,
      ),
    });
    expect(seen).toEqual(Arr.makeBy(19, (n) => `/burner${n}`));
  });

  it("counts the redirects a baseline follows against its request budget", async () => {
    // Each baseline is a same-origin 302 the kit follows to a 500: two
    // requests an endpoint. Nine take eighteen; the tenth baseline gets the
    // one request the probe would not need, which leaves its 302 unfollowed,
    // and the rule stops there — nineteen requests, not thirty-eight.
    const seen: Array<string> = [];
    const report = await verifyOver(burners)(
      (request) => {
        seen.push(request.path);
        return request.path.startsWith("/moved/")
          ? serverError
          : { status: 302, headers: { location: `/moved${request.path}` } };
      },
      { only: [RULES.page] },
    );
    const tenth =
      "/burner9: a 302 redirect to http://fixture.test/moved/burner9, which the kit does not follow: the rule's request budget has no request left for it";
    expect(outcomeFor(report, RULES.page)).toMatchObject({
      _tag: "Skipped",
      reason: `the rule's budget of 20 requests ran out with 11 endpoints left untried (${Arr.makeBy(9, (n) => `/burner${n}: 500`).join("; ")}; ${tenth}); 1 of 10 requests the rule sent were answered by a redirect the kit does not follow or read (GET ${tenth.replace(": a 302", " answered a 302")})`,
    });
    expect(seen).toEqual([
      ...Arr.flatMap(
        Arr.makeBy(9, (n) => `/burner${n}`),
        (path) => [path, `/moved${path}`],
      ),
      "/burner9",
    ]);
  });
});
// ---------------------------------------------------------------------------
// The filter grammar profile rules
// ---------------------------------------------------------------------------

/**
 * The grammar rules skip against every api in this repo — none declares
 * `filter: true` — so without a fixture that turns the grammar on they would
 * ship never having run anywhere. This is that fixture.
 */
describe("Conformance: the filter grammar profile", () => {
  const Product = Resource.make("products", {
    attributes: {
      name: Schema.NonEmptyString.pipe(Filter.able([Filter.Op.eq, Filter.Op.ne])),
      priceCents: Schema.Int.pipe(Filter.able([Filter.Op.eq, Filter.Op.gt, Filter.Op.lt])),
    },
  });

  const grammarApi = HttpApi.make("catalog").add(
    Group.make(Product, Endpoint.list(Product, { filter: true })),
  );

  const row = { type: "products", id: "1", attributes: { name: "Widget", priceCents: 1200 } };

  /** A server that implements the grammar's §2/§4/§5/§7 surface correctly. */
  const grammarServe = (request: { readonly path: string }): Canned => {
    const [, search = ""] = request.path.split("?");
    const raw = new URLSearchParams(search);
    const contentType = `${MEDIA_TYPE};profile="${Filter.PROFILE_URI}"`;
    const reject = (parameter: string): Canned => ({
      status: 400,
      contentType,
      body: { errors: [{ status: "400", title: "Bad Request", source: { parameter } }] },
    });

    const declared = HashMap.fromIterable<string, ReadonlyArray<string>>([
      ["name", ["eq", "ne"]],
      ["priceCents", ["eq", "gt", "lt"]],
    ]);
    const conditions = new Map<string, { path?: string; operator?: string; value?: string }>();

    for (const key of new Set(raw.keys())) {
      if (!key.startsWith("filter")) continue;
      // §2: a repeated `filter[…]` key is a 400.
      if (raw.getAll(key).length > 1) return reject(key);
      const segments = [...key.matchAll(/\[([^\]]*)\]/g)].map((match) => match[1]!);
      const value = raw.get(key)!;

      // Group form: filter[id][condition][member].
      if (segments.length === 3 && segments[1] === "condition") {
        const entry = conditions.get(segments[0]!) ?? {};
        if (segments[2] === "path" || segments[2] === "operator" || segments[2] === "value") {
          entry[segments[2]] = value;
          conditions.set(segments[0]!, entry);
          continue;
        }
        return reject(key);
      }
      // Shorthand: filter[field] or filter[field][op]. Anything deeper is a 400.
      if (segments.length > 2 || Arr.isReadonlyArrayEmpty(segments)) return reject(key);
      const field = segments[0]!;
      const operators = Option.getOrUndefined(HashMap.get(declared, field));
      if (operators === undefined) return reject(key);
      const operator = segments.length === 2 ? segments[1]! : "eq";
      if (!operators.includes(operator)) return reject(key);
      conditions.set(key, { path: field, operator, value });
    }

    for (const [id, condition] of conditions) {
      if (
        condition.path === undefined ||
        condition.operator === undefined ||
        condition.value === undefined
      ) {
        return reject(`filter[${id}][condition][operator]`);
      }
      const operators = Option.getOrUndefined(HashMap.get(declared, condition.path));
      if (operators === undefined || !operators.includes(condition.operator)) {
        return reject(`filter[${id}][condition][operator]`);
      }
    }

    return { contentType, body: { jsonapi: { version: "1.1" }, data: [row] } };
  };

  const verifyGrammar = (
    serve: (request: {
      readonly method: string;
      readonly path: string;
      readonly headers: Headers;
    }) => Canned,
    options?: Conformance.Options,
  ) =>
    Effect.runPromise(
      Conformance.verifyWith(grammarApi, {
        client: cannedClient(serve),
        baseUrl: "http://fixture.test",
        tiers: ["profile"],
        only: ["profile/filter"],
        ...options,
      }),
    );

  it("passes against a server that implements the grammar", async () => {
    const report = await verifyGrammar(grammarServe);
    expect(failed(report)).toEqual([]);
    // And genuinely ran, rather than skipping its way to a clean report.
    for (const id of ["advertises-profile-uri", "rejections", "spelling-equivalence"]) {
      expect(outcomeFor(report, `profile/filter/${id}`)._tag).toBe("Passed");
    }
  });

  it("skips — never passes — against an api that does not declare the grammar", async () => {
    const report = await Effect.runPromise(
      Conformance.verifyWith(api, {
        client: cannedClient(conformantServe),
        baseUrl: "http://fixture.test",
        ids: { articles: "1" },
        only: ["profile/filter"],
      }),
    );
    for (const outcome of report.outcomes) {
      assert(Predicate.isTagged(outcome, "Skipped"));
      expect(outcome.reason).toContain("filter: true");
    }
  });

  it("detects a server that does not advertise the profile", async () => {
    const report = await verifyGrammar((request) => {
      const canned = grammarServe(request);
      return { ...canned, contentType: MEDIA_TYPE };
    });
    expect(failed(report)).toContain("profile/filter/advertises-profile-uri");
  });

  it("finds the profile in a space-separated `profile` list", async () => {
    const report = await verifyGrammar(
      (request) => ({
        ...grammarServe(request),
        contentType: `${MEDIA_TYPE};profile="${Idempotency.PROFILE_URI} ${Filter.PROFILE_URI}"`,
      }),
      { only: ["profile/filter/advertises-profile-uri"] },
    );
    expect(outcomeFor(report, "profile/filter/advertises-profile-uri")).toMatchObject({
      _tag: "Passed",
      probes: 1,
    });
  });

  it("detects an operator outside the closed core being accepted", async () => {
    const report = await verifyGrammar((request) =>
      request.path.includes("definitelyNotAnOperator")
        ? { contentType: `${MEDIA_TYPE};profile="${Filter.PROFILE_URI}"`, body: { data: [row] } }
        : grammarServe(request),
    );
    const outcome = outcomeFor(report, "profile/filter/rejections");
    assert(Predicate.isTagged(outcome, "Failed"));
    expect(outcome.findings.some((found) => found.detail.includes("outside the core"))).toBe(true);
  });

  it("detects a rejection that does not name the offending key in source.parameter", async () => {
    const report = await verifyGrammar((request) => {
      const canned = grammarServe(request);
      if (canned.status !== 400) return canned;
      return { ...canned, body: { errors: [{ status: "400", title: "Bad Request" }] } };
    });
    const outcome = outcomeFor(report, "profile/filter/rejections");
    assert(Predicate.isTagged(outcome, "Failed"));
    expect(outcome.findings.every((found) => found.detail.includes("source.parameter"))).toBe(true);
  });

  it("spells equivalent filters on the first string attribute, escaped (#458)", async () => {
    // The first attribute is a number: the rule moves on to `name`, and
    // escapes the comma §2.3 would otherwise read as a list separator.
    const paths: Array<string> = [];
    const leading = { ...row, attributes: { priceCents: 1200, name: "Widget, large" } };
    const report = await verifyGrammar(
      (request) => {
        paths.push(decodeURIComponent(request.path));
        const canned = grammarServe(request);
        return canned.status === undefined ? { ...canned, body: { data: [leading] } } : canned;
      },
      { only: ["profile/filter/spelling-equivalence"] },
    );
    expect(outcomeFor(report, "profile/filter/spelling-equivalence")).toMatchObject({
      _tag: "Passed",
    });
    expect(paths).toContain("/products?filter[name]=Widget\\, large");
  });

  it("detects the group form disagreeing with the shorthand it desugars from", async () => {
    const report = await verifyGrammar((request) =>
      request.path.includes("%5Bcondition%5D") || request.path.includes("[condition]")
        ? { contentType: `${MEDIA_TYPE};profile="${Filter.PROFILE_URI}"`, body: { data: [] } }
        : grammarServe(request),
    );
    const outcome = outcomeFor(report, "profile/filter/spelling-equivalence");
    expect(outcome._tag).toBe("Failed");
  });
});

// ---------------------------------------------------------------------------
// The filter evaluation oracle
// ---------------------------------------------------------------------------

/**
 * `profile/filter/evaluation` judges a filtered collection against the kit's
 * own §6 fold over the collection served unfiltered (#161). Its servers decode
 * the filter with the package's own codec and evaluate it with an evaluator of
 * their own — SQL's three-valued reading for the correct one, written here
 * independently of the kit's fold, so the oracle is not checked against itself
 * — and the broken ones are each one familiar way of getting §6 wrong: NULL
 * read as a value (#161), NULL sorted below every value, numbers compared as
 * text, empty linkage read as a value, and a filter evaluated on the sparse
 * representation rather than the complete one (#433).
 */
describe("Conformance: the filter evaluation oracle", () => {
  const Maker = Resource.make("makers", { attributes: {} });

  const Product = Resource.make("products", {
    attributes: {
      price: Resource.attribute(Schema.Number, { filter: true }),
      name: Resource.attribute(Schema.String, { filter: true }),
      colour: Resource.attribute(Schema.NullOr(Schema.String), { filter: true }),
    },
    relationships: { maker: Relationship.optional(() => Maker, { filter: true }) },
  });

  const oracleApi = HttpApi.make("catalog").add(
    Group.make(Product, Endpoint.list(Product, { filter: true, fields: true, include: true })),
  );

  const decodeFilter = Schema.decodeUnknownOption(Query.Filter(Product));

  type Scalar = string | number;

  type Attributes = Readonly<Record<string, Scalar | null>>;

  /** A `maker` relationship's linkage on the wire: empty (`data: null`) for `None`. */
  const linkage = (maker: Option.Option<string>) => ({
    data: Option.match(maker, {
      onNone: () => null,
      onSome: (id) => ({ type: "makers" as const, id }),
    }),
  });

  interface Relationships {
    readonly maker?: ReturnType<typeof linkage> | { readonly links: { readonly related: string } };
  }

  interface Product {
    readonly type: "products";
    readonly id: string;
    readonly attributes: Attributes;
    /** Absent when a fieldset leaves `maker` out; links only when it shows no linkage. */
    readonly relationships?: Relationships;
  }

  const product = (id: string, attributes: Attributes, maker: Option.Option<string>): Product => ({
    type: "products",
    id,
    attributes,
    relationships: { maker: linkage(maker) },
  });

  // `price` is never NULL and orders differently as text (`"100" < "20"`);
  // `colour` and `maker` are NULL on products:3 alone.
  const products: ReadonlyArray<Product> = [
    product("1", { price: 10, name: "Widget", colour: "red" }, Option.some("m1")),
    product("2", { price: 5, name: "Gadget", colour: "blue" }, Option.some("m2")),
    product("3", { price: 100, name: "Gizmo", colour: null }, Option.none()),
    product("4", { price: 20, name: "Doohickey", colour: "red" }, Option.some("m1")),
  ];

  /** A server's reading of a tree for one resource: `None` is UNKNOWN. */
  type Evaluator = (node: Filter.Node, row: Product) => Option.Option<boolean>;

  /**
   * A resource's value for a field — an attribute's, or a to-one
   * relationship's related id — `None` when it is `null` or absent.
   */
  const valueIn = (row: Product, field: string): Option.Option<Scalar> =>
    field === "maker"
      ? Option.flatMap(Option.fromUndefinedOr(row.relationships?.maker), (maker) =>
          "data" in maker ? Option.fromNullishOr(maker.data?.id) : Option.none(),
        )
      : Option.fromNullishOr(row.attributes[field]);

  /** A decoded literal as the scalar it compares as: `price`'s a number, every other a string. */
  const scalarOf = (literal: Filter.Compare["value"]): Scalar =>
    Predicate.isNumber(literal) ? literal : String(literal);

  /** Numbers numerically, strings by code unit, which is code point here. */
  const order = (v: Scalar, x: Scalar): number =>
    Predicate.isNumber(v) && Predicate.isNumber(x)
      ? v - x
      : String(v) < String(x)
        ? -1
        : String(v) > String(x)
          ? 1
          : 0;

  /** A relation on an order, by operator. */
  const RELATIONS: Readonly<Record<Filter.CompareOperator, (order: number) => boolean>> = {
    eq: (o) => o === 0,
    ne: (o) => o !== 0,
    lt: (o) => o < 0,
    lte: (o) => o <= 0,
    gt: (o) => o > 0,
    gte: (o) => o >= 0,
  };

  const isOrdering = (op: Filter.CompareOperator): boolean =>
    op === "lt" || op === "lte" || op === "gt" || op === "gte";

  /** Kleene's connective over `members`: `decisive` wins, else any UNKNOWN, else `!decisive`. */
  const kleene = (
    results: ReadonlyArray<Option.Option<boolean>>,
    decisive: boolean,
  ): Option.Option<boolean> =>
    Arr.some(results, (result) => Option.contains(result, decisive))
      ? Option.some(decisive)
      : Arr.some(results, Option.isNone)
        ? Option.none()
        : Option.some(!decisive);

  /**
   * SQL's three-valued reading — §6, written independently of the kit's fold —
   * with `compare` as the order of a value against a literal.
   */
  const threeValuedWith =
    (compare: (v: Scalar, x: Scalar) => number): Evaluator =>
    (node, row) => {
      const self = threeValuedWith(compare);
      const member = (values: ReadonlyArray<unknown>, v: Scalar) =>
        Arr.some(values, (value) => value === v);
      return Match.valueTags(node, {
        Compare: ({ op, field, value }) =>
          Option.map(valueIn(row, field), (v) => RELATIONS[op](compare(v, scalarOf(value)))),
        In: ({ field, values }) => Option.map(valueIn(row, field), (v) => member(values, v)),
        NotIn: ({ field, values }) => Option.map(valueIn(row, field), (v) => !member(values, v)),
        IsNull: ({ field, negated }) => Option.some(Option.isNone(valueIn(row, field)) !== negated),
        Not: ({ member }) => Option.map(self(member, row), (inner) => !inner),
        And: ({ members }) =>
          kleene(
            Arr.map(members, (member) => self(member, row)),
            false,
          ),
        Or: ({ members }) =>
          kleene(
            Arr.map(members, (member) => self(member, row)),
            true,
          ),
      });
    };

  const threeValued: Evaluator = threeValuedWith(order);

  /** A two-valued server: NULL is just a value no literal equals. */
  const twoValued: Evaluator = (node, row) => {
    const is = (field: string, literal: Filter.Compare["value"]): boolean =>
      Option.contains(valueIn(row, field), scalarOf(literal));
    const holds = (member: Filter.Node): boolean =>
      Option.getOrElse(twoValued(member, row), () => false);
    return Option.some(
      Match.valueTags(node, {
        Compare: ({ op, field, value }) =>
          op === "ne"
            ? !is(field, value)
            : op === "eq"
              ? is(field, value)
              : Option.contains(threeValued(node, row), true),
        In: ({ field, values }) => Arr.some(values, (value) => is(field, value)),
        NotIn: ({ field, values }) => !Arr.some(values, (value) => is(field, value)),
        IsNull: ({ field, negated }) => Option.isNone(valueIn(row, field)) !== negated,
        Not: ({ member }) => !holds(member),
        And: ({ members }) => Arr.every(members, holds),
        Or: ({ members }) => Arr.some(members, holds),
      }),
    );
  };

  /** Three-valued everywhere but `ne` on `colour`, which includes the NULL rows. */
  const twoValuedNe: Evaluator = (node, row) =>
    Predicate.isTagged(node, "Compare") && node.op === "ne" && node.field === "colour"
      ? twoValued(node, row)
      : threeValued(node, row);

  /** NULL sorted below every value, as JavaScript's `null < 1` has it. */
  const nullSmallest: Evaluator = (node, row) =>
    Predicate.isTagged(node, "Compare") &&
    isOrdering(node.op) &&
    Option.isNone(valueIn(row, node.field))
      ? Option.some(node.op === "lt" || node.op === "lte")
      : threeValued(node, row);

  /** Every value compared as text: `100 < 20`. */
  const textual: Evaluator = threeValuedWith((v, x) => order(String(v), String(x)));

  /** Three-valued on attributes, two-valued on the relationship: empty linkage is a value. */
  const twoValuedLinkage: Evaluator = (node, row) =>
    "field" in node && node.field === "maker" ? twoValued(node, row) : threeValued(node, row);

  const contentType = `${MEDIA_TYPE};profile="${Filter.PROFILE_URI}"`;

  /** A row with only the fields `fields[products]` names. */
  const project = (row: Product, names: ReadonlyArray<string>): Product => ({
    type: row.type,
    id: row.id,
    attributes: Rec.filter(row.attributes, (_, name) => Arr.contains(names, name)),
    relationships: Arr.contains(names, "maker") ? (row.relationships ?? {}) : {},
  });

  /** `rows` with only the fields a request's `fields[products]` names, if it names any. */
  const projectedBy =
    (query: URLSearchParams) =>
    (rows: ReadonlyArray<Product>): ReadonlyArray<Product> =>
      Option.match(Option.fromNullishOr(query.get("fields[products]")), {
        onNone: () => rows,
        onSome: (names) => Arr.map(rows, (row) => project(row, names.split(","))),
      });

  /** `rows` filtered by a request's `filter[…]` under `evaluate`; `None` when it does not decode. */
  const filteredBy = (
    query: URLSearchParams,
    evaluate: Evaluator,
    rows: ReadonlyArray<Product>,
  ): Option.Option<ReadonlyArray<Product>> => {
    const record = Rec.fromEntries(Arr.filter([...query], ([key]) => key.startsWith("filter")));
    return Rec.isEmptyRecord(record)
      ? Option.some(rows)
      : Option.map(decodeFilter(record), (node) =>
          Arr.filter(rows, (row) => Option.contains(evaluate(node, row), true)),
        );
  };

  /**
   * The makers a page's rows link to, for `include=maker`: none when
   * `filtered`, as a server applying the filter to `included` too answers —
   * a maker carries no field a filter names, so every comparison on it is
   * UNKNOWN.
   */
  const makersOf = (rows: ReadonlyArray<Product>, filtered: boolean) =>
    filtered
      ? []
      : Arr.map(
          Arr.dedupe(
            Arr.filterMap(rows, (row) =>
              Option.match(valueIn(row, "maker"), {
                onNone: () => Result.failVoid,
                onSome: (id) => Result.succeed(String(id)),
              }),
            ),
          ),
          (id) => ({ type: "makers", id }),
        );

  /**
   * One page of `rows`, by `page[number]`, with a `next` link while more
   * remain, and the makers they link to when `include=maker` asks.
   */
  const pageOf = (
    query: URLSearchParams,
    rows: ReadonlyArray<Product>,
    pageSize?: number,
    includedFiltered = false,
  ) => {
    const size = pageSize ?? rows.length;
    const page = Number(query.get("page[number]") ?? "0");
    const next = new URLSearchParams(query);
    next.set("page[number]", String(page + 1));
    const data = rows.slice(page * size, (page + 1) * size);
    return {
      jsonapi: { version: "1.1" },
      data,
      ...definedMember(
        "included",
        query.get("include") === "maker" ? makersOf(data, includedFiltered) : undefined,
      ),
      links: (page + 1) * size < rows.length ? { next: `/products?${next.toString()}` } : {},
    };
  };

  /** Whether a request carries a `filter[…]` key. */
  const filters = (query: URLSearchParams): boolean =>
    Arr.some([...query.keys()], (key) => key.startsWith("filter"));

  /**
   * A server for `rows` under `evaluate`: decodes `filter[…]` with the
   * package's codec (a 400 naming nothing in particular when it does not
   * decode), projects `fields[products]` — after filtering, or before when
   * `projectFirst` — and pages by `pageSize` through `links.next` when one is
   * given. The broken servers' other ways of getting §6.5 wrong: `rewrite`
   * rewrites every row a filtered request answers, `whenEmpty` replaces the
   * answer to a filtered request that matches nothing, and `includedFiltered`
   * applies the filter to `included` too.
   */
  const oracleServe =
    (
      evaluate: Evaluator,
      options: {
        readonly rows?: ReadonlyArray<Product>;
        readonly pageSize?: number;
        readonly contentType?: string;
        readonly projectFirst?: boolean;
        readonly rewrite?: (row: Product) => Product;
        readonly whenEmpty?: Canned;
        readonly includedFiltered?: boolean;
      } = {},
    ) =>
    (request: { readonly path: string }): Canned => {
      const query = queryOf(request);
      const projected = projectedBy(query);
      const first = options.projectFirst === true;
      const rows = options.rows ?? products;
      const filtered = filters(query);
      return Option.match(filteredBy(query, evaluate, first ? projected(rows) : rows), {
        onNone: () => badRequest(),
        onSome: (matched) =>
          filtered && Arr.isReadonlyArrayEmpty(matched) && options.whenEmpty !== undefined
            ? options.whenEmpty
            : {
                contentType: options.contentType ?? contentType,
                body: pageOf(
                  query,
                  Arr.map(first ? matched : projected(matched), (row) =>
                    filtered && options.rewrite !== undefined ? options.rewrite(row) : row,
                  ),
                  options.pageSize,
                  filtered && options.includedFiltered === true,
                ),
              },
      });
    };

  /** The rule alone, run against `serve` over `api`. */
  const verifyOracleOn = <ApiId extends string, Groups extends HttpApiGroup.Constraint>(
    api: HttpApi.HttpApi<ApiId, Groups>,
    serve: (request: { readonly path: string }) => Canned,
  ) =>
    Effect.runPromise(
      Conformance.verifyWith(api, {
        client: cannedClient(serve),
        baseUrl: "http://fixture.test",
        tiers: ["profile"],
        only: ["profile/filter/evaluation"],
      }),
    );

  const verifyOracle = (serve: (request: { readonly path: string }) => Canned) =>
    verifyOracleOn(oracleApi, serve);

  const RULE = "profile/filter/evaluation";

  const findingsOf = (report: Conformance.Report): ReadonlyArray<Conformance.Finding> => {
    const outcome = outcomeFor(report, RULE);
    return Predicate.isTagged(outcome, "Failed") ? outcome.findings : [];
  };

  const rulesOf = (report: Conformance.Report): ReadonlyArray<string> =>
    findingsOf(report).map((found) => found.detail.slice(0, found.detail.indexOf(":")));

  /** The trees a run sent, as the kit spelt them. */
  const sent = async (
    serve: (request: { readonly path: string }) => Canned,
  ): Promise<ReadonlyArray<string>> => {
    const paths: Array<string> = [];
    await verifyOracle((request) => {
      paths.push(decodeURIComponent(request.path));
      return serve(request);
    });
    return paths;
  };

  it("passes against a server that evaluates §6, having decided every case", async () => {
    const report = await verifyOracle(oracleServe(threeValued));
    // Two empty groups; ne, gte, lt, lte, gt, nin, isnull twice and excluded
    // middle on `colour`; lt, lte, gt, gte and isnull on `price`, never NULL;
    // eq, ne, nin and isnull twice on `maker`; the seven §6.5 corollary trees
    // on `colour` (#458); eq beside a fieldset; and eq beside `include`.
    expect(outcomeFor(report, RULE)).toMatchObject({ _tag: "Passed", probes: 30, note: undefined });
  });

  it("sends the ordering operators at a pivot that splits the sample", async () => {
    const paths = await sent(oracleServe(threeValued));
    // `colour`'s values in code-point order are blue, red, red: the pivot is red.
    // `price`'s are 5, 10, 20, 100: the pivot is 20, which text order misplaces.
    expect(paths).toEqual(
      expect.arrayContaining([
        "/products?filter[colour][lt]=red",
        "/products?filter[colour][gt]=red",
        "/products?filter[price][lt]=20",
        "/products?filter[price][lte]=20",
        "/products?filter[price][gt]=20",
        "/products?filter[price][gte]=20",
        "/products?filter[price][isnull]=true",
        "/products?filter[maker][eq]=m1",
        "/products?filter[maker][nin]=m1,m2",
        "/products?filter[colour][eq]=red&fields[products]=price",
        "/products?filter[colour][eq]=red&include=maker",
      ]),
    );
    // F-CONS-7: the same canonical form spelt a second way, each member's keys
    // before the group it names.
    expect(paths).toContainEqual(
      expect.stringMatching(
        /^\/products\?filter\[r4\]\[condition\]\[memberOf\]=r3&.*filter\[r0\]\[group\]\[conjunction\]=OR$/,
      ),
    );
    expect(paths.filter((path) => path.includes("[maker][lt"))).toEqual([]);
  });

  it("detects a server whose `ne` is two-valued, naming the NULL row it included", async () => {
    const report = await verifyOracle(oracleServe(twoValuedNe));
    expect(findingsOf(report)).toMatchObject([
      {
        detail: 'F-CMP-1: ne(colour, "red") on /products answered the wrong resources',
        expected: "1 resource of the 4 resources the collection serves unfiltered: products:2",
        observed: "wrongly included: products:3 (colour: null (NULL)); wrongly excluded: none",
        probe: { url: "/products?filter[colour][ne]=red" },
      },
    ]);
  });

  it("detects a two-valued server on every NULL case it gets wrong, and only those", async () => {
    const report = await verifyOracle(oracleServe(twoValued));
    expect(rulesOf(report)).toEqual([
      "F-CMP-1",
      "F-IN-2 / F-IN-3",
      "F-CONS-1",
      "F-EVAL-4 / F-ORD-5 / F-CMP-1",
      "F-EVAL-4 / F-ORD-5 / F-IN-2 / F-IN-3",
      // #458: De Morgan's `Not` over a group, `Not(In)`, and the respelled
      // De Morgan tree, each negating an UNKNOWN to TRUE.
      "F-CONS-2",
      "F-CONS-2",
      "F-CONS-3",
      "F-CONS-7",
    ]);
  });

  it("detects NULL sorted below every value on `lt` and `lte`, and on nothing else", async () => {
    const report = await verifyOracle(oracleServe(nullSmallest));
    expect(findingsOf(report)).toMatchObject([
      {
        detail:
          'F-CMP-1 / F-CMP-2 / F-ORD-1: lt(colour, "red") on /products answered the wrong resources',
        observed: "wrongly included: products:3 (colour: null (NULL)); wrongly excluded: none",
      },
      {
        detail:
          'F-CMP-1 / F-CMP-2 / F-ORD-1: lte(colour, "red") on /products answered the wrong resources',
      },
    ]);
  });

  it("detects numbers ordered as text on an attribute never NULL", async () => {
    const report = await verifyOracle(oracleServe(textual));
    expect(findingsOf(report)).toMatchObject([
      {
        detail: "F-CMP-2 / F-ORD-1: lt(price, 20) on /products answered the wrong resources",
        observed:
          "wrongly included: products:3 (price: 100); wrongly excluded: products:2 (price: 5)",
      },
      { detail: "F-CMP-2 / F-ORD-1: lte(price, 20) on /products answered the wrong resources" },
      { detail: "F-CMP-2 / F-ORD-1: gt(price, 20) on /products answered the wrong resources" },
      { detail: "F-CMP-2 / F-ORD-1: gte(price, 20) on /products answered the wrong resources" },
    ]);
  });

  it("detects empty linkage read as a value, naming the relationship's NULL", async () => {
    const report = await verifyOracle(oracleServe(twoValuedLinkage));
    expect(findingsOf(report)).toMatchObject([
      {
        detail:
          'F-EVAL-4 / F-ORD-5 / F-CMP-1: ne(maker, "m1") on /products answered the wrong resources',
        observed: "wrongly included: products:3 (maker: null (NULL)); wrongly excluded: none",
        probe: { url: "/products?filter[maker][ne]=m1" },
      },
      {
        detail:
          'F-EVAL-4 / F-ORD-5 / F-IN-2 / F-IN-3: NotIn(maker, ["m1", "m2"]) on /products answered the wrong resources',
      },
    ]);
  });

  it("detects a filter evaluated on the sparse representation (F-EVAL-6)", async () => {
    const report = await verifyOracle(oracleServe(threeValued, { projectFirst: true }));
    expect(findingsOf(report)).toMatchObject([
      {
        detail:
          'F-EVAL-6: eq(colour, "red") with fields[products]=price on /products answered the wrong resources',
        expected:
          "2 resources of the 4 resources the collection serves unfiltered: products:1, products:4",
        observed:
          'wrongly included: none; wrongly excluded: products:1 (colour: "red"), products:4 (colour: "red")',
      },
    ]);
  });

  it("detects `Or([])` read as no constraint", async () => {
    const report = await verifyOracle((request) =>
      oracleServe(threeValued)(
        // The one probe whose whole filter is a single OR group with no members.
        [...queryOf(request)].length === 1 &&
          queryOf(request).get("filter[n0][group][conjunction]") === "OR"
          ? { path: "/products" }
          : request,
      ),
    );
    expect(findingsOf(report)).toMatchObject([
      {
        detail: "F-AND-2: Or([]) on /products answered the wrong resources",
        observed:
          "wrongly included: products:1, products:2, products:3, products:4; wrongly excluded: none",
      },
    ]);
  });

  it("walks a paginated collection whole, filtered and unfiltered", async () => {
    expect(
      outcomeFor(await verifyOracle(oracleServe(threeValued, { pageSize: 1 })), RULE),
    ).toMatchObject({ _tag: "Passed", probes: 30 });
    const broken = await verifyOracle(oracleServe(twoValuedNe, { pageSize: 1 }));
    expect(rulesOf(broken)).toEqual(["F-CMP-1"]);
  });

  it("decides no NULL case when nothing is ever NULL, and says so", async () => {
    const report = await verifyOracle(
      oracleServe(twoValued, {
        rows: [
          product("1", { price: 10, name: "Widget", colour: "red" }, Option.some("m1")),
          product("2", { price: 5, name: "Gadget", colour: "blue" }, Option.some("m2")),
        ],
      }),
    );
    // The empty groups; the ordering operators on `price`; eq, ne and nin on
    // `maker`; the corollaries on `price`; eq beside a fieldset and beside
    // `include` — none of which a two-valued server gets wrong without a NULL
    // to get wrong.
    expect(outcomeFor(report, RULE)).toMatchObject({
      _tag: "Passed",
      probes: 19,
      note: expect.stringContaining(
        "the sample cannot tell three-valued evaluation from two-valued",
      ),
    });
  });

  it("says why a relationship or a fieldset was not probed", async () => {
    const Plain = Resource.make("products", {
      attributes: { colour: Resource.attribute(Schema.NullOr(Schema.String), { filter: true }) },
    });
    const plainApi = HttpApi.make("plain").add(
      Group.make(Plain, Endpoint.list(Plain, { filter: true })),
    );
    const report = await verifyOracleOn(
      plainApi,
      oracleServe(threeValued, {
        rows: Arr.map(products, ({ type, id, attributes }) => ({
          type,
          id,
          attributes: { colour: attributes["colour"] ?? null },
        })),
      }),
    );
    const outcome = outcomeFor(report, RULE);
    expect(outcome).toMatchObject({ _tag: "Passed" });
    expect(outcome).toMatchObject({
      note: expect.stringContaining(
        "F-EVAL-4 / F-ORD-5 on /products: no to-one relationship shows its linkage",
      ),
    });
    expect(outcome).toMatchObject({
      note: expect.stringContaining("F-EVAL-6 on /products: it declares no `fields[products]`"),
    });
    expect(outcome).toMatchObject({
      note: expect.stringContaining("F-CONS-6 on /products: it declares no `include`"),
    });
  });

  it("reads a relationship that shows no linkage as no field at all", async () => {
    const paths = await sent(
      oracleServe(threeValued, {
        rows: Arr.map(products, (row) => ({
          ...row,
          relationships: { maker: { links: { related: `/products/${row.id}/maker` } } },
        })),
      }),
    );
    expect(paths.filter((path) => path.includes("[maker]"))).toEqual([]);
  });

  /** `Not(And(…))` read as `And(Not(…), …)`: a negation pushed through a group without flipping it. */
  const pushedNot: Evaluator = (node, row) =>
    Predicate.isTagged(node, "Not") &&
    (Predicate.isTagged(node.member, "And") || Predicate.isTagged(node.member, "Or"))
      ? threeValued(
          {
            ...node.member,
            members: Arr.map(node.member.members, (member) => ({ _tag: "Not" as const, member })),
          },
          row,
        )
      : threeValued(node, row);

  /** `Not(In(…))` read as the complement of `in`'s matches, an UNKNOWN negated to TRUE. */
  const complementedIn: Evaluator = (node, row) =>
    Predicate.isTagged(node, "Not") && Predicate.isTagged(node.member, "In")
      ? Option.some(!Option.contains(threeValued(node.member, row), true))
      : threeValued(node, row);

  /** A negation flag set rather than toggled: `Not(Not(x))` read as `Not(x)`. */
  const flaggedNot: Evaluator = (node, row) =>
    Predicate.isTagged(node, "Not") && Predicate.isTagged(node.member, "Not")
      ? threeValued(node.member, row)
      : threeValued(node, row);

  it("detects De Morgan's law broken, on the two trees that negate a group (F-CONS-2)", async () => {
    const report = await verifyOracle(oracleServe(pushedNot));
    expect(findingsOf(report)).toMatchObject([
      {
        detail:
          'F-CONS-2: Not(And([eq(colour, "red"), IsNull(colour, negated: false)])) on /products answered the wrong resources',
        observed:
          'wrongly included: none; wrongly excluded: products:1 (colour: "red"), products:4 (colour: "red")',
      },
      {
        detail:
          'F-CONS-2: Not(Or([eq(colour, "red"), IsNull(colour, negated: false)])) on /products answered the wrong resources',
      },
    ]);
  });

  it("detects `Not(In)` answering otherwise than `nin` (F-CONS-3)", async () => {
    const report = await verifyOracle(oracleServe(complementedIn));
    expect(findingsOf(report)).toMatchObject([
      {
        detail:
          'F-CONS-3: Not(In(colour, ["red", "blue"])) on /products answered the wrong resources',
        observed: "wrongly included: products:3 (colour: null (NULL)); wrongly excluded: none",
      },
    ]);
  });

  it("detects a double negation answering otherwise than its member (F-CONS-4)", async () => {
    const report = await verifyOracle(oracleServe(flaggedNot));
    expect(rulesOf(report)).toEqual(["F-CONS-4"]);
  });

  it("detects a filtered answer that is not a collection document (F-CONS-5, F-ERR-2)", async () => {
    const notFound = await verifyOracle(
      oracleServe(threeValued, {
        whenEmpty: { status: 404, contentType, body: { errors: [{ status: "404" }] } },
      }),
    );
    // Every tree that matches nothing — `Or([])`, `gt(colour, "red")`,
    // `isnull=true` on `price`, never NULL, … — and only those.
    const empty = Arr.length(findingsOf(notFound));
    expect(empty).toBeGreaterThan(2);
    expect(rulesOf(notFound)).toEqual(Arr.makeBy(empty, () => "F-CONS-5 / F-ERR-2"));
    expect(findingsOf(notFound)[0]).toMatchObject({
      detail: "F-CONS-5 / F-ERR-2: Or([]) on /products did not answer a collection document",
      observed: expect.stringMatching(/^404 /),
    });
    expect(findingsOf(notFound).map(({ detail }) => detail)).toContainEqual(
      expect.stringContaining("IsNull(price, negated: false) on"),
    );
    const nulled = await verifyOracle(
      oracleServe(threeValued, { whenEmpty: { contentType, body: { data: null } } }),
    );
    expect(rulesOf(nulled)).toEqual(Arr.makeBy(empty, () => "F-CONS-5 / F-ERR-2"));
  });

  it("detects a filter changing the representation of the resources it answers (F-CONS-5)", async () => {
    const report = await verifyOracle(
      oracleServe(threeValued, {
        rewrite: (row) => ({
          ...row,
          relationships: { maker: { links: { related: `/products/${row.id}/maker` } } },
        }),
      }),
    );
    const found = findingsOf(report);
    expect(found.length).toBeGreaterThan(0);
    expect(rulesOf(report)).toEqual(found.map(() => "F-CONS-5"));
    expect(found[0]).toMatchObject({
      detail: "F-CONS-5: And([]) on /products changed the representation of resources it answered",
      observed: expect.stringMatching(/^changed: products:1 \(relationships\), /),
    });
  });

  it("detects a filter applied to `included` (F-CONS-6)", async () => {
    const report = await verifyOracle(oracleServe(threeValued, { includedFiltered: true }));
    expect(findingsOf(report)).toMatchObject([
      {
        detail:
          'F-CONS-6: eq(colour, "red") with include=maker on /products left out of `included` resources its primary data links to',
        observed: "missing from `included`: makers:m1",
      },
    ]);
  });

  it("detects one canonical form answered two ways (F-CONS-7)", async () => {
    // A server reading the group form in key order: a member whose `memberOf`
    // names a group it has not read yet is dropped.
    const inKeyOrder = (request: { readonly path: string }) => {
      const query = queryOf(request);
      const seen = new Set<string>();
      const dropped = new Set<string>();
      for (const [key, value] of query) {
        const [, id, kind, member] =
          /^filter\[([^\]]+)\]\[(group|condition)\]\[([^\]]+)\]$/.exec(key) ?? [];
        if (id === undefined) continue;
        if (kind === "group") seen.add(id);
        if (member === "memberOf" && !seen.has(value)) dropped.add(id);
      }
      const kept = Arr.filter(
        [...query],
        ([key]) => !Arr.some([...dropped], (id) => key.startsWith(`filter[${id}]`)),
      );
      return { path: `/products?${new URLSearchParams(kept).toString()}` };
    };
    const report = await verifyOracle((request) => oracleServe(threeValued)(inKeyOrder(request)));
    expect(findingsOf(report)).toMatchObject([
      {
        detail:
          'F-CONS-7: Or([Not(IsNull(colour, negated: false)), Not(eq(colour, "red"))]) respelled (group ids renamed, keys reversed) on /products answered the wrong resources',
        observed:
          'wrongly included: none; wrongly excluded: products:1 (colour: "red"), products:2 (colour: "blue"), products:4 (colour: "red")',
      },
    ]);
  });

  it("decides nothing a server refuses, and nothing for a server that has not negotiated the profile", async () => {
    const refusing = await verifyOracle((request) =>
      queryOf(request).toString().includes("filter")
        ? badRequest()
        : oracleServe(threeValued)(request),
    );
    expect(outcomeFor(refusing, RULE)).toMatchObject({ _tag: "Skipped" });

    const silent = await verifyOracle(oracleServe(twoValued, { contentType: MEDIA_TYPE }));
    expect(outcomeFor(silent, RULE)).toMatchObject({
      _tag: "Skipped",
      reason: expect.stringContaining("does not advertise the filter profile"),
    });
  });
});

// ---------------------------------------------------------------------------
// The write fixture
// ---------------------------------------------------------------------------

/**
 * The write rules skip against every api above — none has a write endpoint —
 * and against any target without a `writes` fixture. This is the api and the
 * canned server that make them run: create, update and delete endpoints, an
 * atomic operations endpoint, and a server whose writes land in a store the
 * fixture's `cleanup` removes from, so a test can see exactly what was left.
 */
describe("Conformance: the write fixture", () => {
  const writeApi = HttpApi.make("writes")
    .add(
      Group.make(
        Article,
        Endpoint.get(Article),
        Endpoint.create(Article),
        Endpoint.update(Article),
        Endpoint.delete(Article),
      ),
    )
    .add(Group.make("operations", Endpoint.operations([Article])));

  const verifyWrites = verifyOver(writeApi);

  const WRITE_RULES = [
    "spec/status/create-response-document",
    "spec/status/create-location",
    "spec/status/create-location-matches-self",
    "spec/status/update-response",
    "spec/status/delete-response",
    "spec/status/create-conflict-type",
    "spec/status/create-read-back",
    "spec/status/update-read-back",
    "spec/atomic/response-ext-parameter",
  ];

  /** The atomic rules that judge processing, which this fixture's `add`-only server cannot decide. */
  const ATOMIC_PROCESSING_RULES = [
    "spec/atomic/all-or-nothing",
    "spec/atomic/lid-resolution",
    "spec/atomic/results-order",
    "spec/atomic/remove-absent-succeeds",
  ];

  /**
   * The write rules that create a resource against a conformant server: all
   * but `create-conflict-type`, whose create such a server refuses with 409.
   */
  const CREATING_RULES = WRITE_RULES.filter((id) => id !== "spec/status/create-conflict-type");

  const atomicType = `${MEDIA_TYPE};ext="${ATOMIC_EXTENSION_URI}"`;

  const Attributes = Schema.Record(Schema.String, Schema.Unknown);
  type Attributes = typeof Attributes.Type;
  const NewArticle = Schema.Struct({
    type: Schema.Literal("articles"),
    attributes: Schema.optionalKey(Attributes),
  });
  const decodeCreate = Schema.decodeUnknownOption(Schema.Struct({ data: NewArticle }));
  /** A create whose resource object carries a `type` other than the one `/articles` serves. */
  const decodeForeignCreate = Schema.decodeUnknownOption(
    Schema.Struct({
      data: Schema.Struct({ type: Schema.String.check(Schema.isPattern(/^(?!articles$)/)) }),
    }),
  );
  const decodeOperations = Schema.decodeUnknownOption(
    Schema.Struct({
      "atomic:operations": Schema.Array(
        Schema.Struct({ op: Schema.Literal("add"), data: NewArticle }),
      ),
    }),
  );
  const decodeUpdate = Schema.decodeUnknownOption(
    Schema.Struct({
      data: Schema.Struct({
        type: Schema.Literal("articles"),
        id: Schema.String,
        attributes: Schema.optionalKey(Attributes),
      }),
    }),
  );

  type Store = MutableHashMap.MutableHashMap<string, Attributes>;

  const refusal = (status: number, title: string): Canned => ({
    status,
    body: { errors: [{ status: `${status}`, title }] },
  });

  const parameterised = (request: CannedRequest): boolean =>
    /;\s*(?!ext=|profile=)[a-z]+=/i.test(request.headers.get("content-type") ?? "");

  /**
   * A server that implements create / update / delete / `add` correctly, over
   * `store`. It refuses a body that is not a resource object it can apply with
   * a 400, as a real one would. `negotiates: false` drops its §Content
   * Negotiation check, so it applies whatever it can whatever the media type;
   * `reuseIds` hands out the next free id, so an id comes back once its
   * resource is gone — as a `size + 1` store or a SQLite rowid does.
   */
  const writeServer = (
    store: Store,
    options: { readonly negotiates?: boolean; readonly reuseIds?: boolean } = {},
  ) => {
    let next = 100;
    const resource = (id: string, attributes: Attributes) => ({
      type: "articles",
      id,
      attributes,
      links: { self: `/articles/${id}` },
    });
    const create = (attributes: Attributes) => {
      const id = options.reuseIds === true ? `${100 + MutableHashMap.size(store)}` : `${next++}`;
      MutableHashMap.set(store, id, attributes);
      return resource(id, attributes);
    };
    const onCreate = (request: CannedRequest): Canned =>
      Option.match(decodeCreate(request.body), {
        onNone: () =>
          Option.isSome(decodeForeignCreate(request.body))
            ? refusal(409, "Conflict")
            : refusal(400, "Bad Request"),
        onSome: ({ data }) => {
          const made = create(data.attributes ?? {});
          return { status: 201, headers: { location: made.links.self }, body: { data: made } };
        },
      });
    const onOperations = (request: CannedRequest): Canned =>
      Option.match(decodeOperations(request.body), {
        onNone: () => refusal(400, "Bad Request"),
        onSome: (body) => ({
          contentType: atomicType,
          body: {
            "atomic:results": body["atomic:operations"].map(({ data }) => ({
              data: create(data.attributes ?? {}),
            })),
          },
        }),
      });
    /** GET, PATCH and DELETE on a stored article; none for anything else. */
    const onStored = (request: CannedRequest): Option.Option<Canned> => {
      const id = /^\/articles\/([^/?]+)$/.exec(request.path)?.[1];
      if (id === undefined) return Option.none();
      const stored = MutableHashMap.get(store, id);
      if (Option.isNone(stored)) return Option.none();
      if (request.method === "GET")
        return Option.some({ body: { data: resource(id, stored.value) } });
      if (request.method === "PATCH")
        return Option.some(
          Option.match(decodeUpdate(request.body), {
            onNone: () => refusal(400, "Bad Request"),
            onSome: ({ data }) => {
              const attributes = { ...stored.value, ...data.attributes };
              MutableHashMap.set(store, id, attributes);
              return { body: { data: resource(id, attributes) } };
            },
          }),
        );
      if (request.method !== "DELETE") return Option.none();
      MutableHashMap.remove(store, id);
      return Option.some({ status: 204 });
    };
    return (request: CannedRequest): Canned => {
      // §Content Negotiation first: a parameterised JSON:API Content-Type is a
      // 415 before anything is written.
      if (options.negotiates !== false && parameterised(request))
        return refusal(415, "Unsupported Media Type");
      const route = `${request.method} ${request.path}`;
      if (route === "POST /articles") return onCreate(request);
      if (route === "POST /operations") return onOperations(request);
      // `writeApi` declares `include` and `fields[TYPE]` on no endpoint, so it
      // refuses either on every endpoint, as JSON:API requires (#278, #310).
      const refused = Arr.findFirst(
        [...queryOf(request).keys()],
        (key) => key === "include" || key.startsWith("fields["),
      );
      if (Option.isSome(refused)) return badRequest({ source: { parameter: refused.value } });
      return Option.getOrElse(onStored(request), () => conformantServe(request));
    };
  };

  let sequence = 0;
  /** The fixture over `store`, with every id `cleanup` is called with appended to `cleaned`. */
  const fixture = (store: Store, cleaned: Array<string>): Conformance.WriteFixture => ({
    create: () => ({
      type: "articles",
      attributes: { title: `probe ${++sequence}`, body: "" },
      relationships: { author: { data: { type: "people", id: "9" } } },
    }),
    update: () => ({ attributes: { title: `probe ${++sequence} (updated)` } }),
    cleanup: (id) =>
      Effect.sync(() => {
        cleaned.push(id);
        MutableHashMap.remove(store, id);
      }),
  });

  /**
   * A conformant run over a fresh store, with `change` applied to every
   * answer. `seen` is every request as `METHOD /path`, `cleaned` every id the
   * fixture's `cleanup` was called with. `server.client`, when given, wraps the
   * client the run sends through.
   */
  const run = async (
    change: (canned: Canned, request: CannedRequest) => Canned = (canned) => canned,
    options?: (store: Store, cleaned: Array<string>) => Conformance.Options,
    server: {
      readonly reuseIds?: boolean;
      readonly client?: (canned: HttpClient.HttpClient) => HttpClient.HttpClient;
    } = {},
  ) => {
    const store: Store = MutableHashMap.empty();
    const cleaned: Array<string> = [];
    const seen: Array<string> = [];
    const { client, ...served } = server;
    const serve = writeServer(store, served);
    const report = await verifyWrites(
      (request) => {
        seen.push(`${request.method} ${request.path}`);
        return change(serve(request), request);
      },
      {
        mutating: true,
        writes: { articles: fixture(store, cleaned) },
        ...options?.(store, cleaned),
      },
      client,
    );
    return { report, store, seen, cleaned, writes: report.writes ?? [] };
  };

  const disposals = (writes: ReadonlyArray<Conformance.Write>) =>
    writes.map((write) => write.disposal);

  const skippedFor = (reason: string) =>
    expect.objectContaining({ _tag: "Skipped", reason: expect.stringContaining(reason) });

  /** Every write rule's outcome: all of them `Passed`, or all `Skipped` naming `reason`. */
  const everyWriteRule = (report: Conformance.Report, reason?: string) =>
    expect(WRITE_RULES.map((id) => outcomeFor(report, id))).toEqual(
      WRITE_RULES.map(() =>
        reason === undefined ? expect.objectContaining({ _tag: "Passed" }) : skippedFor(reason),
      ),
    );

  /**
   * A transport in front of the server that answers every request outside
   * `/live` with a `status` redirect to `to(path)` — on the run's origin, or
   * not — and serves `/live/…` as the server serves `…`. `sent` is every URL
   * the kit sent.
   */
  const redirectingAll = (status: number, to: (path: string) => string) => {
    const sent: Array<string> = [];
    return {
      sent,
      client: (canned: HttpClient.HttpClient) =>
        HttpClient.make((request, url) => {
          sent.push(url.href);
          if (url.pathname.startsWith("/live/")) {
            return canned.execute(
              HttpClientRequest.setUrl(
                request,
                `${url.origin}${url.pathname.slice("/live".length)}${url.search}`,
              ),
            );
          }
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(null, {
                status,
                headers: { location: to(`${url.pathname}${url.search}`) },
              }),
            ),
          );
        }),
    };
  };

  /** Every outcome as the report gives it, less the request count a redirect adds to. */
  const verdicts = (report: Conformance.Report) =>
    report.outcomes.map((outcome) =>
      Predicate.isTagged(outcome, "Passed") || Predicate.isTagged(outcome, "Failed")
        ? { ...outcome, probes: 0 }
        : outcome,
    );

  it("grades a target that redirects every request within its origin as the URL that serves", async () => {
    const direct = await run();
    const redirected = redirectingAll(308, (path) => `/live${path}`);
    const { report } = await run(undefined, undefined, { client: redirected.client });
    expect(redirected.sent.some((url) => url.includes("/live/"))).toBe(true);
    expect(redirected.sent.every((url) => url.startsWith("http://fixture.test/"))).toBe(true);
    expect(verdicts(report)).toEqual(verdicts(direct.report));
  });

  it.each([
    ["another host", "https://elsewhere.test"],
    // A change of scheme is a change of origin, on the same host as much as any.
    ["the same host over https", "https://fixture.test"],
  ])(
    "reports a target that redirects every request to %s once, as unreachable, and decides nothing on it",
    async (_, origin) => {
      const redirected = redirectingAll(302, (path) => `${origin}${path}`);
      const { report } = await run(undefined, undefined, { client: redirected.client });
      expect(redirected.sent.filter((url) => !url.startsWith("http://fixture.test/"))).toEqual([]);
      expect(outcomeFor(report, "spec/target/reachable")).toEqual({
        _tag: "Failed",
        rule: expect.anything(),
        probes: 1,
        findings: [
          {
            rule: expect.anything(),
            detail:
              "every read endpoint the kit probed answered with a redirect it does not follow or read, so the rules that probe it have no answer to decide on — point `baseUrl` at the URL that serves the api",
            expected:
              "an answer from the base URL's origin, directly or through redirects that stay on it",
            observed: `/articles/1: a 302 redirect to ${origin}/articles/1, which the kit does not follow: ${origin} is another origin than the base URL's, http://fixture.test — the kit follows a redirect only within the base URL's origin, and a change of scheme or port is a change of origin`,
            probe: expect.anything(),
          },
        ],
      });
      // Nothing else is failed on answers the kit never read — no "was not
      // rejected" — and nothing passes on them either.
      expect(failed(report)).toEqual(["spec/target/reachable"]);
      expect(Conformance.summarise(report).passed).toBe(0);
      // A create the kit could not read is named by its redirect, not by a bare 0.
      expect(outcomeFor(report, "spec/status/create-response-document")).toMatchObject({
        _tag: "Skipped",
        reason: expect.stringContaining(
          `the server did not accept writes["articles"].create (a 302 redirect to ${origin}/articles,`,
        ),
      });
    },
  );

  it.each([
    [
      "a same-origin chain past the hop cap",
      redirectingAll(307, (path) => `/loop${path}`).client,
      "shorten the redirect chain to at most 5 hops, which the kit follows on the base URL's origin",
      "/articles/1: a 307 redirect to http://fixture.test/loop/loop/loop/loop/loop/loop/articles/1, which the kit does not follow: it would be redirect 6 in a row, past the kit's cap of 5",
    ],
    [
      "a transport that follows each redirect off the origin itself",
      followingOffsite(() => true),
      "hand the kit a client that does not follow redirects itself",
      `/articles/1: ${followed("/articles/1")}`,
    ],
    [
      "a transport that follows each redirect off the origin itself, failing there",
      followingOffsite(() => true, "refused"),
      "hand the kit a client that does not follow redirects itself",
      `/articles/1: ${refused("/articles/1")}`,
    ],
    [
      "a `Location` that does not parse",
      redirectingAll(302, () => "http://[").client,
      "fix the server's `Location`, which is not a URL the kit can resolve",
      "/articles/1: a 302 redirect to http://[, which the kit does not follow: its `Location` is not a URL the kit can resolve",
    ],
  ])(
    "tells the caller what to change for %s, not to move `baseUrl`, and decides nothing else",
    async (_, client, remedy, observed) => {
      const { report } = await run(undefined, undefined, { client });
      expect(outcomeFor(report, "spec/target/reachable")).toMatchObject({
        _tag: "Failed",
        findings: [
          {
            detail: `every read endpoint the kit probed answered with a redirect it does not follow or read, so the rules that probe it have no answer to decide on — ${remedy}`,
            observed,
          },
        ],
      });
      expect(failed(report)).toEqual(["spec/target/reachable"]);
      expect(Conformance.summarise(report).passed).toBe(0);
    },
  );

  /**
   * A transport in front of the server that answers each request `moved`
   * picks with a `302` to the same path on another origin, and passes the rest
   * to the server.
   */
  const redirectingSome =
    (moved: (request: HttpClientRequest.HttpClientRequest, url: URL) => boolean) =>
    (canned: HttpClient.HttpClient) =>
      HttpClient.make((request, url) =>
        moved(request, url)
          ? Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(null, {
                  status: 302,
                  headers: { location: `https://elsewhere.test${url.pathname}${url.search}` },
                }),
              ),
            )
          : canned.execute(request),
      );

  it("skips a rule some of whose requests were redirected off the origin, rather than passing it on the rest", async () => {
    // Only the DELETE leaves: the create before it was answered, the delete was not.
    const deletes = await run(undefined, undefined, {
      client: redirectingSome((request) => request.method === "DELETE"),
    });
    expect(outcomeFor(deletes.report, "spec/status/delete-response")).toMatchObject({
      _tag: "Skipped",
      reason: expect.stringMatching(
        /^not decided: 1 of 2 requests the rule sent were answered by a redirect the kit does not follow or read \(DELETE \/articles\/\d+ answered a 302 redirect to https:\/\/elsewhere\.test\/articles\/\d+, which the kit does not follow: .*\), and a rule is not passed on the answers it did read alone$/,
      ),
    });
    // Only the requests that carry a query leave: the baseline was answered,
    // the `include` probe was not. The rule itself decides nothing on an
    // answer it could not read (#352), and says so; `runRule` names the redirect.
    const queries = await run(undefined, undefined, {
      client: redirectingSome((_, url) => url.search !== ""),
    });
    expect(outcomeFor(queries.report, "spec/query/include-unsupported-endpoint")).toEqual({
      _tag: "Skipped",
      rule: expect.anything(),
      reason: `not decided: \`?include=author\` on /articles/1 answered ${offsite("/articles/1?include=author")}; 1 of 2 requests the rule sent were answered by a redirect the kit does not follow or read (GET /articles/1?include=author answered ${offsite("/articles/1?include=author")})`,
    });
  });

  it("still fails a rule on a finding from an answer it read, beside a request redirected off the origin", async () => {
    // The absent id's 404 is no error document; `?unknown=1` is redirected away.
    const { report } = await run(
      (canned, request) =>
        request.method === "GET" && canned.status === 404 && request.path.startsWith("/articles/")
          ? { ...canned, body: { errors: "not an array" } }
          : canned,
      undefined,
      { client: redirectingSome((_, url) => url.searchParams.has("unknown")) },
    );
    expect(outcomeFor(report, "spec/errors/error-document-shape")).toMatchObject({
      _tag: "Failed",
      findings: [
        {
          detail: "a 404 response was not a JSON:API error document",
          observed: expect.stringContaining('{"errors":"not an array"}'),
        },
      ],
    });
  });

  it("names the redirects in the reason of a rule that skipped on what it did read", async () => {
    // `?unknown=1` is the one probe whose error carries a `source`; with it
    // redirected away, the rule skips, and says the redirect is why.
    const { report } = await run(undefined, undefined, {
      client: redirectingSome((_, url) => url.searchParams.has("unknown")),
    });
    expect(outcomeFor(report, "spec/errors/error-source-discrimination")).toEqual({
      _tag: "Skipped",
      rule: expect.anything(),
      reason: `no provoked error object carried a \`source\` member; 1 of 3 requests the rule sent were answered by a redirect the kit does not follow or read (GET /articles/1?unknown=1 answered ${offsite("/articles/1?unknown=1")})`,
    });
  });

  /** Each rule's verdict, by id. */
  const tags = (report: Conformance.Report) =>
    report.outcomes.map((outcome) => `${outcome.rule.id}: ${outcome._tag}`);

  /** The requests a transport redirects off the origin, by what picks them. */
  const offsiteMoves = [
    [
      "only `?unknown=1`",
      (_: HttpClientRequest.HttpClientRequest, url: URL) => url.searchParams.has("unknown"),
    ],
    [
      "only the DELETE",
      (request: HttpClientRequest.HttpClientRequest) => request.method === "DELETE",
    ],
    // Every probe that carries a query — the unsupported-family and bracketed
    // probes among them — while each baseline is answered.
    [
      "every request with a query",
      (_: HttpClientRequest.HttpClientRequest, url: URL) => url.search !== "",
    ],
    ["only the POSTs", (request: HttpClientRequest.HttpClientRequest) => request.method === "POST"],
  ] as const;

  it.each(
    Arr.flatMap(offsiteMoves, ([which, moved]) =>
      Arr.map(["answered", "refused"] as const, (ends) => [which, ends, moved] as const),
    ),
  )(
    "decides nothing on a request a transport followed off the origin itself, when it redirects %s and the other origin %s",
    async (_, ends, moved) => {
      const kit = await run(undefined, undefined, { client: redirectingSome(moved) });
      const transport = await run(undefined, undefined, {
        client: followingOffsite(moved, ends),
      });
      // No rule fails on an answer from the other origin, or on its failing
      // there — no "was not rejected", no "got no response" — and none passes
      // on the rest of its requests: every rule ends as it does when the kit
      // sees the redirect.
      expect(failed(transport.report)).toEqual([]);
      expect(tags(transport.report)).toEqual(tags(kit.report));
    },
  );

  it("names a redirect the transport followed to another origin that failed there as such", async () => {
    const { report } = await run(undefined, undefined, {
      client: followingOffsite((_, url) => url.searchParams.has("unknown"), "refused"),
    });
    // The rule's baseline is read, so 1 of its 2 requests went unread (#438).
    expect(outcomeFor(report, "spec/query/unknown-query-parameter")).toEqual({
      _tag: "Skipped",
      rule: expect.anything(),
      reason: `not decided: \`?unknown=1\` on /articles/1 answered ${refused("/articles/1?unknown=1")}; 1 of 2 requests the rule sent were answered by a redirect the kit does not follow or read (GET /articles/1?unknown=1 answered ${refused("/articles/1?unknown=1")})`,
    });
  });

  /**
   * A transport in front of the server that answers each request `moved`
   * picks with a `status` redirect to the same path under `/moved`, on the
   * run's origin, serves `/moved/…` as the server serves `…`, and passes the
   * rest to the server; wrapped in `HttpClient.followRedirects` when `follows`.
   */
  const redirectingWithin =
    (
      status: number,
      moved: (request: HttpClientRequest.HttpClientRequest) => boolean,
      follows: boolean,
    ) =>
    (canned: HttpClient.HttpClient) => {
      const client = HttpClient.make((request, url) => {
        if (url.pathname.startsWith("/moved/")) {
          return canned.execute(
            HttpClientRequest.setUrl(
              request,
              `${url.origin}${url.pathname.slice("/moved".length)}${url.search}`,
            ),
          );
        }
        return moved(request)
          ? Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(null, {
                  status,
                  headers: { location: `/moved${url.pathname}${url.search}` },
                }),
              ),
            )
          : canned.execute(request);
      });
      return follows ? HttpClient.followRedirects(client) : client;
    };

  it.each([
    [303, "DELETE"],
    [303, "PATCH"],
    [302, "POST"],
    [301, "POST"],
  ] as const)(
    "does not read a %i a transport followed itself within the origin, turning a %s into a GET, as the answer to it",
    async (status, method) => {
      const moved = (request: HttpClientRequest.HttpClientRequest) => request.method === method;
      const kit = await run(undefined, undefined, {
        client: redirectingWithin(status, moved, false),
      });
      const transport = await run(undefined, undefined, {
        client: redirectingWithin(status, moved, true),
      });
      expect(failed(transport.report)).toEqual(failed(kit.report));
      expect(tags(transport.report)).toEqual(tags(kit.report));
      expect(
        transport.report.outcomes.some(
          (outcome) =>
            Predicate.isTagged(outcome, "Skipped") &&
            outcome.reason.includes(
              `a redirect the transport followed itself, ending at http://fixture.test/`,
            ) &&
            outcome.reason.includes(
              `the transport turned the ${method} into a GET on the way, which the kit does not send in its place`,
            ),
        ),
      ).toBe(true);
    },
  );

  it("still reads a redirect a transport followed itself within the origin, keeping the method", async () => {
    const moved = (request: HttpClientRequest.HttpClientRequest) => request.method === "DELETE";
    const direct = await run();
    const transport = await run(undefined, undefined, {
      client: redirectingWithin(307, moved, true),
    });
    expect(failed(transport.report)).toEqual([]);
    expect(tags(transport.report)).toEqual(tags(direct.report));
  });

  /**
   * A client that rewrites every request it is handed from the run's
   * `http://fixture.test` onto `http://127.0.0.1:4010` with
   * `HttpClient.mapRequest` — a `baseUrl` mapped onto a local port — in front
   * of `canned`. `sent` is every URL it sent on, `foreign` every URL it was
   * handed to rewrite that is not on the run's origin — a request the kit built
   * from one the client had already rewritten, which a rewrite that is not
   * idempotent would rewrite twice.
   */
  const rewritingOrigin = () => {
    const sent: Array<string> = [];
    const foreign: Array<string> = [];
    return {
      sent,
      foreign,
      rewrite: (client: HttpClient.HttpClient) =>
        HttpClient.mapRequest(client, (request) => {
          if (!request.url.startsWith("http://fixture.test/")) foreign.push(request.url);
          return HttpClientRequest.setUrl(
            request,
            request.url.replace("http://fixture.test", "http://127.0.0.1:4010"),
          );
        }),
      client: (canned: HttpClient.HttpClient) =>
        HttpClient.make((request, url) => {
          sent.push(url.href);
          return canned.execute(request);
        }),
    };
  };

  it("reads a client that rewrites every request onto another origin as the server it sends to (#359)", async () => {
    const direct = await run();
    const rewriting = rewritingOrigin();
    const { report } = await run(undefined, undefined, {
      client: (canned) => rewriting.rewrite(rewriting.client(canned)),
    });
    expect(rewriting.sent.length).toBeGreaterThan(0);
    expect(rewriting.sent.every((url) => url.startsWith("http://127.0.0.1:4010/"))).toBe(true);
    expect(outcomeFor(report, "spec/target/reachable")._tag).toBe("Passed");
    expect(failed(report)).toEqual([]);
    expect(verdicts(report)).toEqual(verdicts(direct.report));
  });

  it("still decides nothing on a client that rewrites every request onto another origin and follows each redirect off it itself", async () => {
    const rewriting = rewritingOrigin();
    const { report } = await run(undefined, undefined, {
      client: (canned) => rewriting.rewrite(followingOffsite(() => true)(canned)),
    });
    expect(outcomeFor(report, "spec/target/reachable")).toMatchObject({
      _tag: "Failed",
      findings: [
        {
          detail: expect.stringContaining(
            "hand the kit a client that does not follow redirects itself",
          ),
          observed: `/articles/1: a redirect the transport followed itself, ending at https://elsewhere.test/articles/1 with a 200, whose answer the kit does not read: https://elsewhere.test is another origin than the one the request was sent to, http://127.0.0.1:4010, and the transport has already tried the request there`,
        },
      ],
    });
    expect(failed(report)).toEqual(["spec/target/reachable"]);
    expect(Conformance.summarise(report).passed).toBe(0);
  });

  it("prepares each request once, as the client's own `execute` does", async () => {
    const rewriting = rewritingOrigin();
    let taps = 0;
    const { report } = await run(undefined, undefined, {
      client: (canned) =>
        HttpClient.tapRequest(rewriting.rewrite(rewriting.client(canned)), () =>
          Effect.sync(() => {
            taps += 1;
          }),
        ),
    });
    expect(rewriting.sent.length).toBeGreaterThan(0);
    expect(taps).toBe(rewriting.sent.length);
    expect(rewriting.foreign).toEqual([]);
    expect(failed(report)).toEqual([]);
  });

  it("follows an absolute `Location` on the origin a rewriting client sends to, through the client again", async () => {
    const direct = await run();
    const rewriting = rewritingOrigin();
    const redirected = redirectingAll(308, (path) => `http://127.0.0.1:4010/live${path}`);
    const { report } = await run(undefined, undefined, {
      client: (canned) => rewriting.rewrite(redirected.client(canned)),
    });
    expect(redirected.sent.some((url) => url.startsWith("http://127.0.0.1:4010/live/"))).toBe(true);
    expect(redirected.sent.every((url) => url.startsWith("http://127.0.0.1:4010/"))).toBe(true);
    // Each hop is a request the kit built on its own origin, rewritten once.
    expect(rewriting.foreign).toEqual([]);
    expect(verdicts(report)).toEqual(verdicts(direct.report));
  });

  /** A failure of the client's own request preparation, as a token refresh fails. */
  const unprepared = (request: HttpClientRequest.HttpClientRequest) =>
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ request, description: "no token" }),
    });

  it("reads a client whose request preparation fails as unreachable, not as a crash", async () => {
    const { report } = await run(undefined, undefined, {
      client: (canned) =>
        HttpClient.mapRequestEffect(canned, (request) => Effect.fail(unprepared(request))),
    });
    expect(outcomeFor(report, "spec/target/reachable")._tag).toBe("Failed");
    expect(report.outcomes.filter((outcome) => Predicate.isTagged(outcome, "Errored"))).toEqual([]);
  });

  /** A transport that fails every request it is handed, as a refused connection does. */
  const refusing = HttpClient.make((request) =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, description: "refused" }),
      }),
    ),
  );

  /** `spec/target/reachable`'s first finding's `observed`, or `""` when it has none. */
  const reachableObserved = (report: Conformance.Report): string => {
    const outcome = outcomeFor(report, "spec/target/reachable");
    return Predicate.isTagged(outcome, "Failed") ? (outcome.findings[0]?.observed ?? "") : "";
  };

  it("does not read a preparation that fails after the client's rewrite as a redirect the transport followed", async () => {
    const rewriting = rewritingOrigin();
    const { report } = await run(undefined, undefined, {
      client: (canned) =>
        HttpClient.mapRequestEffect(rewriting.rewrite(canned), (request) =>
          Effect.fail(unprepared(request)),
        ),
    });
    expect(reachableObserved(report)).toContain("no token");
    expect(reachableObserved(report)).not.toContain("followed itself");
  });

  it("reads each attempt of a client's own `retry` as prepared afresh, not as the last one that prepared", async () => {
    const rewriting = rewritingOrigin();
    // Attempt 1 is prepared and refused by the transport; attempt 2's
    // preparation fails, so it sent nothing.
    const preparedOnce = new WeakSet<HttpClientRequest.HttpClientRequest>();
    let refusedPreparations = 0;
    const { report } = await run(undefined, undefined, {
      client: () =>
        HttpClient.retry(
          rewriting.rewrite(
            HttpClient.mapRequestEffect(refusing, (request) => {
              if (!preparedOnce.has(request)) {
                preparedOnce.add(request);
                return Effect.succeed(request);
              }
              refusedPreparations += 1;
              return Effect.fail(unprepared(request));
            }),
          ),
          { times: 1 },
        ),
    });
    expect(refusedPreparations).toBeGreaterThan(0);
    expect(reachableObserved(report)).toContain("no token");
    expect(reachableObserved(report)).not.toContain("followed itself");
  });

  it("builds the client's preprocessing once per request, as its own `execute` does, however often it retries", async () => {
    let mapped = 0;
    let sent = 0;
    await run(undefined, undefined, {
      client: () =>
        HttpClient.retry(
          HttpClient.mapRequestInput(
            HttpClient.make((request) => {
              sent += 1;
              return refusing.execute(request);
            }),
            (request) => {
              mapped += 1;
              return request;
            },
          ),
          { times: 1 },
        ),
    });
    expect(mapped).toBeGreaterThan(0);
    expect(sent).toBe(2 * mapped);
  });

  // The rewritten origin is a scheme, host and port, not a host alone.
  it.each([
    ["another port", "http://127.0.0.1:4011"],
    ["https", "https://127.0.0.1:4010"],
  ])(
    "does not follow a `Location` on the host a rewriting client sends to over %s",
    async (_, origin) => {
      const rewriting = rewritingOrigin();
      const redirected = redirectingAll(308, (path) => `${origin}/live${path}`);
      const { report } = await run(undefined, undefined, {
        client: (canned) => rewriting.rewrite(redirected.client(canned)),
      });
      expect(redirected.sent.length).toBeGreaterThan(0);
      expect(redirected.sent.filter((url) => url.includes("/live/"))).toEqual([]);
      expect(reachableObserved(report)).toBe(
        `/articles/1: a 308 redirect to ${origin}/live/articles/1, which the kit does not follow: ${origin} is another origin than the base URL's, http://fixture.test — the kit follows a redirect only within the base URL's origin, and a change of scheme or port is a change of origin`,
      );
      expect(failed(report)).toEqual(["spec/target/reachable"]);
    },
  );

  it("does not read a `Location` with no origin as a path on the kit's, when the client rewrites onto a URL with none", async () => {
    const redirected = redirectingAll(308, (path) => `x-local://127.0.0.1:4010/live${path}`);
    const { report } = await run(undefined, undefined, {
      client: (canned) =>
        HttpClient.mapRequest(
          redirected.client(
            HttpClient.mapRequest(canned, (request) =>
              HttpClientRequest.setUrl(
                request,
                request.url.replace("x-local://127.0.0.1:4010", "http://fixture.test"),
              ),
            ),
          ),
          (request) =>
            HttpClientRequest.setUrl(
              request,
              request.url.replace("http://fixture.test", "x-local://127.0.0.1:4010"),
            ),
        ),
    });
    expect(redirected.sent.length).toBeGreaterThan(0);
    expect(redirected.sent.filter((url) => url.includes("/live/"))).toEqual([]);
    expect(reachableObserved(report)).toContain("a `x-local:` URL has no origin");
  });

  it("names a hop it refuses on a rewriting client's origin by the `Location` the server sent", async () => {
    const rewriting = rewritingOrigin();
    // Every request redirects to itself, past the hop cap.
    const redirected = redirectingAll(308, (path) => `http://127.0.0.1:4010${path}`);
    const { report } = await run(undefined, undefined, {
      client: (canned) => rewriting.rewrite(redirected.client(canned)),
    });
    expect(reachableObserved(report)).toMatch(
      /^\/articles\/1: a 308 redirect to http:\/\/127\.0\.0\.1:4010\/articles\/1, which the kit does not follow: it would be redirect 6 in a row/,
    );
  });

  // The timeout wraps the client's whole `execute`, so a `retry` runs within it
  // and the request still runs through the client exactly as before.
  it.each([
    ["", undefined],
    [", within a `requestTimeout`", "1 minute"],
  ] as const)(
    "lets a client retry a request whose preparation failed, as its own `execute` does%s",
    async (_, requestTimeout) => {
      const direct = await run();
      const failedOnce = new WeakSet<HttpClientRequest.HttpClientRequest>();
      let refused = 0;
      const { report } = await run(undefined, () => ({ requestTimeout }), {
        client: (canned) =>
          HttpClient.retry(
            HttpClient.mapRequestEffect(canned, (request) => {
              if (failedOnce.has(request)) return Effect.succeed(request);
              failedOnce.add(request);
              refused += 1;
              return Effect.fail(unprepared(request));
            }),
            { times: 1 },
          ),
      });
      expect(refused).toBeGreaterThan(0);
      expect(failed(report)).toEqual([]);
      expect(verdicts(report)).toEqual(verdicts(direct.report));
    },
  );

  it("names a redirect the transport followed off the origin in the rule it leaves undecided", async () => {
    const unknown = await run(undefined, undefined, {
      client: followingOffsite((_, url) => url.searchParams.has("unknown")),
    });
    expect(outcomeFor(unknown.report, "spec/query/unknown-query-parameter")).toEqual({
      _tag: "Skipped",
      rule: expect.anything(),
      reason: `not decided: \`?unknown=1\` on /articles/1 answered ${followed("/articles/1?unknown=1")}; 1 of 2 requests the rule sent were answered by a redirect the kit does not follow or read (GET /articles/1?unknown=1 answered ${followed("/articles/1?unknown=1")})`,
    });
    const errors = [
      "spec/errors/error-document-shape",
      "spec/errors/error-member-types",
      "spec/errors/error-status-matches-response",
    ];
    expect(Arr.map(errors, (id) => outcomeFor(unknown.report, id))).toEqual(
      Arr.map(errors, () =>
        expect.objectContaining({
          _tag: "Skipped",
          reason: expect.stringContaining(
            `1 of 3 requests the rule sent were answered by a redirect the kit does not follow or read (GET /articles/1?unknown=1 answered ${followed("/articles/1?unknown=1")})`,
          ),
        }),
      ),
    );
    const deletes = await run(undefined, undefined, {
      client: followingOffsite((request) => request.method === "DELETE"),
    });
    expect(outcomeFor(deletes.report, "spec/status/delete-response")).toMatchObject({
      _tag: "Skipped",
      reason: expect.stringMatching(
        /^not decided: 1 of 2 requests the rule sent were answered by a redirect the kit does not follow or read \(DELETE \/articles\/\d+ answered a redirect the transport followed itself, ending at https:\/\/elsewhere\.test\/articles\/\d+ with a 200, whose answer the kit does not read: .*\), and a rule is not passed on the answers it did read alone$/,
      ),
    });
    // The unsupported-family and bracketed probes: each rule's baseline was
    // answered, its probes were not, so none is passed on the baseline alone.
    const queries = await run(undefined, undefined, {
      client: followingOffsite((_, url) => url.search !== ""),
    });
    const probing = [
      "spec/query/include-unsupported-endpoint",
      "spec/query/fields-unsupported-endpoint",
      "spec/query/page-unsupported-endpoint",
      "spec/query/filter-unsupported-endpoint",
    ];
    expect(Arr.map(probing, (id) => outcomeFor(queries.report, id))).toEqual(
      Arr.map(probing, () =>
        expect.objectContaining({
          _tag: "Skipped",
          reason: expect.stringContaining("answered a redirect the transport followed itself"),
        }),
      ),
    );
  });

  it("runs every write rule against a conformant server, on targets it created", async () => {
    const { report, store, writes } = await run();
    expect(failed(report)).toEqual([]);
    everyWriteRule(report);
    // Every creation is on the record, and nothing outlived the run.
    expect(writes.map((write) => write.rule)).toEqual(CREATING_RULES);
    expect(disposals(writes)).toEqual([
      "cleaned-up",
      "cleaned-up",
      "cleaned-up",
      "cleaned-up",
      "deleted",
      "cleaned-up",
      "cleaned-up",
      "cleaned-up",
    ]);
    expect(MutableHashMap.size(store)).toBe(0);
  });

  it("never writes without `mutating: true`, even with a fixture", async () => {
    const { report, store, writes } = await run(undefined, () => ({ mutating: false }));
    everyWriteRule(report, "mutating: true");
    expect(writes).toEqual([]);
    expect(MutableHashMap.size(store)).toBe(0);
  });

  it("skips — never passes — a type with no fixture, naming the key it wanted", async () => {
    const { report } = await run(undefined, () => ({ writes: {} }));
    everyWriteRule(report, `writes["articles"].create`);
  });

  it("skips only the rules of an absent sub-key — a create-only fixture still creates", async () => {
    const { report, store } = await run(undefined, (store, cleaned) => {
      const { update: _update, ...createOnly } = fixture(store, cleaned);
      return { writes: { articles: createOnly } };
    });
    expect(outcomeFor(report, "spec/status/update-response")).toEqual(
      skippedFor(`writes["articles"].update`),
    );
    expect(outcomeFor(report, "spec/status/create-response-document")._tag).toBe("Passed");
    expect(outcomeFor(report, "spec/status/delete-response")._tag).toBe("Passed");
    expect(MutableHashMap.size(store)).toBe(0);
  });

  it("reports a payload the server rejects as not checked, never as a pass", async () => {
    const { report } = await run((canned, request) =>
      request.method === "POST" && request.path === "/articles"
        ? refusal(422, "Unprocessable")
        : canned,
    );
    expect(outcomeFor(report, "spec/status/create-response-document")).toEqual(
      skippedFor("did not accept"),
    );
  });

  it("cleans up after a rule that fails", async () => {
    const { report, store, writes } = await run((canned) => {
      const { location: _location, ...headers } = canned.headers ?? {};
      return { ...canned, headers };
    });
    expect(failed(report)).toEqual(["spec/status/create-location"]);
    expect(MutableHashMap.size(store)).toBe(0);
    expect(disposals(writes)).not.toContain("left");
  });

  class TransportFellOver extends Schema.TaggedError<TransportFellOver>()(
    "TransportFellOver",
    {},
  ) {}

  it("reports a rule that dies as Errored, and still reports every other rule and the writes", async () => {
    const { report, store, writes } = await run((canned, request) => {
      if (request.method === "PATCH") throw new TransportFellOver();
      return canned;
    });
    // The run is not lost: every rule is reported, in the suite's order.
    expect(report.outcomes.map((outcome) => outcome.rule.id)).toEqual(
      Conformance.rules.map((rule) => rule.id),
    );
    // Only the rules whose probe died — the two that PATCH — are Errored, and
    // each names the defect.
    const dying = ["spec/status/update-response", "spec/status/update-read-back"];
    const errored = report.outcomes.filter((outcome) => Predicate.isTagged(outcome, "Errored"));
    expect(errored.map((outcome) => outcome.rule.id)).toEqual(dying);
    expect(errored[0]).toMatchObject({ message: "TransportFellOver" });
    expect(Predicate.isTagged(errored[0], "Errored") && errored[0].defect).toBeInstanceOf(
      TransportFellOver,
    );
    // The rules after it still ran, the write rules among them.
    expect(failed(report)).toEqual([]);
    const survivors = WRITE_RULES.filter((id) => !dying.includes(id));
    expect(survivors.map((id) => outcomeFor(report, id)._tag)).toEqual(
      survivors.map(() => "Passed"),
    );
    // The ledger survives, the dead rule's creation included, and it was
    // cleaned up.
    expect(writes.map((write) => write.rule)).toEqual(CREATING_RULES);
    expect(disposals(writes)).not.toContain("left");
    expect(MutableHashMap.size(store)).toBe(0);
    expect(Conformance.summarise(report).errored).toBe(2);
    const text = Conformance.format(report);
    expect(text).toContain("DIED  spec/status/update-response");
    expect(text).toContain("DIED  spec/status/update-read-back");
    expect(text).toContain("not decided — the rule died: TransportFellOver");
  });

  class FixturesUnreadable extends Schema.TaggedError<FixturesUnreadable>()(
    "FixturesUnreadable",
    {},
  ) {}

  it("reports a rule that throws before its Effect starts as Errored, keeping the report", async () => {
    // Reading `writes["articles"]` throws. The write rules read it while
    // building their targets — before, not inside, the Effect their `run`
    // returns — standing in for any kit code that throws synchronously.
    const { report, store, writes } = await run(undefined, () => ({
      writes: {
        get articles(): Conformance.WriteFixture {
          throw new FixturesUnreadable();
        },
      },
    }));
    expect(report.outcomes.map((outcome) => outcome.rule.id)).toEqual(
      Conformance.rules.map((rule) => rule.id),
    );
    const errored = report.outcomes.filter((outcome) => Predicate.isTagged(outcome, "Errored"));
    // The atomic processing rules read the fixtures too; against this server,
    // whose operations endpoint applies only `add`, they otherwise skip (their
    // own fixture is under "Conformance: atomic operations processing"). So
    // do the client-generated id rules, which this fixture opts into none of
    // (theirs are under "Conformance: client-generated ids" and "…through
    // atomic operations").
    const reads = new Set([
      ...WRITE_RULES,
      ...ATOMIC_PROCESSING_RULES,
      ...CLIENT_ID_RULES,
      ...ATOMIC_CLIENT_ID_RULES,
    ]);
    const reading = Conformance.rules.map((rule) => rule.id).filter((id) => reads.has(id));
    expect(errored.map((outcome) => outcome.rule.id)).toEqual(reading);
    expect(errored.map((outcome) => outcome.message)).toEqual(
      reading.map(() => "FixturesUnreadable"),
    );
    // Every other rule still ran.
    expect(failed(report)).toEqual([]);
    expect(Conformance.summarise(report).passed).toBeGreaterThan(0);
    expect(writes).toEqual([]);
    expect(MutableHashMap.size(store)).toBe(0);
  });

  class TransportRefused extends Schema.TaggedError<TransportRefused>()("TransportRefused", {
    message: Schema.String,
  }) {}

  it.each([
    ["a string", "boom", "boom"],
    ["null", null, "null"],
    ["a number", 42, "42"],
    ["a plain object", { code: 7 }, `{"code":7}`],
    [
      "an error",
      new TransportRefused({ message: "connection refused" }),
      "TransportRefused: connection refused",
    ],
    // `name` is the error's own to set; a number still renders, through the template.
    [
      "an error named by a number",
      Object.assign(new TransportRefused({ message: "" }), { name: 42 }),
      "42",
    ],
    [
      "an error named by a number, with a message",
      Object.assign(new TransportRefused({ message: "refused" }), { name: 42 }),
      "42: refused",
    ],
  ])("renders %s a rule dies with as itself", async (_, defect, message) => {
    const { report } = await run(
      (canned, request) => {
        if (request.method === "PATCH") throw defect;
        return canned;
      },
      () => ({ only: ["spec/status/update-response"] }),
    );
    expect(report.outcomes).toEqual([
      expect.objectContaining({ _tag: "Errored", message, defect }),
    ]);
  });

  it("marks an error whose name cannot become a string as unrenderable", async () => {
    const defect = Object.assign(new TransportRefused({ message: "refused" }), {
      name: Symbol("odd"),
    });
    const { report } = await run(
      (canned, request) => {
        if (request.method === "PATCH") throw defect;
        return canned;
      },
      () => ({ only: ["spec/status/update-response"] }),
    );
    expect(report.outcomes).toEqual([
      expect.objectContaining({ _tag: "Errored", message: "[unrenderable defect]", defect }),
    ]);
  });

  /** A value every inspection of throws: `instanceof`, `String`, a property read. */
  const revoked = ((): object => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    return proxy;
  })();

  const onlyUpdate = { only: ["spec/status/update-response"] };

  it.each([
    [
      "thrown by the transport",
      () =>
        run(
          (canned, request) => {
            if (request.method === "PATCH") throw revoked;
            return canned;
          },
          () => onlyUpdate,
        ),
    ],
    [
      "died with by the transport",
      () =>
        run(undefined, () => onlyUpdate, {
          client: (client) =>
            HttpClient.make((request) =>
              request.method === "PATCH" ? Effect.die(revoked) : client.execute(request),
            ),
        }),
    ],
    [
      "thrown before the rule's Effect",
      () =>
        run(undefined, () => ({
          ...onlyUpdate,
          writes: {
            get articles(): Conformance.WriteFixture {
              throw revoked;
            },
          },
        })),
    ],
  ])("reports a defect no rendering can read, %s, as Errored", async (_, go) => {
    const { report, store } = await go();
    const [outcome] = report.outcomes;
    expect(report.outcomes.length).toBe(1);
    expect(outcome?._tag).toBe("Errored");
    expect(Predicate.isTagged(outcome, "Errored") && outcome.message).toBe("[unrenderable defect]");
    expect(Predicate.isTagged(outcome, "Errored") && Object.is(outcome.defect, revoked)).toBe(true);
    expect(Conformance.format(report)).toContain("the rule died: [unrenderable defect]");
    // What the dead rule created, if anything, was still removed.
    expect(MutableHashMap.size(store)).toBe(0);
  });

  it("caps the message of a defect too long for a report line", async () => {
    const { report } = await run(
      (canned, request) => {
        if (request.method === "PATCH") throw "x".repeat(10_000);
        return canned;
      },
      () => ({ only: ["spec/status/update-response"] }),
    );
    const [outcome] = report.outcomes;
    const message = Predicate.isTagged(outcome, "Errored") ? outcome.message : "";
    expect(message.length).toBe(500);
    expect(message).toBe(`${"x".repeat(499)}…`);
    // The defect itself is kept whole.
    expect(Predicate.isTagged(outcome, "Errored") && outcome.defect).toBe("x".repeat(10_000));
  });

  it("does not split a surrogate pair when it caps a message", async () => {
    const { report } = await run(
      (canned, request) => {
        if (request.method === "PATCH") throw `${"x".repeat(498)}😀${"x".repeat(100)}`;
        return canned;
      },
      () => ({ only: ["spec/status/update-response"] }),
    );
    const [outcome] = report.outcomes;
    expect(Predicate.isTagged(outcome, "Errored") && outcome.message).toBe(`${"x".repeat(498)}…`);
  });

  it("leaves a message at the cap as it is", async () => {
    const { report } = await run(
      (canned, request) => {
        if (request.method === "PATCH") throw "x".repeat(500);
        return canned;
      },
      () => ({ only: ["spec/status/update-response"] }),
    );
    const [outcome] = report.outcomes;
    expect(Predicate.isTagged(outcome, "Errored") && outcome.message).toBe("x".repeat(500));
  });

  it("stops at an external interrupt, cleaning up what the interrupted rule created", async () => {
    const store: Store = MutableHashMap.empty();
    const cleaned: Array<string> = [];
    const seen: Array<string> = [];
    const serve = cannedClient(writeServer(store));
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const patching = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkChild(
          Conformance.verifyWith(writeApi, {
            client: HttpClient.make((request, url) =>
              Effect.andThen(
                Effect.sync(() => seen.push(`${request.method} ${url.pathname}`)),
                // The update rule's PATCH never answers; the run is
                // interrupted from outside while it waits.
                request.method === "PATCH"
                  ? Effect.andThen(Deferred.succeed(patching, undefined), Effect.never)
                  : serve.execute(request),
              ),
            ),
            baseUrl: "http://fixture.test",
            ids: { articles: "1" },
            mutating: true,
            writes: { articles: fixture(store, cleaned) },
            // The PATCH must still be waiting when the interrupt comes.
            requestTimeout: "Infinity",
          }),
        );
        yield* Deferred.await(patching);
        yield* Fiber.interrupt(fiber);
        return yield* Fiber.join(fiber);
      }),
    );
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    // No rule started after the interrupted one: its PATCH was the last
    // request, so the delete and atomic write rules never ran. And the
    // resource it was patching — the one it created — was still removed.
    expect(seen.at(-1)).toBe(`PATCH /articles/${cleaned.at(-1)}`);
    expect(MutableHashMap.size(store)).toBe(0);
  });

  it("still propagates interruption, cleaning up what the interrupted rule created", async () => {
    const store: Store = MutableHashMap.empty();
    const cleaned: Array<string> = [];
    const serve = cannedClient(writeServer(store));
    const exit = await Effect.runPromiseExit(
      Conformance.verifyWith(writeApi, {
        client: HttpClient.make((request) =>
          request.method === "PATCH" ? Effect.interrupt : serve.execute(request),
        ),
        baseUrl: "http://fixture.test",
        ids: { articles: "1" },
        mutating: true,
        writes: { articles: fixture(store, cleaned) },
      }),
    );
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    // The resource the update rule created was still removed.
    expect(cleaned.length).toBeGreaterThan(0);
    expect(MutableHashMap.size(store)).toBe(0);
  });

  it("records a cleanup that fails, rather than aborting the run", async () => {
    const { report, store, writes } = await run(undefined, (store, cleaned) => ({
      writes: {
        articles: { ...fixture(store, cleaned), cleanup: () => Effect.fail("store offline") },
      },
    }));
    expect(failed(report)).toEqual([]);
    const stuck = writes.filter((write) => write.disposal === "cleanup-failed");
    // Every creation but the one the kit's own DELETE removed.
    expect(stuck.length).toBe(CREATING_RULES.length - 1);
    expect(stuck[0]?.detail).toContain("store offline");
    expect(MutableHashMap.size(store)).toBe(CREATING_RULES.length - 1);
    expect(Conformance.format(report)).toContain("CLEANUP FAILED");
  });

  class FixtureBroke extends Schema.TaggedError<FixtureBroke>()("FixtureBroke", {
    message: Schema.String,
  }) {}

  /** An error whose `message` getter throws: reading it, as `String` does, throws. */
  const messageThrows = Object.defineProperty(new FixtureBroke({ message: "" }), "message", {
    get: (): string => {
      throw new FixtureBroke({ message: "no message" });
    },
  });

  /** An error whose `name` getter throws: reading it, as the `Name: message` template does, throws. */
  const nameThrows = Object.defineProperty(new FixtureBroke({ message: "broke" }), "name", {
    get: (): string => {
      throw new FixtureBroke({ message: "no name" });
    },
  });

  /**
   * A `Proxy` every one of whose traps throws: unlike a revoked one, it is
   * live, but `instanceof`, a property read and `String` all throw on it.
   */
  const trapsThrow = new Proxy(
    {},
    new Proxy(
      {},
      {
        get: () => (): never => {
          throw new FixtureBroke({ message: "trap" });
        },
      },
    ),
  );

  /** An object `String` and a template literal both throw on. */
  const toStringThrows = {
    toString: (): never => {
      throw new FixtureBroke({ message: "no string" });
    },
  };

  /** What each value a fixture member throws or fails with renders as in the report. */
  const fixtureValues = [
    {
      value: "a tagged error",
      thrown: new FixtureBroke({ message: "fixture broke" }),
      rendered: "FixtureBroke: fixture broke",
    },
    // `__proto__` in a literal sets the prototype: `String` finds no `toString` on it.
    { value: "a null-prototype object", thrown: { __proto__: null }, rendered: "{}" },
    { value: "a revoked Proxy", thrown: revoked, rendered: "[unrenderable defect]" },
    { value: "a Proxy whose traps throw", thrown: trapsThrow, rendered: "[unrenderable defect]" },
    // Not unrenderable: `Formatter.format` catches the throw and says so itself.
    {
      value: "an object whose toString throws",
      thrown: toStringThrows,
      rendered: "[toString threw]",
    },
    {
      value: "an error whose name getter throws",
      thrown: nameThrows,
      rendered: "[unrenderable defect]",
    },
    {
      value: "an error whose message getter throws",
      thrown: messageThrows,
      rendered: "[unrenderable defect]",
    },
    // The `Name: message` template cannot turn this `name` into a string.
    {
      value: "an error named by an object whose toString throws",
      thrown: Object.assign(new FixtureBroke({ message: "broke" }), { name: toStringThrows }),
      rendered: "[unrenderable defect]",
    },
    {
      value: "an error named by a Symbol",
      thrown: Object.assign(new FixtureBroke({ message: "broke" }), { name: Symbol("odd") }),
      rendered: "[unrenderable defect]",
    },
  ];

  type Thrown = (typeof fixtureValues)[number]["thrown"];

  const throwing = (thrown: Thrown) => (): never => {
    throw thrown;
  };

  /** The fixture member that misbehaves, how, and what the run must make of it. */
  const fixtureMembers = [
    {
      member: "create",
      how: "throws",
      override: (thrown: Thrown): Partial<Conformance.WriteFixture> => ({
        create: throwing(thrown),
      }),
      expected: (
        report: Conformance.Report,
        writes: ReadonlyArray<Conformance.Write>,
        rendered: string,
      ) => {
        everyWriteRule(report, `writes["articles"].create threw: ${rendered}`);
        expect(writes).toEqual([]);
      },
    },
    {
      member: "update",
      how: "throws",
      override: (thrown: Thrown): Partial<Conformance.WriteFixture> => ({
        update: throwing(thrown),
      }),
      expected: (
        report: Conformance.Report,
        writes: ReadonlyArray<Conformance.Write>,
        rendered: string,
      ) => {
        const updating = ["spec/status/update-response", "spec/status/update-read-back"];
        expect(updating.map((id) => outcomeFor(report, id))).toEqual(
          updating.map(() => skippedFor(`writes["articles"].update threw: ${rendered}`)),
        );
        const others = WRITE_RULES.filter((id) => !updating.includes(id));
        expect(others.map((id) => outcomeFor(report, id)._tag)).toEqual(others.map(() => "Passed"));
        expect(disposals(writes)).not.toContain("left");
      },
    },
    {
      member: "cleanup",
      how: "throws",
      override: (thrown: Thrown): Partial<Conformance.WriteFixture> => ({
        cleanup: throwing(thrown),
      }),
      expected: (
        report: Conformance.Report,
        writes: ReadonlyArray<Conformance.Write>,
        rendered: string,
      ) => cleanupFailed(report, writes, rendered),
    },
    {
      member: "cleanup",
      how: "fails with",
      override: (thrown: Thrown): Partial<Conformance.WriteFixture> => ({
        cleanup: () => Effect.fail(thrown),
      }),
      expected: (
        report: Conformance.Report,
        writes: ReadonlyArray<Conformance.Write>,
        rendered: string,
      ) => cleanupFailed(report, writes, rendered),
    },
  ];

  /** Every write rule passed, and every creation but the one the kit's own DELETE removed is `cleanup-failed`, saying why. */
  const cleanupFailed = (
    report: Conformance.Report,
    writes: ReadonlyArray<Conformance.Write>,
    rendered: string,
  ) => {
    everyWriteRule(report);
    const stuck = writes.filter((write) => write.disposal === "cleanup-failed");
    expect(stuck.length).toBe(CREATING_RULES.length - 1);
    expect(stuck.map((write) => write.detail)).toEqual(stuck.map(() => rendered));
  };

  // A write fixture member that throws, or a `cleanup` that fails, is not a
  // defect — whatever the value, even one no rendering can read: no rule dies
  // of it.
  it.each(
    fixtureMembers.flatMap((member) => fixtureValues.map((value) => ({ ...member, ...value }))),
  )(
    "skips or records — never dies — when the fixture's $member $how $value",
    async ({ override, thrown, rendered, expected }) => {
      const { report, writes } = await run(undefined, (store, cleaned) => ({
        writes: { articles: { ...fixture(store, cleaned), ...override(thrown) } },
      }));
      expect(report.outcomes.filter((outcome) => Predicate.isTagged(outcome, "Errored"))).toEqual(
        [],
      );
      expect(failed(report)).toEqual([]);
      expected(report, writes, rendered);
    },
  );

  it("keeps a cleanup failure that spans lines inside its write's entry", async () => {
    const { report, writes } = await run(undefined, (store, cleaned) => ({
      writes: {
        articles: {
          ...fixture(store, cleaned),
          cleanup: () => Effect.fail(new FixtureBroke({ message: "a\nb" })),
        },
      },
    }));
    const [stuck] = writes.filter((write) => write.disposal === "cleanup-failed");
    expect(stuck?.detail).toBe("FixtureBroke: a\nb");
    // The second line hangs under the entry, as a rule's message does, rather
    // than starting at the margin where it would read as a line of its own.
    expect(Conformance.format(report)).toContain(
      `  articles:${stuck?.id}  CLEANUP FAILED — FixtureBroke: a\n      b\n      created by ${stuck?.rule}\n`,
    );
  });

  it("leaves what it created in place without a cleanup, and says so", async () => {
    const { report, store, writes } = await run(undefined, (store, cleaned) => {
      const { cleanup: _cleanup, ...noCleanup } = fixture(store, cleaned);
      return { writes: { articles: noCleanup } };
    });
    expect(failed(report)).toEqual([]);
    const left = writes.filter((write) => write.disposal === "left");
    expect(left.length).toBe(CREATING_RULES.length - 1);
    expect(left[0]?.detail).toContain(`writes["articles"].cleanup`);
    expect(MutableHashMap.size(store)).toBe(CREATING_RULES.length - 1);
    const text = Conformance.format(report);
    expect(text).toContain("WRITES");
    expect(text).toContain(`${CREATING_RULES.length - 1} still in place`);
    expect(text).toContain("LEFT IN PLACE");
    // What is still there is listed before what is gone.
    expect(text.indexOf("LEFT IN PLACE")).toBeLessThan(text.indexOf("deleted by the kit"));
  });

  // -------------------------------------------------------------------------
  // The kit refuses an id it evidently did not create
  // -------------------------------------------------------------------------

  /**
   * Every successful create answer names `type:id` instead of the resource the
   * server made — through `POST /articles` and through an atomic `add` alike.
   */
  const naming =
    (type: string, id: string) =>
    (canned: Canned, request: CannedRequest): Canned => {
      const named = { type, id, attributes: {} };
      if (request.method === "POST" && request.path === "/articles" && canned.status === 201)
        return { ...canned, body: { data: named } };
      if (request.method === "POST" && request.path === "/operations" && canned.status !== 400)
        return { ...canned, body: { "atomic:results": [{ data: named }] } };
      return canned;
    };

  /**
   * A create answer naming something the kit did not create: the kit must not
   * PATCH it, DELETE it or hand it to `cleanup`, and the record must say what
   * was named and that it was left alone.
   */
  const untouched = (name: string, type: string, id: string) =>
    it(name, async () => {
      const { report, seen, cleaned, writes } = await run(naming(type, id));
      expect(seen).not.toContain(`PATCH /articles/${id}`);
      expect(seen).not.toContain(`DELETE /articles/${id}`);
      expect(cleaned).not.toContain(id);
      expect(writes).toEqual(
        CREATING_RULES.map(() =>
          expect.objectContaining({
            id: undefined,
            disposal: "left",
            detail: expect.stringMatching(new RegExp(`\`${type}:${id}\`.*not touched`)),
          }),
        ),
      );
      // The rules that act on the created resource decide nothing on it.
      expect(outcomeFor(report, "spec/status/update-response")).toEqual(skippedFor("not touched"));
      expect(outcomeFor(report, "spec/status/delete-response")).toEqual(skippedFor("not touched"));
    });

  untouched("does not act on a created resource of another type", "people", "9");
  untouched("does not act on the `ids` sample a create answer names", "articles", "1");

  // `encodeURIComponent` leaves `.` alone and a URL's dot segments are
  // resolved before it is sent, so these ids would put the kit's PATCH and
  // DELETE on `/` or on the collection rather than on anything it created. A
  // lone surrogate (`"\ud800"` in the JSON) cannot be percent-encoded at all:
  // `encodeURIComponent` throws on it.
  it.each(["..", ".", "", "\uD800"])(
    "does not act on the id %j, which is no path segment of its own",
    async (id) => {
      const { report, seen, cleaned, writes } = await run(naming("articles", id));
      expect(seen.filter((request) => /^(PATCH|DELETE) /.test(request))).toEqual([]);
      expect(cleaned).toEqual([]);
      expect(writes).toEqual(
        CREATING_RULES.map(() =>
          expect.objectContaining({
            id: undefined,
            disposal: "left",
            detail: expect.stringContaining(
              `\`articles:${id}\`, which is not a URL path segment of its own`,
            ),
          }),
        ),
      );
      expect(outcomeFor(report, "spec/status/update-response")).toEqual(skippedFor("not touched"));
      expect(outcomeFor(report, "spec/status/delete-response")).toEqual(skippedFor("not touched"));
    },
  );

  /** A read's document: its primary data, and what it includes. */
  interface Shown {
    readonly data: object;
    readonly included?: ReadonlyArray<object>;
  }

  /** Every successful read of the `ids` sample answers `body`, and every create answer names articles:7. */
  const showing =
    (body: Shown, status = 200) =>
    (canned: Canned, request: CannedRequest) =>
      request.method === "GET" &&
      request.path.startsWith("/articles/1") &&
      canned.status === undefined
        ? { status, body }
        : naming("articles", "7")(canned, request);

  const sample = { type: "articles", id: "1", attributes: {} };
  const seven = { type: "articles", id: "7" };

  // A read shows a resource as primary data, as an included resource, or as a
  // relationship's linkage — to-one or to-many — and any of them is a resource
  // the server held before the kit created anything.
  it.each([
    ["as primary data", { data: { ...seven, attributes: {} } }],
    ["only as an included resource", { data: sample, included: [{ ...seven, attributes: {} }] }],
    [
      "only as to-one linkage",
      { data: { ...sample, relationships: { related: { data: seven } } } },
    ],
    [
      "only as to-many linkage",
      { data: { ...sample, relationships: { related: { data: [seven] } } } },
    ],
  ])("does not act on an id a read earlier in the run returned %s", async (_, body) => {
    const { seen, cleaned, writes } = await run(showing(body));
    expect(seen.filter((request) => /^(PATCH|DELETE) /.test(request))).toEqual([]);
    expect(cleaned).toEqual([]);
    expect(writes).toEqual(
      CREATING_RULES.map(() =>
        expect.objectContaining({
          id: undefined,
          disposal: "left",
          detail: expect.stringContaining("`articles:7`, which the kit did not create (a read"),
        }),
      ),
    );
  });

  it("does not count what an unsuccessful read carries as shown", async () => {
    // A 404 is no evidence the server holds articles:7, so the first create
    // naming it is taken at its word.
    const { writes } = await run(showing({ data: { ...seven, attributes: {} } }, 404));
    expect(writes[0]).toEqual(expect.objectContaining({ id: "7", detail: undefined }));
  });

  it("runs every rule that creates nothing, the profile tier's included, before it creates anything", async () => {
    // A create is vetted against what the run's reads have shown so far, so a
    // read after the first create could not inform it. A read-back of what the
    // kit itself created is exempt: it shows nothing the kit did not make.
    const log: Array<{ readonly request: string; readonly status: number }> = [];
    const { report, writes } = await run((canned, request) => {
      log.push({ request: `${request.method} ${request.path}`, status: canned.status ?? 200 });
      return canned;
    });
    // …whatever order the requests went in, the report keeps the suite's.
    expect(report.outcomes.map((outcome) => outcome.rule.id)).toEqual(
      Conformance.rules.map((rule) => rule.id),
    );
    const created = writes.map((write) => `GET /articles/${write.id}`);
    const firstCreate = log.findIndex(
      ({ request, status }) =>
        /^POST \/(articles|operations)$/.test(request) && status >= 200 && status < 300,
    );
    const lastRead = log.findLastIndex(
      ({ request }) => request.startsWith("GET ") && !created.includes(request.split("?")[0] ?? ""),
    );
    expect(firstCreate).toBeGreaterThan(0);
    expect(lastRead).toBeGreaterThan(0);
    expect(lastRead).toBeLessThan(firstCreate);
    // A selection that interleaves rules that create with rules that do not
    // is reported in the suite's order too.
    const only = ["spec/status/", "spec/atomic/", "profile/"];
    const { report: selection } = await run(undefined, () => ({ only }));
    expect(selection.outcomes.map((outcome) => outcome.rule.id)).toEqual(
      Conformance.rules
        .filter((rule) => only.some((prefix) => rule.id.startsWith(prefix)))
        .map((rule) => rule.id),
    );
  });

  it("does not act on an id it already holds a live record for", async () => {
    // Every create answer names articles:500, and cleanup fails — so after the
    // first create, articles:500 is on the record as still in place.
    const { seen, cleaned, writes } = await run(naming("articles", "500"), (store, cleaned) => ({
      writes: {
        articles: {
          ...fixture(store, cleaned),
          cleanup: (id) =>
            Effect.sync(() => cleaned.push(id)).pipe(Effect.andThen(Effect.fail("store offline"))),
        },
      },
    }));
    expect(cleaned).toEqual(["500"]);
    expect(seen).not.toContain("PATCH /articles/500");
    expect(seen).not.toContain("DELETE /articles/500");
    expect(writes.map((write) => [write.id, write.disposal])).toEqual([
      ["500", "cleanup-failed"],
      ...CREATING_RULES.slice(1).map(() => [undefined, "left"]),
    ]);
    expect(writes[1]?.detail).toMatch(/`articles:500`.*not touched/);
  });

  it("accepts an id the server reuses once the kit has removed its first holder", async () => {
    const { report, store, writes } = await run(undefined, undefined, { reuseIds: true });
    expect(failed(report)).toEqual([]);
    expect(writes.map((write) => write.id)).toEqual(CREATING_RULES.map(() => "100"));
    expect(disposals(writes)).not.toContain("left");
    expect(MutableHashMap.size(store)).toBe(0);
  });

  it("passes a 200 update with no primary data — JSON:API 1.1 allows it when nothing else changed", async () => {
    const { report } = await run((canned, request) =>
      request.method === "PATCH" && canned.status === undefined
        ? { body: { meta: { updated: true } } }
        : canned,
    );
    expect(outcomeFor(report, "spec/status/update-response")._tag).toBe("Passed");
    expect(failed(report)).toEqual([]);
  });

  it("sends the parameterised Content-Type probe a body nothing can apply, to the create endpoint", async () => {
    // A server that skips §Content Negotiation and applies any resource object
    // it is sent: the rule fails it, and it has had nothing to apply.
    const store: Store = MutableHashMap.empty();
    const serve = writeServer(store, { negotiates: false });
    const probes: Array<CannedRequest> = [];
    const report = await verifyWrites(
      (request) => {
        if (parameterised(request)) probes.push(request);
        return serve(request);
      },
      { only: ["spec/content-negotiation/request-content-type-parameters"] },
    );
    expect(failed(report)).toEqual(["spec/content-negotiation/request-content-type-parameters"]);
    expect(probes.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: "POST", path: "/articles", body: {} },
    ]);
    expect(MutableHashMap.size(store)).toBe(0);
  });

  /** The parameterised Content-Type probes a run of `target` sends, as `METHOD /path`. */
  const contentTypeProbes = async <ApiId extends string, Groups extends HttpApiGroup.Constraint>(
    target: HttpApi.HttpApi<ApiId, Groups>,
  ) => {
    const serve = writeServer(MutableHashMap.empty());
    const probes: Array<string> = [];
    await verifyOver(target)(
      (request) => {
        if (parameterised(request)) probes.push(`${request.method} ${request.path}`);
        return serve(request);
      },
      { only: ["spec/content-negotiation/request-content-type-parameters"] },
    );
    return probes;
  };

  it("sends the parameterised Content-Type probe to the create endpoint even when it is discovered last", async () => {
    const createLast = HttpApi.make("createLast").add(
      Group.make(
        Article,
        Endpoint.updateRelationship(Article, "author"),
        Endpoint.update(Article),
        Endpoint.create(Article),
      ),
    );
    expect(await contentTypeProbes(createLast)).toEqual(["POST /articles"]);
  });

  it("without a create endpoint, sends the parameterised Content-Type probe to an update before a relationship write", async () => {
    const noCreate = HttpApi.make("noCreate").add(
      Group.make(Article, Endpoint.updateRelationship(Article, "author"), Endpoint.update(Article)),
    );
    expect(await contentTypeProbes(noCreate)).toEqual(["PATCH /articles/1"]);
  });

  // -------------------------------------------------------------------------
  // One deliberate defect at a time
  // -------------------------------------------------------------------------

  /** One deliberate defect, and the kit must report exactly that rule. */
  const brokenWrite = (
    name: string,
    id: string,
    change: (canned: Canned, request: CannedRequest) => Canned,
    leaves = 0,
    sent: RegExp = /POST|PATCH|DELETE/,
  ) =>
    it(name, async () => {
      const { report, store, writes } = await run(change);
      expect(failed(report)).toEqual([id]);
      const outcome = outcomeFor(report, id);
      const findings = Predicate.isTagged(outcome, "Failed") ? outcome.findings : [];
      // Each finding says what it wanted, what it got, and which write it sent.
      expect(
        findings.map((found) => ({
          expected: found.expected !== "",
          observed: found.observed !== "",
          method: found.probe?.method,
        })),
      ).toEqual(
        findings.map(() => ({
          expected: true,
          observed: true,
          method: expect.stringMatching(sent),
        })),
      );
      expect(findings).not.toEqual([]);
      expect(MutableHashMap.size(store)).toBe(leaves);
      // …and whatever is left is on the record as left.
      expect(writes.filter((write) => write.disposal === "left").length).toBe(leaves);
    });

  /** A successful `POST /articles` — not the 415 the negotiation rule provokes. */
  const creates = (request: CannedRequest, canned: Canned) =>
    request.method === "POST" && request.path === "/articles" && canned.status === 201;

  brokenWrite(
    "a creation answered 200 instead of 201",
    "spec/status/create-response-document",
    (canned, request) => (creates(request, canned) ? { ...canned, status: 200 } : canned),
  );

  // A 201 that does not say what it created cannot be cleaned up after: each
  // of the seven create-endpoint rules that the server lets create leaves its
  // resource behind, and the report says so rather than pretending otherwise.
  brokenWrite(
    "a 201 whose primary data is not the created resource",
    "spec/status/create-response-document",
    (canned, request) =>
      creates(request, canned) ? { ...canned, body: { meta: { ok: true } } } : canned,
    7,
  );

  brokenWrite(
    "a 201 without a Location header",
    "spec/status/create-location",
    (canned, request) => (creates(request, canned) ? { ...canned, headers: {} } : canned),
  );

  brokenWrite(
    "a Location that disagrees with the created resource's self link",
    "spec/status/create-location-matches-self",
    (canned, request) =>
      creates(request, canned)
        ? { ...canned, headers: { location: "/articles/elsewhere" } }
        : canned,
  );

  brokenWrite(
    "an update answered with a different resource",
    "spec/status/update-response",
    (canned, request) =>
      request.method === "PATCH"
        ? { body: { data: { type: "articles", id: "someone-else", attributes: {} } } }
        : canned,
  );

  brokenWrite(
    "an update answered 200 with no document at all",
    "spec/status/update-response",
    (canned, request) => (request.method === "PATCH" ? { status: 200 } : canned),
  );

  brokenWrite(
    "an update answered 200 with an empty document",
    "spec/status/update-response",
    (canned, request) => (request.method === "PATCH" ? { body: {} } : canned),
  );

  brokenWrite(
    "an update answered 200 with an error document",
    "spec/status/update-response",
    (canned, request) =>
      request.method === "PATCH"
        ? { body: { errors: [{ status: "200", title: "Updated" }] } }
        : canned,
  );

  brokenWrite(
    "an update answered 200 with `meta` and an error document",
    "spec/status/update-response",
    (canned, request) =>
      request.method === "PATCH"
        ? { body: { meta: { updated: true }, errors: [{ status: "200", title: "Updated" }] } }
        : canned,
  );

  brokenWrite(
    "an update answered 200 with a null `meta` and no primary data",
    "spec/status/update-response",
    (canned, request) => (request.method === "PATCH" ? { body: { meta: null } } : canned),
  );

  it.each([
    [{}, "carries neither primary data nor a top-level `meta`"],
    [{ errors: [{ title: "Updated" }] }, "carries `errors`"],
    [{ meta: { updated: true }, errors: [{ title: "Updated" }] }, "carries `errors`"],
    [{ meta: null }, "a top-level `meta` that is not an object"],
    [{ meta: [] }, "a top-level `meta` that is not an object"],
  ])("says what is wrong with the 200 update document %j", async (body, detail) => {
    const { report } = await run((canned, request) =>
      request.method === "PATCH" ? { body } : canned,
    );
    const outcome = outcomeFor(report, "spec/status/update-response");
    const findings = Predicate.isTagged(outcome, "Failed") ? outcome.findings : [];
    expect(findings.map((found) => found.detail)).toEqual([expect.stringContaining(detail)]);
  });

  brokenWrite(
    "an update answered 200 with null primary data",
    "spec/status/update-response",
    (canned, request) => (request.method === "PATCH" ? { body: { data: null } } : canned),
  );

  brokenWrite(
    "a 200 DELETE carrying primary data",
    "spec/status/delete-response",
    (canned, request) =>
      request.method === "DELETE" && canned.status === 204
        ? { status: 200, body: { data: null } }
        : canned,
  );

  brokenWrite(
    // What `Endpoint.create` answered before #428: a foreign type failed its
    // `data.type` literal, a 400.
    "a create of a type the endpoint does not serve answered 400, not 409",
    "spec/status/create-conflict-type",
    (canned, request) =>
      request.method === "POST" && canned.status === 409 ? refusal(400, "Bad Request") : canned,
  );

  brokenWrite(
    "a 201 carrying an attribute the resource does not read back with",
    "spec/status/create-read-back",
    (canned, request) =>
      creates(request, canned)
        ? withData(canned, (body) => {
            const data = body["data"] as Record<string, unknown>;
            const attributes = data["attributes"] as Record<string, unknown>;
            return { ...body, data: { ...data, attributes: { ...attributes, rating: 5 } } };
          })
        : canned,
    0,
    /GET/,
  );

  brokenWrite(
    "a 200 update carrying a title other than the one it stored",
    "spec/status/update-read-back",
    (canned, request) =>
      request.method === "PATCH" && canned.status === undefined
        ? withData(canned, (body) => {
            const data = body["data"] as Record<string, unknown>;
            const attributes = data["attributes"] as Record<string, unknown>;
            return { ...body, data: { ...data, attributes: { ...attributes, title: "unstored" } } };
          })
        : canned,
    0,
    /GET/,
  );

  {
    // A 204 says the server changed nothing beyond the request, so the
    // request is what must read back; here a later read shows another title.
    const patched = new Set<string>();
    brokenWrite(
      "a 204 update whose request does not read back",
      "spec/status/update-read-back",
      (canned, request) => {
        const id = /^\/articles\/(\d+)$/.exec(request.path)?.[1];
        if (id === undefined) return canned;
        if (request.method === "PATCH" && canned.status === undefined) {
          patched.add(id);
          return { status: 204 };
        }
        return request.method === "GET" && patched.has(id)
          ? withData(canned, (body) => {
              const data = body["data"] as Record<string, unknown>;
              return { ...body, data: { ...data, attributes: { title: "unstored" } } };
            })
          : canned;
      },
      0,
      /GET/,
    );
  }

  it("passes a 204 update whose request reads back, and a 201 that reads back as answered", async () => {
    const { report } = await run((canned, request) =>
      request.method === "PATCH" && canned.status === undefined ? { status: 204 } : canned,
    );
    expect(failed(report)).toEqual([]);
    expect(
      ["spec/status/create-read-back", "spec/status/update-read-back"].map(
        (id) => outcomeFor(report, id)._tag,
      ),
    ).toEqual(["Passed", "Passed"]);
  });

  it("reports a created resource that does not read back at all", async () => {
    const { report } = await run((canned, request) =>
      request.method === "GET" && /^\/articles\/\d{3}$/.test(request.path)
        ? refusal(404, "Not Found")
        : canned,
    );
    expect(failed(report)).toEqual([
      "spec/status/create-read-back",
      "spec/status/update-read-back",
    ]);
    const outcome = outcomeFor(report, "spec/status/create-read-back");
    const findings = Predicate.isTagged(outcome, "Failed") ? outcome.findings : [];
    expect(findings.map((found) => found.detail)).toEqual([
      expect.stringMatching(
        /^articles:\d+, which the 201 creating it answered, does not read back/,
      ),
    ]);
  });

  it("decides nothing on a read-back the server cannot answer", async () => {
    const { report } = await run((canned, request) =>
      request.method === "GET" && /^\/articles\/\d{3}$/.test(request.path)
        ? refusal(503, "Unavailable")
        : canned,
    );
    expect(failed(report)).toEqual([]);
    expect(outcomeFor(report, "spec/status/create-read-back")).toEqual(skippedFor("answered 503"));
  });

  it("disposes of what a server that accepts a create of a type it does not serve made", async () => {
    const { report, store, writes } = await run((canned, request) => {
      if (request.method !== "POST" || canned.status !== 409) return canned;
      // As if the server ignored `type`: it makes an article of the payload.
      const made = { type: "articles", id: "900", attributes: {} };
      return { status: 201, body: { data: made } };
    });
    expect(failed(report)).toEqual(["spec/status/create-conflict-type"]);
    expect(writes.find((write) => write.rule === "spec/status/create-conflict-type")).toEqual(
      expect.objectContaining({ id: "900", disposal: "cleaned-up" }),
    );
    expect(MutableHashMap.size(store)).toBe(0);
  });

  brokenWrite(
    "an atomic response without the extension's media type",
    "spec/atomic/response-ext-parameter",
    (canned, request) =>
      request.path === "/operations" && (canned.status ?? 200) === 200
        ? { ...canned, contentType: MEDIA_TYPE }
        : canned,
  );
});
// ---------------------------------------------------------------------------
// Atomic operations processing (#164)
// ---------------------------------------------------------------------------

/**
 * The atomic rules that judge processing — `lid` resolution, all-or-nothing
 * and the order of `atomic:results` — against a canned server that processes
 * `add`, `update` and `remove` over a store of articles and people, inside a
 * draft it commits only when every operation succeeds. Each fault breaks one
 * thing a real server gets wrong, and the rule that judges it must catch it
 * by what the store holds afterwards, not by the answer alone.
 */
describe("Conformance: atomic operations processing", () => {
  const atomicApi = HttpApi.make("atomic")
    .add(Group.make(Article, Endpoint.get(Article), Endpoint.list(Article)))
    .add(Group.make(Person, Endpoint.get(Person), Endpoint.list(Person)))
    .add(Group.make("operations", Endpoint.operations([Article, Person])));

  const atomicType = `${MEDIA_TYPE};ext="${ATOMIC_EXTENSION_URI}"`;

  type Fields = Readonly<Record<string, unknown>>;
  interface Stored {
    readonly type: string;
    readonly id: string;
    readonly attributes: Fields;
    readonly relationships: Fields;
  }
  /** What the server holds: every resource, keyed `type:id`, replaced as a whole on each commit. */
  interface Store {
    current: HashMap.HashMap<string, Stored>;
  }

  interface Faults {
    /** Commits the operations before the one that fails, rather than none of them. */
    readonly appliesOnFailure?: boolean;
    /** Resolves every `lid` to the type's seed resource, not the one its `add` created. */
    readonly misresolvesLid?: boolean;
    /** Answers a reference to a `lid` no operation assigned by skipping that operation. */
    readonly ignoresAbsentLid?: boolean;
    /** Refuses a failed request with a bare 422, carrying no error document. */
    readonly bareRefusal?: boolean;
    /** Answers `atomic:results` in reverse order. */
    readonly reversesResults?: boolean;
    /** Answers one result fewer than there were operations. */
    readonly dropsResult?: boolean;
    /** Has someone else create a person, with attributes of their own, while a request fails. */
    readonly bystander?: boolean;
  }

  const keyOf = (type: string, id: string) => `${type}:${id}`;

  const SEEDS: ReadonlyArray<Stored> = [
    {
      type: "people",
      id: "9",
      attributes: { firstName: "Dan", lastName: "Gebhardt" },
      relationships: {},
    },
    ...Arr.map(["1", "2", "3"], (id) => ({
      type: "articles",
      id,
      attributes: { title: `seed ${id}`, body: "" },
      relationships: { author: { data: { type: "people", id: "9" } } },
    })),
  ];

  const seeded = (): Store => ({
    current: HashMap.fromIterable(Arr.map(SEEDS, (seed) => [keyOf(seed.type, seed.id), seed])),
  });

  /** Every resource `store` holds beyond the seeds, as `type:id`. */
  const leftovers = (store: Store): ReadonlyArray<string> =>
    Arr.filter(
      Arr.fromIterable(HashMap.keys(store.current)),
      (key) => !Arr.some(SEEDS, (seed) => keyOf(seed.type, seed.id) === key),
    );

  const resource = ({ type, id, attributes, relationships }: Stored) => ({
    type,
    id,
    attributes,
    relationships,
    links: { self: `/${type}/${id}` },
  });

  const Ref = Schema.Struct({
    type: Schema.String,
    id: Schema.optionalKey(Schema.String),
    lid: Schema.optionalKey(Schema.String),
  });
  type Ref = typeof Ref.Type;
  const Linkage = Schema.Struct({ data: Schema.Union([Schema.Null, Ref, Schema.Array(Ref)]) });
  const Operation = Schema.Struct({
    op: Schema.Literals(["add", "update", "remove"]),
    data: Schema.optionalKey(
      Schema.Struct({
        type: Schema.String,
        id: Schema.optionalKey(Schema.String),
        lid: Schema.optionalKey(Schema.String),
        attributes: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
        relationships: Schema.optionalKey(Schema.Record(Schema.String, Linkage)),
      }),
    ),
    ref: Schema.optionalKey(Ref),
  });
  type Operation = typeof Operation.Type;
  const decodeOperations = Schema.decodeUnknownOption(
    Schema.Struct({ "atomic:operations": Schema.Array(Operation) }),
  );

  /** A request's progress through its operations: what it has made of the store, its `lid`s and its results. */
  interface Draft {
    readonly store: HashMap.HashMap<string, Stored>;
    readonly lids: HashMap.HashMap<string, Ref>;
    readonly results: ReadonlyArray<Fields>;
  }

  /**
   * Applies `operations` in order to `store`, answering the draft they made, or
   * the draft as the first failing one left it and why it failed.
   */
  const apply = (
    store: HashMap.HashMap<string, Stored>,
    operations: ReadonlyArray<Operation>,
    faults: Faults,
    next: () => string,
  ): Result.Result<Draft, readonly [Draft, string]> => {
    const resolve = (draft: Draft, ref: Ref): Result.Result<string, string> => {
      if (ref.id !== undefined) return Result.succeed(ref.id);
      if (faults.misresolvesLid === true)
        return Result.fromOption(
          Option.map(
            Arr.findFirst(SEEDS, (seed) => seed.type === ref.type),
            (seed) => seed.id,
          ),
          () => `no ${ref.type}`,
        );
      return Result.fromOption(
        Option.filter(HashMap.get(draft.lids, ref.lid ?? ""), (named) => named.type === ref.type),
        () => `no lid "${ref.lid ?? ""}"`,
      ).pipe(Result.map((named) => named.id ?? ""));
    };
    const relink = (
      draft: Draft,
      relationships: Readonly<Record<string, typeof Linkage.Type>>,
    ): Result.Result<Fields, string> => {
      const one = (ref: Ref) =>
        Result.map(resolve(draft, ref), (id): Ref => ({ type: ref.type, id }));
      return Result.all(
        Rec.map(relationships, ({ data }) => {
          if (data === null) return Result.succeed({ data });
          if ("type" in data) return Result.map(one(data), (linked) => ({ data: linked }));
          return Result.map(Result.all(Arr.map(data, one)), (linked) => ({ data: linked }));
        }),
      );
    };
    const stored = (draft: Draft, ref: Ref): Result.Result<Stored, string> =>
      Result.flatMap(resolve(draft, ref), (id) =>
        Result.fromOption(
          HashMap.get(draft.store, keyOf(ref.type, id)),
          () => `no ${ref.type}:${id}`,
        ),
      );
    /** `draft` with `made` as its store, `result` appended and, when given, `lids` as its lids. */
    const answered = (
      draft: Draft,
      made: HashMap.HashMap<string, Stored>,
      result: Fields,
      lids = draft.lids,
    ): Draft => ({ store: made, lids, results: [...draft.results, result] });
    type Data = NonNullable<Operation["data"]>;
    const remove = (draft: Draft, ref: Ref): Result.Result<Draft, string> => {
      const absent = ref.lid !== undefined && !HashMap.has(draft.lids, ref.lid);
      if (absent && faults.ignoresAbsentLid === true)
        return Result.succeed(answered(draft, draft.store, {}));
      return Result.map(stored(draft, ref), (gone) =>
        answered(draft, HashMap.remove(draft.store, keyOf(gone.type, gone.id)), {}),
      );
    };
    const add = (draft: Draft, data: Data): Result.Result<Draft, string> =>
      Result.map(relink(draft, data.relationships ?? {}), (relationships) => {
        const made: Stored = {
          type: data.type,
          id: next(),
          attributes: data.attributes ?? {},
          relationships,
        };
        const lids =
          data.lid === undefined
            ? draft.lids
            : HashMap.set(draft.lids, data.lid, { type: made.type, id: made.id });
        return answered(
          draft,
          HashMap.set(draft.store, keyOf(made.type, made.id), made),
          { data: resource(made) },
          lids,
        );
      });
    const update = (draft: Draft, ref: Ref, data: Data): Result.Result<Draft, string> =>
      Result.flatMap(stored(draft, ref), (before) =>
        Result.map(relink(draft, data.relationships ?? {}), (relationships) => {
          const after: Stored = {
            ...before,
            attributes: { ...before.attributes, ...data.attributes },
            relationships: { ...before.relationships, ...relationships },
          };
          return answered(draft, HashMap.set(draft.store, keyOf(after.type, after.id), after), {
            data: resource(after),
          });
        }),
      );
    const step = (draft: Draft, operation: Operation): Result.Result<Draft, string> => {
      const data = operation.data;
      if (operation.op === "remove") return remove(draft, operation.ref ?? { type: "" });
      if (data === undefined) return Result.fail("no data");
      return operation.op === "add" ? add(draft, data) : update(draft, operation.ref ?? data, data);
    };
    const start: Result.Result<Draft, readonly [Draft, string]> = Result.succeed({
      store,
      lids: HashMap.empty(),
      results: [],
    });
    return Arr.reduce(operations, start, (progress, operation) =>
      Result.flatMap(progress, (draft) =>
        Result.mapError(step(draft, operation), (why) => [draft, why] as const),
      ),
    );
  };

  /** The page size the collections are listed at, so a listing takes more than one page. */
  const PAGE = 2;

  const atomicServer = (store: Store, faults: Faults = {}) => {
    let counter = 100;
    const next = () => `${counter++}`;
    const onOperations = (request: CannedRequest): Canned =>
      Option.match(decodeOperations(request.body), {
        onNone: () => ({ status: 400, body: { errors: [{ status: "400" }] } }),
        onSome: (body) =>
          Result.match(apply(store.current, body["atomic:operations"], faults, next), {
            onSuccess: ({ store: made, results }) => {
              store.current = made;
              const ordered = faults.reversesResults === true ? Arr.reverse(results) : results;
              return {
                contentType: atomicType,
                body: {
                  "atomic:results": faults.dropsResult === true ? ordered.slice(1) : ordered,
                },
              };
            },
            onFailure: ([partial, why]) => {
              if (faults.appliesOnFailure === true) store.current = partial.store;
              if (faults.bystander === true) {
                const id = next();
                store.current = HashMap.set(store.current, keyOf("people", id), {
                  type: "people",
                  id,
                  attributes: { firstName: "Someone", lastName: "Else" },
                  relationships: {},
                });
              }
              return faults.bareRefusal === true
                ? { status: 422 }
                : { status: 422, body: { errors: [{ status: "422", detail: why }] } };
            },
          }),
      });
    const onList = (type: string, request: CannedRequest): Canned => {
      const offset = Number(queryOf(request).get("offset") ?? "0");
      const all = Arr.filter(
        Arr.fromIterable(HashMap.values(store.current)),
        (held) => held.type === type,
      );
      return {
        body: {
          data: Arr.map(all.slice(offset, offset + PAGE), resource),
          links: {
            self: `/${type}?offset=${offset}`,
            next: offset + PAGE < all.length ? `/${type}?offset=${offset + PAGE}` : null,
          },
        },
      };
    };
    return (request: CannedRequest): Canned => {
      const path = withoutQuery(request).path;
      if (request.method === "POST" && path === "/operations") return onOperations(request);
      if (request.method !== "GET") return { status: 405 };
      const listed = /^\/(articles|people)$/.exec(path)?.[1];
      if (listed !== undefined) return onList(listed, request);
      const [, type = "", id = ""] = /^\/(articles|people)\/([^/]+)$/.exec(path) ?? [];
      return Option.match(HashMap.get(store.current, keyOf(type, id)), {
        onNone: () => ({ status: 404, body: { errors: [{ status: "404" }] } }),
        onSome: (held) => ({ body: { data: resource(held) } }),
      });
    };
  };

  let sequence = 0;
  /** A fixture per type over `store`; `cleanup` records each `type:id` it removes in `cleaned`. */
  const fixtures = (
    store: Store,
    cleaned: Array<string>,
  ): Readonly<Record<"articles" | "people", Conformance.WriteFixture>> => {
    const cleanup = (type: string) => (id: string) =>
      Effect.sync(() => {
        cleaned.push(`${type}:${id}`);
        store.current = HashMap.remove(store.current, keyOf(type, id));
      });
    return {
      articles: {
        create: () => ({
          type: "articles",
          attributes: { title: `atomic probe ${++sequence}`, body: "" },
          relationships: { author: { data: { type: "people", id: "9" } } },
        }),
        update: () => ({ attributes: { title: `atomic probe ${++sequence} (updated)` } }),
        cleanup: cleanup("articles"),
      },
      people: {
        create: () => ({
          type: "people",
          attributes: { firstName: `Probe ${++sequence}`, lastName: "Atomic" },
        }),
        cleanup: cleanup("people"),
      },
    };
  };

  const runAtomic = async (
    only: string,
    faults: Faults = {},
    writes: (
      all: ReturnType<typeof fixtures>,
    ) => Readonly<Record<string, Conformance.WriteFixture>> = (all) => all,
  ) => {
    const store = seeded();
    const cleaned: Array<string> = [];
    const report = await verifyOver(atomicApi)(atomicServer(store, faults), {
      only: [only],
      mutating: true,
      writes: writes(fixtures(store, cleaned)),
    });
    return { outcome: outcomeFor(report, only), store, cleaned, writes: report.writes ?? [] };
  };

  const findingsOf = (outcome: Conformance.Outcome) =>
    Predicate.isTagged(outcome, "Failed") ? outcome.findings : [];

  describe("against a conformant server", () => {
    it.each([
      "spec/atomic/lid-resolution",
      "spec/atomic/all-or-nothing",
      "spec/atomic/results-order",
    ])("%s passes, and the store ends as it began", async (id) => {
      const { outcome, store, writes } = await runAtomic(id);
      expect(outcome._tag).toBe("Passed");
      expect(leftovers(store)).toEqual([]);
      expect(writes.map((write) => write.disposal)).toEqual(
        writes.map(() => expect.stringMatching(/^(deleted|cleaned-up)$/)),
      );
    });

    it("resolves a lid through linkage and through an update, reading both resources back", async () => {
      const { outcome, writes } = await runAtomic("spec/atomic/lid-resolution");
      // The linkage probe creates a person and an article; the update probe an article.
      expect(writes.map((write) => `${write.type} ${write.disposal}`)).toEqual([
        "people cleaned-up",
        "articles cleaned-up",
        "articles cleaned-up",
      ]);
      // The people fixture has no update and links to nothing, which the note names.
      expect(outcome).toMatchObject({
        _tag: "Passed",
        note: expect.stringContaining('writes["people"] has no update'),
      });
    });

    it("disposes of the linking resource before the one it links to", async () => {
      const { cleaned } = await runAtomic("spec/atomic/lid-resolution");
      expect(cleaned.slice(0, 2)).toEqual(["articles:101", "people:100"]);
    });

    it("records the results-order probe's resource as deleted by its own `remove`", async () => {
      const { writes, cleaned } = await runAtomic("spec/atomic/results-order");
      expect(writes.filter((write) => write.type === "articles")).toEqual([
        expect.objectContaining({ rule: "spec/atomic/results-order", disposal: "deleted" }),
      ]);
      expect(cleaned.filter((id) => id.startsWith("articles:"))).toEqual([]);
    });

    it("runs lid-resolution through an update alone when no fixture links to another", async () => {
      const { outcome } = await runAtomic("spec/atomic/lid-resolution", {}, ({ articles }) => ({
        articles,
      }));
      expect(outcome._tag).toBe("Passed");
    });

    it("skips lid-resolution, naming what is missing, with neither an update nor a link", async () => {
      const { outcome } = await runAtomic("spec/atomic/lid-resolution", {}, ({ people }) => ({
        people,
      }));
      expect(outcome).toMatchObject({
        _tag: "Skipped",
        reason: expect.stringContaining('pass writes["people"].update'),
      });
    });

    it("leaves a bystander's resource alone: it does not carry the fixture's attributes", async () => {
      const { outcome, store, cleaned } = await runAtomic("spec/atomic/all-or-nothing", {
        bystander: true,
      });
      expect(outcome._tag).toBe("Passed");
      expect(leftovers(store)).toHaveLength(2);
      expect(cleaned).toEqual([]);
    });
  });

  describe("detects a server that", () => {
    it("resolves a lid to some other resource", async () => {
      const { outcome, store } = await runAtomic("spec/atomic/lid-resolution", {
        misresolvesLid: true,
      });
      expect(outcome._tag).toBe("Failed");
      const observed = findingsOf(outcome).map((finding) => finding.observed);
      // The article links to the seed person, not the one the request created…
      expect(observed).toContainEqual(expect.stringContaining("relationships.author.data"));
      // …and the update patched the seed article, not the one the request created.
      expect(observed).toContainEqual(expect.stringContaining("attributes.title"));
      expect(leftovers(store)).toEqual([]);
    });

    it("applies the operations before the one that fails, and has what it left cleaned up", async () => {
      const { outcome, store, writes } = await runAtomic("spec/atomic/all-or-nothing", {
        appliesOnFailure: true,
      });
      expect(outcome._tag).toBe("Failed");
      expect(findingsOf(outcome)).toEqual([
        expect.objectContaining({
          detail: expect.stringMatching(
            /yet its `add` was applied: (articles|people):\d+ appeared/,
          ),
        }),
        expect.objectContaining({
          detail: expect.stringMatching(
            /yet its `add` was applied: (articles|people):\d+ appeared/,
          ),
        }),
      ]);
      expect(leftovers(store)).toEqual([]);
      expect(writes.map((write) => `${write.rule} ${write.disposal}`)).toEqual([
        "spec/atomic/all-or-nothing cleaned-up",
        "spec/atomic/all-or-nothing cleaned-up",
      ]);
    });

    it("refuses a failed request without an error document", async () => {
      const { outcome } = await runAtomic("spec/atomic/all-or-nothing", { bareRefusal: true });
      expect(findingsOf(outcome).map((finding) => finding.detail)).toEqual([
        expect.stringContaining("was refused without an error document"),
        expect.stringContaining("was refused without an error document"),
      ]);
    });

    it.each([
      ["answers its results in reverse order", { reversesResults: true }, "out of order"],
      [
        "answers one result short",
        { dropsResult: true },
        "with 1 result object for its two operations",
      ],
    ] as const)("%s", async (_, faults, detail) => {
      const { outcome, store } = await runAtomic("spec/atomic/results-order", faults);
      expect(outcome._tag).toBe("Failed");
      expect(findingsOf(outcome)).toContainEqual(
        expect.objectContaining({ detail: expect.stringContaining(detail) }),
      );
      expect(leftovers(store)).toEqual([]);
    });
  });

  it("does not decide all-or-nothing on a server that fails no operation, and disposes of what it made", async () => {
    const { outcome, store } = await runAtomic("spec/atomic/all-or-nothing", {
      ignoresAbsentLid: true,
    });
    expect(outcome).toMatchObject({
      _tag: "Skipped",
      reason: expect.stringContaining("the server failed no operation"),
    });
    expect(leftovers(store)).toEqual([]);
  });

  it("decides nothing, and writes nothing, without `mutating: true`", async () => {
    const store = seeded();
    const report = await verifyOver(atomicApi)(atomicServer(store), {
      only: ["spec/atomic/"],
      writes: fixtures(store, []),
    });
    const processing = [
      "spec/atomic/lid-resolution",
      "spec/atomic/all-or-nothing",
      "spec/atomic/results-order",
    ];
    expect(processing.map((id) => outcomeFor(report, id))).toEqual(
      processing.map(() =>
        expect.objectContaining({
          _tag: "Skipped",
          reason: expect.stringContaining("mutating: true"),
        }),
      ),
    );
    expect(leftovers(store)).toEqual([]);
  });
});
// ---------------------------------------------------------------------------
// An atomic `remove` naming a resource that does not exist (#477)
// ---------------------------------------------------------------------------

/**
 * A canned operations endpoint over a store of posts: an `add` creates one,
 * and a `remove` from its `tags` answers as `removes` says — 204 by default.
 */
describe("Conformance: an atomic remove naming an absent resource", () => {
  const RULE = "spec/atomic/remove-absent-succeeds";
  const Tag = Resource.make("tags", { attributes: { name: Schema.String } });
  const Post = Resource.make("posts", {
    attributes: { title: Schema.String },
    relationships: { tags: Relationship.many(() => Tag) },
  });
  const removableApi = HttpApi.make("removable")
    .add(Group.make(Post, Endpoint.get(Post), Endpoint.removeRelationship(Post, "tags")))
    .add(Group.make("operations", Endpoint.operations([Post])));
  const unremovableApi = HttpApi.make("unremovable")
    .add(Group.make(Post, Endpoint.get(Post)))
    .add(Group.make("operations", Endpoint.operations([Post])));

  const atomicType = `${MEDIA_TYPE};ext="${ATOMIC_EXTENSION_URI}"`;
  const Operations = Schema.Struct({
    "atomic:operations": Schema.Array(
      Schema.Struct({ op: Schema.String, ref: Schema.optionalKey(Schema.Unknown) }),
    ),
  });
  const decodeOperations = Schema.decodeUnknownOption(Operations);

  type Removes = "204" | "results" | "404" | "403";

  const run = async (
    removes: Removes = "204",
    target: typeof verifyCanned = verifyOver(removableApi),
  ) => {
    const posts = MutableHashSet.empty<string>();
    const removals: Array<unknown> = [];
    let next = 100;
    const serve = (request: CannedRequest): Canned => {
      if (request.method !== "POST" || request.path !== "/operations") return { status: 405 };
      const operation = Option.flatMap(decodeOperations(request.body), (body) =>
        Arr.head(body["atomic:operations"]),
      );
      if (Option.isNone(operation)) return { status: 400, body: { errors: [{ status: "400" }] } };
      if (operation.value.op === "add") {
        const id = `${next++}`;
        MutableHashSet.add(posts, id);
        return {
          contentType: atomicType,
          body: { "atomic:results": [{ data: { type: "posts", id, attributes: { title: "" } } }] },
        };
      }
      removals.push(request.body);
      return Match.value(removes).pipe(
        Match.when("results", (): Canned => ({
          contentType: atomicType,
          body: { "atomic:results": [{}] },
        })),
        Match.when("404", (): Canned => ({ status: 404, body: { errors: [{ status: "404" }] } })),
        Match.when("403", (): Canned => ({ status: 403, body: { errors: [{ status: "403" }] } })),
        Match.orElse((): Canned => ({ status: 204 })),
      );
    };
    const report = await target(serve, {
      only: [RULE],
      mutating: true,
      ids: {},
      writes: {
        posts: {
          create: () => ({ type: "posts", attributes: { title: "a post" } }),
          cleanup: (id) => Effect.sync(() => MutableHashSet.remove(posts, id)),
        },
      },
    });
    return { outcome: outcomeFor(report, RULE), posts, removals };
  };

  it.each(["204", "results"] as const)(
    "passes a remove answered %s, naming absentId under the relationship's type",
    async (removes) => {
      const { outcome, posts, removals } = await run(removes);
      expect(outcome).toMatchObject({ _tag: "Passed", probes: 2 });
      expect(removals).toEqual([
        {
          "atomic:operations": [
            {
              op: "remove",
              ref: { type: "posts", id: "100", relationship: "tags" },
              data: [{ type: "tags", id: "conformance-absent-id-0000" }],
            },
          ],
        },
      ]);
      expect(MutableHashSet.size(posts)).toBe(0);
    },
  );

  it("fails a remove answered 404", async () => {
    const { outcome, posts } = await run("404");
    expect(outcome._tag).toBe("Failed");
    expect(Predicate.isTagged(outcome, "Failed") ? outcome.findings : []).toEqual([
      expect.objectContaining({
        detail: expect.stringMatching(
          /^a `remove` from the `tags` of posts:100 naming tags:conformance-absent-id-0000, which does not exist, answered 404: /,
        ),
        expected: "200 OK with `atomic:results`, or 204 No Content",
      }),
    ]);
    expect(MutableHashSet.size(posts)).toBe(0);
  });

  it("decides nothing on a remove the server forbids", async () => {
    const { outcome } = await run("403");
    expect(outcome).toMatchObject({
      _tag: "Skipped",
      reason: expect.stringContaining("answered 403 Forbidden"),
    });
  });

  it("skips, sending nothing, when no relationship write endpoint shows a to-many relationship", async () => {
    const { outcome, removals } = await run("204", verifyOver(unremovableApi));
    expect(outcome).toMatchObject({
      _tag: "Skipped",
      reason: expect.stringContaining('to-many relationship of "posts"'),
    });
    expect(removals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pagination links enumerate the collection (#166)
// ---------------------------------------------------------------------------

/**
 * A canned pager over a fixed collection, as a server would page it: the
 * conformant default, and one seam per way a pager breaks — which resources a
 * page holds, and which links it carries.
 */
describe("Conformance: pagination links enumerate the collection", () => {
  const RULE = "spec/pagination/links-enumerate-collection";

  const Tag = Resource.make("tags", { attributes: { name: Schema.String } });
  const offsetApi = HttpApi.make("paged").add(
    Group.make(Tag, Endpoint.list(Tag, { page: Query.Page.Offset })),
  );
  const numberApi = HttpApi.make("paged").add(
    Group.make(Tag, Endpoint.list(Tag, { page: Query.Page.Number })),
  );
  const cursorApi = HttpApi.make("paged").add(
    Group.make(Tag, Endpoint.list(Tag, { page: Query.Page.Cursor })),
  );

  const ROWS = ["1", "2", "3", "4", "5", "6", "7"];
  const tag = (id: string) => ({ type: "tags", id, attributes: { name: `tag ${id}` } });
  const notFound: Canned = {
    status: 404,
    body: { errors: [{ status: "404", title: "Not Found" }] },
  };

  interface Window {
    readonly offset: number;
    readonly limit: number;
    readonly total: number;
  }

  /**
   * What a canned page puts under a pagination key: any JSON — a link, `null`,
   * or something that is not a link at all.
   */
  type LinkValue = Schema.Json;

  interface Links {
    readonly first?: LinkValue;
    readonly prev?: LinkValue;
    readonly next?: LinkValue;
    readonly last?: LinkValue;
  }

  /** The offset pager's links on `path`, as `Handlers.offsetPaginationLinks` spells them. */
  const offsetLinks = ({ offset, limit, total }: Window, path = "/tags"): Links => {
    const at = (start: number) => `${path}?page[offset]=${start}&page[limit]=${limit}`;
    return {
      first: at(0),
      prev: offset > 0 ? at(Math.max(offset - limit, 0)) : null,
      next: offset + limit < total ? at(offset + limit) : null,
      last: at(Math.floor(Math.max(total - 1, 0) / limit) * limit),
    };
  };

  interface Pager {
    readonly rows?: ReadonlyArray<string>;
    /** The page size when the request names none: the whole collection unless given. */
    readonly defaultLimit?: number;
    /** The ids a window holds. */
    readonly slice?: (rows: ReadonlyArray<string>, window: Window) => ReadonlyArray<string>;
    readonly links?: (window: Window) => Links;
  }

  const offsetPager =
    (pager: Pager = {}) =>
    (request: CannedRequest): Canned => {
      if (withoutQuery(request).path !== "/tags") return notFound;
      const query = queryOf(request);
      const rows = pager.rows ?? ROWS;
      const window = {
        offset: Number(query.get("page[offset]") ?? "0"),
        limit: Number(query.get("page[limit]") ?? `${pager.defaultLimit ?? rows.length}`),
        total: rows.length,
      };
      const ids = (pager.slice ?? ((all, w) => all.slice(w.offset, w.offset + w.limit)))(
        rows,
        window,
      );
      return { body: { data: ids.map(tag), links: (pager.links ?? offsetLinks)(window) } };
    };

  /** Every path a canned server was asked for, in order. */
  const recording = (serve: (request: CannedRequest) => Canned) => {
    const paths: Array<string> = [];
    return {
      paths,
      serve: (request: CannedRequest): Canned => {
        paths.push(decodeURIComponent(request.path));
        return serve(request);
      },
    };
  };

  /** A run of the pagination rule alone against `serve`, discovering `target`. */
  const verifyPaged = <ApiId extends string, Groups extends HttpApiGroup.Constraint>(
    serve: (request: CannedRequest) => Canned,
    target: HttpApi.HttpApi<ApiId, Groups>,
  ) => verifyOver(target)(serve, { only: [RULE] });

  /** The rule's outcome, which must be `Failed`, and its findings' details and observations. */
  const failure = async (serve: (request: CannedRequest) => Canned) => {
    const outcome = outcomeFor(await verifyPaged(serve, offsetApi), RULE);
    expect(outcome._tag).toBe("Failed");
    const findings = Predicate.isTagged(outcome, "Failed") ? outcome.findings : [];
    Arr.forEach(findings, (found) => {
      expect(found.expected).not.toBe("");
      expect(found.observed).not.toBe("");
    });
    return findings.map(({ detail, observed }) => `${detail} | ${observed}`);
  };

  const skipReasonOver = async <ApiId extends string, Groups extends HttpApiGroup.Constraint>(
    serve: (request: CannedRequest) => Canned,
    target: HttpApi.HttpApi<ApiId, Groups>,
  ) => {
    const outcome = outcomeFor(await verifyPaged(serve, target), RULE);
    expect(outcome._tag).toBe("Skipped");
    return Predicate.isTagged(outcome, "Skipped") ? outcome.reason : "";
  };
  const skipReason = (serve: (request: CannedRequest) => Canned) =>
    skipReasonOver(serve, offsetApi);

  it("walks `next` from the first page of a conformant offset pager and passes", async () => {
    const server = recording(offsetPager());
    const outcome = outcomeFor(await verifyPaged(server.serve, offsetApi), RULE);
    expect(outcome).toMatchObject({ _tag: "Passed", note: undefined });
    // The whole collection first, then three pages of three, the third reached
    // through the second's `next`, and the `first` link once.
    expect(server.paths).toEqual([
      "/tags",
      "/tags?page[offset]=0&page[limit]=7",
      "/tags?page[limit]=3",
      "/tags?page[offset]=3&page[limit]=3",
      "/tags?page[offset]=6&page[limit]=3",
      "/tags?page[offset]=0&page[limit]=3",
    ]);
    expect(Predicate.isTagged(outcome, "Passed") ? outcome.probes : 0).toBe(server.paths.length);
  });

  it("works off the links, not the strategy: page number and size", async () => {
    const numberPager = (request: CannedRequest): Canned => {
      if (withoutQuery(request).path !== "/tags") return notFound;
      const query = queryOf(request);
      const size = Number(query.get("page[size]") ?? `${ROWS.length}`);
      const number = Number(query.get("page[number]") ?? "1");
      const pages = Math.ceil(ROWS.length / size);
      const at = (n: number) => `/tags?page[number]=${n}&page[size]=${size}`;
      return {
        body: {
          data: ROWS.slice((number - 1) * size, number * size).map(tag),
          links: {
            first: at(1),
            prev: number > 1 ? at(number - 1) : null,
            next: number < pages ? at(number + 1) : null,
            last: at(pages),
          },
        },
      };
    };
    const server = recording(numberPager);
    const outcome = outcomeFor(await verifyPaged(server.serve, numberApi), RULE);
    expect(outcome._tag).toBe("Passed");
    expect(server.paths).toContain("/tags?page[size]=3");
    expect(server.paths).toContain("/tags?page[number]=3&page[size]=3");
  });

  it("works off the links, not the strategy: an opaque cursor and absolute URLs", async () => {
    const cursorPager = (request: CannedRequest): Canned => {
      if (withoutQuery(request).path !== "/tags") return notFound;
      const query = queryOf(request);
      const size = Number(query.get("page[size]") ?? `${ROWS.length}`);
      const cursor = query.get("page[cursor]");
      const start = cursor === null ? 0 : ROWS.indexOf(atob(cursor)) + 1;
      const ids = ROWS.slice(start, start + size);
      const last = ids.at(-1);
      return {
        body: {
          data: ids.map(tag),
          links: {
            next:
              last === undefined || last === ROWS.at(-1)
                ? null
                : {
                    href: `http://fixture.test/tags?page[cursor]=${btoa(last)}&page[size]=${size}`,
                  },
          },
        },
      };
    };
    const server = recording(cursorPager);
    const outcome = outcomeFor(await verifyPaged(server.serve, cursorApi), RULE);
    expect(outcome._tag).toBe("Passed");
    expect(server.paths).toContain(`/tags?page[cursor]=${btoa("6")}&page[size]=3`);
  });

  it("walks a collection the server pages by default, cross-checking a second page size", async () => {
    const server = recording(offsetPager({ defaultLimit: 3 }));
    const outcome = outcomeFor(await verifyPaged(server.serve, offsetApi), RULE);
    expect(outcome._tag).toBe("Passed");
    // The default pages of three are the reference; the walk uses pages of two.
    expect(server.paths).toContain("/tags?page[offset]=6&page[limit]=3");
    expect(server.paths).toContain("/tags?page[limit]=2");
    expect(server.paths).toContain("/tags?page[offset]=6&page[limit]=2");
  });

  it("detects pages that repeat a resource", async () => {
    // Each page after the first starts one row early, so its first row is the
    // previous page's last.
    const repeats = await failure(
      offsetPager({
        slice: (rows, { offset, limit }) => rows.slice(Math.max(offset - 1, 0), offset + limit),
      }),
    );
    expect(repeats).toEqual([
      "following `next` from /tags?page[limit]=3 listed 2 resources a second time | tags:3 (pages 1 and 2), tags:6 (pages 2 and 3)",
    ]);
  });

  it("detects a skipped page against the collection fetched whole", async () => {
    const gaps = await failure(
      offsetPager({
        links: (window) => ({
          ...offsetLinks(window),
          next:
            window.offset + 2 * window.limit < window.total
              ? `/tags?page[offset]=${window.offset + 2 * window.limit}&page[limit]=${window.limit}`
              : null,
        }),
      }),
    );
    expect(gaps).toEqual([
      "following `next` from /tags?page[limit]=3 never reached 3 resources /tags lists | never reached: tags:4, tags:5, tags:6",
    ]);
  });

  it("detects a cyclic `next`, and stops", async () => {
    const server = recording(
      offsetPager({
        links: (window) => ({
          ...offsetLinks(window),
          next:
            window.offset + window.limit < window.total
              ? `/tags?page[offset]=${window.offset + window.limit}&page[limit]=${window.limit}`
              : `/tags?page[offset]=${window.limit}&page[limit]=${window.limit}`,
        }),
      }),
    );
    const outcome = outcomeFor(await verifyPaged(server.serve, offsetApi), RULE);
    expect(outcome._tag).toBe("Failed");
    const details = Predicate.isTagged(outcome, "Failed")
      ? outcome.findings.map((found) => found.detail).join("\n")
      : "";
    expect(details).toContain(
      "`next` on page 3 (/tags?page[offset]=6&page[limit]=3) leads back to page 2 (/tags?page[offset]=3&page[limit]=3), so following it never ends",
    );
    expect(server.paths.length).toBeLessThan(20);
  });

  it("detects a `next` that never ends, leading past the last page", async () => {
    const server = recording(
      offsetPager({
        links: (window) => ({
          ...offsetLinks(window),
          next: `/tags?page[offset]=${window.offset + window.limit}&page[limit]=${window.limit}`,
        }),
      }),
    );
    const outcome = outcomeFor(await verifyPaged(server.serve, offsetApi), RULE);
    expect(outcome._tag).toBe("Failed");
    const details = Predicate.isTagged(outcome, "Failed")
      ? outcome.findings.map((found) => found.detail).join("\n")
      : "";
    expect(details).toContain(
      "`next` on page 3 (/tags?page[offset]=6&page[limit]=3) leads to a page that lists no resources, so the last page carries `next`",
    );
    expect(server.paths.length).toBeLessThan(20);
  });

  it("detects a `next` that never ends, serving the same page again and again", async () => {
    const server = recording(
      offsetPager({
        slice: (rows, { limit }) => rows.slice(0, limit),
        links: (window) => ({
          ...offsetLinks(window),
          next: `/tags?page[offset]=${window.offset + window.limit}&page[limit]=${window.limit}`,
        }),
      }),
    );
    const outcome = outcomeFor(await verifyPaged(server.serve, offsetApi), RULE);
    expect(outcome._tag).toBe("Failed");
    const details = Predicate.isTagged(outcome, "Failed")
      ? outcome.findings.map((found) => found.detail).join("\n")
      : "";
    expect(details).toContain(
      "following `next` from /tags listed 7 resources a second time — page 2 listed nothing earlier pages had not, so the walk stopped there",
    );
    expect(server.paths.length).toBeLessThan(20);
  });

  it("detects `prev` on the first page", async () => {
    const found = await failure(
      offsetPager({
        links: (window) => ({ ...offsetLinks(window), prev: "/tags?page[offset]=0&page[limit]=1" }),
      }),
    );
    expect(found).toEqual([
      "the first page (/tags) carries `prev`, but no page comes before it | prev: /tags?page[offset]=0&page[limit]=1",
      "the first page (/tags?page[limit]=3) carries `prev`, but no page comes before it | prev: /tags?page[offset]=0&page[limit]=1",
    ]);
  });

  it("detects `last` pointing past the end", async () => {
    const found = await failure(
      offsetPager({
        links: (window) => ({
          ...offsetLinks(window),
          last: `/tags?page[offset]=${window.total}&page[limit]=${window.limit}`,
        }),
      }),
    );
    expect(found).toEqual([
      "`last` on /tags answers different resources from the last page `next` reaches | no resources (/tags?page[offset]=7&page[limit]=7)",
      "`last` on /tags?page[limit]=3 answers different resources from the last page `next` reaches | no resources (/tags?page[offset]=7&page[limit]=3)",
    ]);
  });

  it("detects `first` disagreeing with the first page", async () => {
    const found = await failure(
      offsetPager({
        links: (window) => ({
          ...offsetLinks(window),
          first: `/tags?page[offset]=1&page[limit]=${window.limit}`,
        }),
      }),
    );
    expect(found).toEqual([
      "`first` on /tags answers different resources from the first page | tags:2, tags:3, tags:4, tags:5, tags:6, tags:7 (/tags?page[offset]=1&page[limit]=7)",
      "`first` on /tags?page[limit]=3 answers different resources from the first page | tags:2, tags:3, tags:4 (/tags?page[offset]=1&page[limit]=3)",
    ]);
  });

  it("detects a `next` that leads to an error", async () => {
    const found = await failure((request) =>
      queryOf(request).get("page[offset]") === "3" ? notFound : offsetPager()(request),
    );
    expect(found).toEqual([
      `\`next\` on page 1 (/tags?page[limit]=3) leads to a response that is not a page of the collection | 404 ${MEDIA_TYPE} — {"errors":[{"status":"404","title":"Not Found"}]}`,
    ]);
  });

  it("detects a `next` that leads to a 2xx that is not a page", async () => {
    const found = await failure((request) =>
      queryOf(request).get("page[offset]") === "3"
        ? { body: { data: tag("4") } }
        : offsetPager()(request),
    );
    expect(found).toEqual([
      `\`next\` on page 1 (/tags?page[limit]=3) leads to a response that is not a page of the collection | 200 ${MEDIA_TYPE} — {"data":{"type":"tags","id":"4","attributes":{"name":"tag 4"}}}`,
    ]);
  });

  // A server error, a rate limit or a lost response says nothing of the
  // links: the reference fetch is not decided on one, and neither is the walk.
  const unavailable: Canned = {
    status: 503,
    body: { errors: [{ status: "503", title: "Service Unavailable" }] },
  };
  const limited: Canned = {
    status: 429,
    body: { errors: [{ status: "429", title: "Too Many Requests" }] },
  };
  /** Every status that says nothing of the links, at the edges of the ranges it covers. */
  const silent = [
    ["503", unavailable],
    ["500", { status: 500, body: { errors: [{ status: "500", title: "Internal Server Error" }] } }],
    ["429", limited],
    ["408", { status: 408, body: { errors: [{ status: "408", title: "Request Timeout" }] } }],
  ] as const satisfies ReadonlyArray<readonly [string, Canned]>;

  it.each(silent)("does not hold a %s mid-walk against `next`", async (status, answer) => {
    const reason = await skipReason((request) =>
      queryOf(request).get("page[offset]") === "3" ? answer : offsetPager()(request),
    );
    expect(reason).toBe(
      `no paginated collection could be walked to a verdict (/tags: \`next\` on page 1 (/tags?page[limit]=3) got ${status}, so the walk could not be finished — a server error, a rate limit, a request timeout or a lost response says nothing of the links)`,
    );
  });

  it("follows a `next` that redirects within the origin, and leaves one that redirects off it unfinished", async () => {
    const onPage2 = (answer: Canned) => (request: CannedRequest) =>
      queryOf(request).get("page[offset]") === "3" && !queryOf(request).has("moved")
        ? answer
        : offsetPager()(request);
    // The same page, a hop away on the run's origin: the walk goes on.
    const report = await verifyOver(offsetApi)(
      onPage2({ status: 307, headers: { location: "/tags?page[offset]=3&page[limit]=3&moved=1" } }),
      { only: [RULE] },
    );
    expect(outcomeFor(report, RULE)._tag).toBe("Passed");
    expect(
      await skipReason(
        onPage2({
          status: 302,
          headers: { location: "https://elsewhere.test/tags?page[offset]=3" },
        }),
      ),
    ).toBe(
      `no paginated collection could be walked to a verdict (/tags: \`next\` on page 1 (/tags?page[limit]=3) answered ${offsite("/tags?page[offset]=3")}, so the walk could not be finished); 1 of 5 requests the rule sent were answered by a redirect the kit does not follow or read (GET /tags?page[offset]=3&page[limit]=3 answered ${offsite("/tags?page[offset]=3")})`,
    );
  });

  /** `/tags`, with `/cats` paging as `/tags` does beside it. */
  const Cat = Resource.make("cats", { attributes: { name: Schema.String } });
  const twoApi = HttpApi.make("paged").add(
    Group.make(Tag, Endpoint.list(Tag, { page: Query.Page.Offset })),
    Group.make(Cat, Endpoint.list(Cat, { page: Query.Page.Offset })),
  );
  const besideCats =
    (tags: (request: CannedRequest) => Canned) =>
    (request: CannedRequest): Canned =>
      request.path.startsWith("/cats")
        ? offsetPager({ links: (window) => offsetLinks(window, "/cats") })({
            ...request,
            path: request.path.replace(/^\/cats/, "/tags"),
          })
        : tags(request);

  it("skips — never passes — a collection it walked beside one a redirect off the origin left unfinished", async () => {
    // `/cats` walks; `/tags` page 2 leaves the origin.
    const serve = besideCats((request) =>
      queryOf(request).get("page[offset]") === "3"
        ? { status: 302, headers: { location: "https://elsewhere.test/tags?page[offset]=3" } }
        : offsetPager()(request),
    );
    expect(outcomeFor(await verifyPaged(serve, twoApi), RULE)).toEqual({
      _tag: "Skipped",
      rule: expect.anything(),
      reason: `not decided: 1 of 11 requests the rule sent were answered by a redirect the kit does not follow or read (GET /tags?page[offset]=3&page[limit]=3 answered ${offsite("/tags?page[offset]=3")}), and a rule is not passed on the answers it did read alone; the rule's own note: 1 collection not decided: /tags: \`next\` on page 1 (/tags?page[limit]=3) answered ${offsite("/tags?page[offset]=3")}, so the walk could not be finished`,
    });
  });

  it("skips, naming the redirect, a collection whose every request leaves the origin beside one it walked", async () => {
    const serve = besideCats((request) =>
      withoutQuery(request).path === "/tags"
        ? {
            status: 302,
            headers: { location: `https://elsewhere.test${decodeURIComponent(request.path)}` },
          }
        : offsetPager()(request),
    );
    expect(outcomeFor(await verifyPaged(serve, twoApi), RULE)).toMatchObject({
      _tag: "Skipped",
      reason: expect.stringContaining(`GET /tags answered ${offsite("/tags")}`),
    });
  });

  it("does not hold a lost response mid-walk against `next`", async () => {
    const report = await verifyOver(offsetApi)(offsetPager(), { only: [RULE] }, (client) =>
      HttpClient.make((request) =>
        /page(\[|%5B)offset(\]|%5D)=3/.test(request.url)
          ? Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request, description: "reset" }),
              }),
            )
          : client.execute(request),
      ),
    );
    expect(outcomeFor(report, RULE)).toMatchObject({
      _tag: "Skipped",
      reason: expect.stringContaining(
        "/tags: `next` on page 1 (/tags?page[limit]=3) got no response (",
      ),
    });
  });

  it.each(silent)("does not hold a %s from `first` against the links", async (status, answer) => {
    const reason = await skipReason((request) =>
      queryOf(request).get("page[offset]") === "0" ? answer : offsetPager()(request),
    );
    expect(reason).toContain(
      `/tags: \`first\` on /tags got ${status}, so it could not be checked — a server error, a rate limit, a request timeout or a lost response says nothing of the links`,
    );
  });

  it.each(silent)("does not hold a %s from `last` against the links", async (status, answer) => {
    // `last` names the page `next` reaches by another URL, so the kit asks for it.
    const reason = await skipReason((request) =>
      queryOf(request).get("page[last]") === "1"
        ? answer
        : offsetPager({
            links: (window) => ({
              ...offsetLinks(window),
              last: `/tags?page[last]=1&page[limit]=${window.limit}`,
            }),
          })(request),
    );
    expect(reason).toContain(
      `/tags: \`last\` on /tags got ${status}, so it could not be checked — a server error, a rate limit, a request timeout or a lost response says nothing of the links`,
    );
  });

  it("does not hold a reference walk cut short to a repeat without rechecking the order", async () => {
    // The server pages by default: its second page repeats the first's last
    // resource, and its third answers 503. Asked again, the first page comes
    // back in another order, so the repeat is not held against the links.
    let asked = 0;
    const pager = offsetPager({
      defaultLimit: 3,
      slice: (rows, { offset, limit }) => rows.slice(Math.max(offset - 1, 0), offset + limit),
    });
    const reason = await skipReason((request) => {
      const path = decodeURIComponent(request.path);
      if (path === "/tags" && ++asked === 2) {
        return { body: { data: ["3", "2", "1"].map(tag), links: {} } };
      }
      return queryOf(request).get("page[offset]") === "6" ? unavailable : pager(request);
    });
    expect(reason).toContain(
      "/tags: `next` on page 2 (/tags?page[offset]=3&page[limit]=3) got 503, so the walk could not be finished — a server error, a rate limit, a request timeout or a lost response says nothing of the links; the collection's order is not stable",
    );
    expect(reason).toContain("so the walk's 1 order-dependent finding");
  });

  /** Pages that each start one row early, so each repeats the previous page's last. */
  const repeating = offsetPager({
    slice: (rows, { offset, limit }) => rows.slice(Math.max(offset - 1, 0), offset + limit),
  });

  it("does not take a recheck of the order that failed for a stable order", async () => {
    let asked = 0;
    const reason = await skipReason((request) =>
      decodeURIComponent(request.path) === "/tags?page[limit]=3" && ++asked === 2
        ? unavailable
        : repeating(request),
    );
    expect(reason).toContain(
      "/tags: asked for /tags?page[limit]=3 a second time to confirm the collection's order is stable, the kit got 503, so the walk's 1 order-dependent finding",
    );
  });

  it("does not hold a walk cut short to a repeat without rechecking the order", async () => {
    // The second walk repeats a resource, then leads off the origin; asked
    // again, its first page comes back in another order.
    let asked = 0;
    const reason = await skipReason((request) => {
      const query = queryOf(request);
      const answer = repeating(request);
      if (decodeURIComponent(request.path) === "/tags?page[limit]=3" && ++asked === 2) {
        return { body: { data: ["3", "2", "1"].map(tag), links: {} } };
      }
      return query.get("page[offset]") === "3"
        ? {
            body: {
              data: ["3", "4", "5", "6"].map(tag),
              links: { next: "https://elsewhere.test/tags" },
            },
          }
        : answer;
    });
    expect(reason).toContain(
      "/tags: `next` on page 2 (/tags?page[offset]=3&page[limit]=3) leads to another origin, https://elsewhere.test, which the kit does not follow; the collection's order is not stable",
    );
    expect(reason).toContain("so the walk's 1 order-dependent finding");
  });

  it("stops rechecking the order at the first page that shows it unstable", async () => {
    // Asked again, the reference comes back in another order; the second
    // walk's first page is not asked for a third time.
    let asked = 0;
    const server = recording((request) =>
      decodeURIComponent(request.path) === "/tags" && ++asked === 2
        ? { body: { data: [...ROWS].reverse().map(tag), links: {} } }
        : repeating(request),
    );
    const reason = await skipReason(server.serve);
    expect(reason).toContain("the collection's order is not stable");
    expect(server.paths).toEqual([
      "/tags",
      "/tags?page[offset]=0&page[limit]=7",
      "/tags?page[limit]=3",
      "/tags?page[offset]=3&page[limit]=3",
      "/tags?page[offset]=6&page[limit]=3",
      "/tags?page[offset]=0&page[limit]=3",
      "/tags",
    ]);
  });

  it("does not take a `first` page of items it cannot identify for a different page", async () => {
    const reason = await skipReason((request) =>
      queryOf(request).get("page[offset]") === "0"
        ? { body: { data: [{ name: "a" }], links: {} } }
        : offsetPager()(request),
    );
    expect(reason).toContain(
      "/tags: `first` on /tags leads to a page of 1 item, none of them a resource the kit can identify (a string `type` and `id` or `lid`), so it could not be checked",
    );
  });

  it("does not take a collection of items it cannot identify for an empty one", async () => {
    const reason = await skipReason(() => ({
      body: { data: [{ name: "a" }, { name: "b" }], links: {} },
    }));
    expect(reason).toContain(
      "/tags: /tags answered a page of 2 items, none of them a resource the kit can identify (a string `type` and `id` or `lid`), so no walk can start from it",
    );
  });

  // A walk's own starting page is held to what later pages are: one of items
  // the kit cannot identify leaves the collection not decided, not failed.
  it("does not hold a second walk that starts on items it cannot identify against the links", async () => {
    const reason = await skipReason((request) =>
      decodeURIComponent(request.path) === "/tags?page[limit]=3"
        ? {
            body: {
              data: [{ name: "a" }, { name: "b" }, { name: "c" }],
              links: offsetLinks({ offset: 0, limit: 3, total: ROWS.length }),
            },
          }
        : offsetPager()(request),
    );
    expect(reason).toBe(
      "no paginated collection could be walked to a verdict (/tags: /tags?page[limit]=3 answered a page of 3 items, none of them a resource the kit can identify (a string `type` and `id` or `lid`), so no walk can start from it)",
    );
  });

  it("does not hold a reference that starts on items it cannot identify against the links", async () => {
    // The server pages by default, and its first page lists items without an
    // identity; the pages `next` leads to list resources.
    const pager = offsetPager({ defaultLimit: 3 });
    const reason = await skipReason((request) =>
      decodeURIComponent(request.path) === "/tags"
        ? {
            body: {
              data: [{ name: "a" }, { name: "b" }, { name: "c" }],
              links: offsetLinks({ offset: 0, limit: 3, total: ROWS.length }),
            },
          }
        : pager(request),
    );
    expect(reason).toBe(
      "no paginated collection could be walked to a verdict (/tags: /tags answered a page of 3 items, none of them a resource the kit can identify (a string `type` and `id` or `lid`), so no walk can start from it)",
    );
  });

  it("does not take a page of items it cannot identify for an empty page", async () => {
    const reason = await skipReason((request) =>
      queryOf(request).get("page[offset]") === "3"
        ? { body: { data: [{ name: "a" }, { name: "b" }], links: {} } }
        : offsetPager()(request),
    );
    expect(reason).toContain(
      "/tags: `next` on page 1 (/tags?page[limit]=3) leads to a page of 2 items, none of them a resource the kit can identify (a string `type` and `id` or `lid`), so the walk could not be finished",
    );
  });

  it("quotes a server value cut to 200 code units, never splitting a surrogate pair", async () => {
    const carrying = (prev: string) =>
      failure(offsetPager({ links: (window) => ({ ...offsetLinks(window), prev }) }));
    const long = `/tags?${"x".repeat(300)}`;
    expect((await carrying(long))[0]).toBe(
      `the first page (/tags) carries \`prev\`, but no page comes before it | prev: ${long.slice(0, 199)}…`,
    );
    // Code unit 199 is the high half of an emoji: the cut drops it rather than
    // leave half a character.
    expect((await carrying(`${"a".repeat(198)}😀😀`))[0]).toBe(
      `the first page (/tags) carries \`prev\`, but no page comes before it | prev: ${"a".repeat(198)}…`,
    );
  });

  it("detects a walk that reaches a resource the collection does not list", async () => {
    const found = await failure((request) =>
      offsetPager({
        rows:
          queryOf(request).get("page[limit]") === "3" ? ["1", "2", "3", "4", "5", "6", "8"] : ROWS,
      })(request),
    );
    expect(found).toEqual([
      "following `next` from /tags?page[limit]=3 never reached 1 resource /tags lists | never reached: tags:7",
      "following `next` from /tags?page[limit]=3 reached 1 resource /tags does not list | not in /tags: tags:8",
    ]);
  });

  it("stops a walk that lists more resources than the collection holds", async () => {
    // Pages of three go on past the seventh resource with fresh ones, forever.
    const server = recording(
      offsetPager({
        slice: (_, { offset, limit }) => Arr.makeBy(limit, (n) => `${offset + n + 1}`),
        links: (window) => ({
          ...offsetLinks(window),
          next:
            window.limit < window.total
              ? `/tags?page[offset]=${window.offset + window.limit}&page[limit]=${window.limit}`
              : null,
        }),
      }),
    );
    expect(await failure(server.serve)).toEqual([
      "following `next` from /tags?page[limit]=3 reached 2 resources /tags does not list | not in /tags: tags:8, tags:9",
    ]);
    expect(server.paths).toContain("/tags?page[offset]=6&page[limit]=3");
    expect(server.paths).not.toContain("/tags?page[offset]=9&page[limit]=3");
  });

  // The request budget, pinned: ten collections ahead of `tags`, each a pager
  // that spends exactly the requests it is given and then leads off the
  // origin, leave `tags` exactly as many as a test chooses.
  const BURNERS = Arr.makeBy(10, (n) => `burner${n}`);
  const crowdedApi = HttpApi.make("paged").add(
    ...Arr.map(BURNERS, (type) => {
      const Burner = Resource.make(type, { attributes: { name: Schema.String } });
      return Group.make(Burner, Endpoint.list(Burner, { page: Query.Page.Offset }));
    }),
    Group.make(Tag, Endpoint.list(Tag, { page: Query.Page.Offset })),
  );

  /** `tags` from `serve`, behind burners that spend all of the budget of 200 but `leave`. */
  const crowded = (leave: number, serve: (request: CannedRequest) => Canned) => {
    const spend = 200 - leave;
    return (request: CannedRequest): Canned => {
      const type = withoutQuery(request).path.slice(1);
      const index = BURNERS.indexOf(type);
      if (index === -1) return serve(request);
      const cost = Math.min(Math.max(spend - 20 * index, 1), 20);
      const offset = Number(queryOf(request).get("page[offset]") ?? "0");
      return {
        body: {
          data: [{ type, id: `${offset}`, attributes: { name: `${type} ${offset}` } }],
          links: {
            next:
              offset + 1 < cost
                ? `/${type}?page[offset]=${offset + 1}`
                : `https://elsewhere.test/${type}`,
          },
        },
      };
    };
  };

  it("stops at the rule's budget of 200 requests, and says so", async () => {
    const server = recording(crowded(0, offsetPager()));
    const reason = await skipReasonOver(server.serve, crowdedApi);
    expect(server.paths).toHaveLength(200);
    expect(server.paths.some((path) => path.startsWith("/tags"))).toBe(false);
    expect(reason).toContain("/tags: the rule's budget of 200 requests ran out");
  });

  it("does not pass a collection whose `first` link the budget did not reach", async () => {
    // Five requests walk both partitions of `tags`; the sixth would check the
    // second walk's `first`.
    const server = recording(crowded(5, offsetPager()));
    const reason = await skipReasonOver(server.serve, crowdedApi);
    expect(server.paths).toHaveLength(200);
    expect(reason).toContain("/tags: the rule's budget of 200 requests ran out");
  });

  it("does not take a walk the budget cuts short for one that reached the last page", async () => {
    // The 200th request answers one resource and a `next` the budget leaves no
    // request to follow: the collection is not decided for want of requests,
    // not taken for a collection of one.
    const server = recording(
      crowded(1, (request) =>
        decodeURIComponent(request.path) === "/tags"
          ? { body: { data: [tag("1")], links: { next: "/tags?page[offset]=1" } } }
          : notFound,
      ),
    );
    const reason = await skipReasonOver(server.serve, crowdedApi);
    expect(server.paths).toHaveLength(200);
    expect(server.paths.at(-1)).toBe("/tags");
    expect(reason).toContain(
      "/tags: the rule's budget of 200 requests ran out before the collection could be checked",
    );
    expect(reason).not.toContain("fewer than two");
  });

  it("does not report order-dependent findings the budget left no request to recheck", async () => {
    // Seven requests walk `tags` and recheck the first page of one walk, not the other.
    const server = recording(crowded(7, repeating));
    const reason = await skipReasonOver(server.serve, crowdedApi);
    expect(server.paths).toHaveLength(200);
    expect(reason).toContain(
      "/tags: the rule's budget of 200 requests ran out before the collection's order could be confirmed stable, so the walk's 1 order-dependent finding",
    );
  });

  // `{"toString":1}` is valid JSON that `String` cannot convert: a link that
  // is not a link is a finding, not a rule that dies rendering it.
  it("detects a `next` that is not a link, rendering it safely", async () => {
    const found = await failure(
      offsetPager({
        links: (window) => ({
          ...offsetLinks(window),
          next: window.offset + window.limit < window.total ? { toString: 1 } : null,
        }),
      }),
    );
    expect(found).toEqual([
      `\`next\` on page 1 (/tags?page[limit]=3) is not a link the kit can follow | next: {"toString":1}`,
    ]);
  });

  it("does not follow a `next` to another origin", async () => {
    const server = recording(
      offsetPager({
        links: (window) => ({
          ...offsetLinks(window),
          next:
            window.offset + window.limit < window.total
              ? `https://elsewhere.test/tags?page[offset]=${window.offset + window.limit}&page[limit]=${window.limit}`
              : null,
        }),
      }),
    );
    const reason = await skipReason(server.serve);
    expect(reason).toBe(
      "no paginated collection could be walked to a verdict (/tags: `next` on page 1 (/tags?page[limit]=3) leads to another origin, https://elsewhere.test, which the kit does not follow)",
    );
    expect(server.paths.some((path) => path.includes("page[offset]=3"))).toBe(false);
  });

  it("skips, naming the budget, a walk that does not end within it — never a partial pass", async () => {
    const server = recording(
      offsetPager({ rows: Arr.makeBy(500, (n) => `${n}`), defaultLimit: 1 }),
    );
    const reason = await skipReason(server.serve);
    expect(reason).toContain("did not end within its budget of 20 pages");
    expect(server.paths.length).toBeLessThanOrEqual(25);
  });

  it("skips, naming the budget, a `next` that ends never with fresh resources", async () => {
    // Every page holds resources no earlier page held, forever.
    const endless = (request: CannedRequest): Canned => {
      const offset = Number(queryOf(request).get("page[offset]") ?? "0");
      return {
        body: {
          data: [tag(`${offset}`)],
          links: { next: `/tags?page[offset]=${offset + 1}` },
        },
      };
    };
    const server = recording(endless);
    expect(await skipReason(server.serve)).toMatch(/budget/);
    expect(server.paths.length).toBeLessThanOrEqual(25);
  });

  it("does not hold an unstably-ordered collection's repeats against its links", async () => {
    // Every request sees the collection rotated one further: offsets are
    // honoured, but over a different order each time. JSON:API requires no
    // stable order without `sort`, so this is not a violation of the links.
    let requests = 0;
    const reason = await skipReason(
      offsetPager({
        slice: (rows, { offset, limit }) => {
          const turn = requests++ % rows.length;
          return [...rows.slice(turn), ...rows.slice(0, turn)].slice(offset, offset + limit);
        },
      }),
    );
    expect(reason).toContain("the collection's order is not stable");
    expect(reason).toContain(
      '"The server MAY apply default sorting rules to top-level `data` if request parameter `sort` is not specified"',
    );
  });

  it("skips when no collection endpoint declares a page size", async () => {
    expect(await skipReasonOver(conformantServe, api)).toContain("`page[limit]` or `page[size]`");
  });

  it("skips a collection too small to fill two pages", async () => {
    expect(await skipReason(offsetPager({ rows: ["1"] }))).toContain(
      "/tags: the collection holds one resource — fewer than two",
    );
  });

  it("skips a collection whose server ignores the page size", async () => {
    const reason = await skipReason(
      offsetPager({ slice: (rows) => rows, links: () => ({ next: null }) }),
    );
    expect(reason).toContain(
      "/tags: `page[limit]=3` answered all 7 resources on one page, with no `next` to follow",
    );
  });

  it("holds `Handlers.offsetPaginationLinks` and the real router to the rule", async () => {
    const TagsLive = HttpApiBuilder.group(offsetApi, "tags", (handlers) =>
      handlers.handle("list", ({ query }) => {
        const total = ROWS.length;
        const offset = query.page?.offset ?? 0;
        const limit = query.page?.limit ?? total;
        return Effect.succeed(
          Handlers.collection(
            ROWS.slice(offset, offset + limit).map((id) =>
              Tag.make({ id: Tag.Id.make(id), attributes: { name: `tag ${id}` } }),
            ),
            { links: Handlers.offsetPaginationLinks("/tags", { offset, limit }, total) },
          ),
        );
      }),
    );
    const report = await runOver(
      offsetApi,
      TagsLive.pipe(Layer.provideMerge(Middleware.layer)),
    )({ only: [RULE] });
    expect(outcomeFor(report, RULE)).toMatchObject({ _tag: "Passed", note: undefined });
  });

  it("is in the spec tier, at the specification's MUST, and closes its coverage gap", () => {
    const rule = Conformance.rules.find((candidate) => candidate.id === RULE);
    expect(rule).toMatchObject({
      tier: "spec",
      level: "MUST",
      reference: "https://jsonapi.org/format/1.1/#fetching-pagination",
    });
    // The coverage gap it closes is no longer declared.
    expect(Conformance.gaps.map(({ area }) => area)).not.toContain("Pagination link correctness");
  });
});
// ---------------------------------------------------------------------------
// `self` and `related` links dereference (#168)
// ---------------------------------------------------------------------------

describe("Conformance: `self` and `related` links dereference", () => {
  const SELF = "spec/links/resource-self-dereferences";
  const RELATED = "spec/links/related-dereferences";
  const MATCHES = "spec/links/related-matches-linkage";
  const RELATIONSHIP_SELF = "spec/links/relationship-self-dereferences";
  const RELATIONSHIP_MATCHES = "spec/links/relationship-self-matches-linkage";
  const TOP_SELF = "spec/links/top-level-self-dereferences";
  const TOP_MATCHES = "spec/links/top-level-self-matches-document";
  const LINK_RULES = [
    SELF,
    RELATED,
    MATCHES,
    RELATIONSHIP_SELF,
    RELATIONSHIP_MATCHES,
    TOP_SELF,
    TOP_MATCHES,
  ];

  type Json = Schema.Json;

  /** The links and linkage each article carries; every member can be overridden per test. */
  interface Site {
    readonly ids?: ReadonlyArray<string>;
    readonly self?: (id: string) => Json;
    readonly author?: (id: string) => Json;
    readonly tags?: (id: string) => Json;
    readonly comments?: (id: string) => Json;
  }

  const articleOf =
    (site: Site) =>
    (id: string): Json => ({
      type: "articles",
      id,
      attributes: { title: `article ${id}`, body: "" },
      relationships: {
        author: site.author?.(id) ?? {
          links: {
            self: `/articles/${id}/relationships/author`,
            related: `/articles/${id}/author`,
          },
          data: { type: "people", id: "9" },
        },
        tags: site.tags?.(id) ?? {
          links: { self: `/articles/${id}/relationships/tags`, related: `/articles/${id}/tags` },
          data: [
            { type: "tags", id: "1" },
            { type: "tags", id: "2" },
          ],
        },
        // Paginated: links only, no linkage.
        comments: site.comments?.(id) ?? {
          links: {
            self: `/articles/${id}/relationships/comments`,
            related: `/articles/${id}/comments`,
          },
        },
      },
      links: { self: site.self?.(id) ?? `/articles/${id}` },
    });

  const person = (id: string) => ({ type: "people", id, attributes: { firstName: "Dan" } });
  const tag = (id: string) => ({ type: "tags", id, attributes: { name: `tag ${id}` } });
  const comment = (id: string) => ({ type: "comments", id, attributes: { body: "first" } });
  const notFound: Canned = {
    status: 404,
    body: { errors: [{ status: "404", title: "Not Found" }] },
  };

  /** `/articles/:id`, `/articles/:id/<name>` and `/articles/:id/relationships/<name>`. */
  const ARTICLE_ROUTE = /^\/articles\/([^/]+)(\/relationships)?(?:\/([a-z]+))?$/;

  /** What `/articles/:id/relationships/<name>` answers: the linkage every article carries. */
  const linkageAnswer = (name: string): Canned =>
    Match.value(name).pipe(
      Match.when("author", (): Canned => ({ body: { data: { type: "people", id: "9" } } })),
      Match.when("tags", (): Canned => ({
        body: {
          data: [
            { type: "tags", id: "1" },
            { type: "tags", id: "2" },
          ],
        },
      })),
      Match.when("comments", (): Canned => ({ body: { data: [{ type: "comments", id: "5" }] } })),
      Match.orElse(() => notFound),
    );

  /** What `/articles/:id` (`name` empty) and `/articles/:id/<name>` answer. */
  const articleAnswer = (article: Json, id: string, name: string): Canned =>
    Match.value(name).pipe(
      Match.when("", (): Canned => ({
        body: { data: article, links: { self: `/articles/${id}` } },
      })),
      Match.when("author", (): Canned => ({ body: { data: person("9") } })),
      Match.when("tags", (): Canned => ({ body: { data: [tag("1"), tag("2")] } })),
      Match.when("comments", (): Canned => ({
        body: { data: [comment("5")], links: { next: null } },
      })),
      Match.orElse(() => notFound),
    );

  /**
   * A server whose every link resolves to what it names: `/articles`, each
   * article, its author, its two tags and its (paginated) comments, each
   * relationship's linkage, and each document's own top-level `self`.
   */
  const linked =
    (site: Site = {}) =>
    (request: CannedRequest): Canned => {
      const ids = site.ids ?? ["1", "2"];
      const article = articleOf(site);
      const path = withoutQuery(request).path;
      if (path === "/articles") {
        return { body: { data: ids.map(article), links: { self: "/articles" } } };
      }
      const [, id = "", relationships, name = ""] = ARTICLE_ROUTE.exec(path) ?? [];
      if (!ids.includes(id)) return notFound;
      return relationships === undefined
        ? articleAnswer(article(id), id, name)
        : linkageAnswer(name);
    };

  /** `serve`, with the answer at `path` replaced. */
  const at =
    (path: string, answer: Canned, serve: (request: CannedRequest) => Canned = linked()) =>
    (request: CannedRequest): Canned =>
      withoutQuery(request).path === path ? answer : serve(request);

  /** Every URL a canned server was asked for, in order, with its origin. */
  const recording = (serve: (request: CannedRequest) => Canned) => {
    const urls: Array<string> = [];
    return {
      urls,
      paths: () => urls.map((url) => new URL(url).pathname),
      client: (canned: HttpClient.HttpClient) =>
        HttpClient.make((request) => {
          urls.push(decodeURIComponent(request.url));
          return canned.execute(request);
        }),
      serve,
    };
  };

  const run = (
    serve: (request: CannedRequest) => Canned,
    client?: (canned: HttpClient.HttpClient) => HttpClient.HttpClient,
  ) => verifyCanned(serve, { only: LINK_RULES }, client);

  const findingsOf = (outcome: Conformance.Outcome): ReadonlyArray<string> => {
    expect(outcome._tag).toBe("Failed");
    const found = Predicate.isTagged(outcome, "Failed") ? outcome.findings : [];
    Arr.forEach(found, (finding) => {
      expect(finding.expected).not.toBe("");
      expect(finding.observed).not.toBe("");
    });
    return found.map(({ detail, observed }) => `${detail} | ${observed}`);
  };

  const failureOf = async (id: string, serve: (request: CannedRequest) => Canned) =>
    findingsOf(outcomeFor(await run(serve), id));

  const skipReasonOf = async (id: string, serve: (request: CannedRequest) => Canned) => {
    const outcome = outcomeFor(await run(serve), id);
    expect(outcome._tag).toBe("Skipped");
    return Predicate.isTagged(outcome, "Skipped") ? outcome.reason : "";
  };

  const noteOf = async (id: string, serve: (request: CannedRequest) => Canned) => {
    const outcome = outcomeFor(await run(serve), id);
    expect(outcome._tag).toBe("Passed");
    return Predicate.isTagged(outcome, "Passed") ? outcome.note : undefined;
  };

  it("follows every resource's `self` link, once each, and passes", async () => {
    const server = recording(linked());
    const report = await verifyCanned(server.serve, { only: [SELF] }, server.client);
    const outcome = outcomeFor(report, SELF);
    expect(outcome).toMatchObject({ _tag: "Passed", note: undefined });
    // The read endpoints first, in discovery order, then each `self` the kit
    // has not already fetched: `/articles/1` is the get endpoint's own answer,
    // so it costs nothing.
    expect(server.paths()).toEqual(["/articles/1", "/articles", "/articles/2"]);
    expect(Predicate.isTagged(outcome, "Passed") ? outcome.probes : 0).toBe(3);
  });

  it("follows every relationship's `related` link, once each, and passes", async () => {
    const server = recording(linked());
    const report = await verifyCanned(server.serve, { only: [RELATED] }, server.client);
    const outcome = outcomeFor(report, RELATED);
    expect(outcome).toMatchObject({ _tag: "Passed", note: undefined });
    // The SHOULD follows the same links, less the links-only `comments`.
    const matches = recording(linked());
    const compared = await verifyCanned(matches.serve, { only: [MATCHES] }, matches.client);
    expect(outcomeFor(compared, MATCHES)).toMatchObject({
      _tag: "Passed",
      note: undefined,
      probes: 6,
    });
    expect(matches.paths().filter((path) => path.endsWith("/comments"))).toEqual([]);
    expect(server.paths()).toEqual([
      "/articles/1",
      "/articles",
      "/articles/1/author",
      "/articles/1/tags",
      "/articles/1/comments",
      "/articles/2/author",
      "/articles/2/tags",
      "/articles/2/comments",
    ]);
    expect(Predicate.isTagged(outcome, "Passed") ? outcome.probes : 0).toBe(8);
  });

  it("detects a `self` that leads to a different resource", async () => {
    const found = await failureOf(
      SELF,
      linked({ self: (id) => (id === "2" ? "/articles/1" : `/articles/${id}`) }),
    );
    expect(found).toEqual([
      "the `self` link of articles:2 (in /articles, at /data/1) answers a different resource as primary data | articles:1",
    ]);
  });

  it("detects a `self` that leads to a 404", async () => {
    const found = await failureOf(
      SELF,
      linked({ self: (id) => (id === "2" ? "/articles/two" : `/articles/${id}`) }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(
      /^the `self` link of articles:2 \(in \/articles, at \/data\/1\) answered 404 \| 404 /,
    );
  });

  it("detects a `self` whose answer carries no resource as primary data", async () => {
    const found = await failureOf(SELF, at("/articles/2", { body: { data: null } }));
    expect(found).toEqual([
      "the `self` link of articles:2 (in /articles, at /data/1) answers a different resource as primary data | `data: null`",
    ]);
  });

  it("detects a `related` that omits a resource its linkage names", async () => {
    const found = await failureOf(MATCHES, at("/articles/2/tags", { body: { data: [tag("1")] } }));
    expect(found).toEqual([
      "the `related` link of articles:2's `tags` (in /articles, at /data/1) answers without 1 resource its linkage names | missing: tags:2",
    ]);
  });

  it("detects a `related` that answers a resource its linkage does not name", async () => {
    const found = await failureOf(
      MATCHES,
      at("/articles/2/tags", { body: { data: [tag("1"), tag("2"), tag("3")] } }),
    );
    expect(found).toEqual([
      "the `related` link of articles:2's `tags` (in /articles, at /data/1) answers 1 resource its linkage does not name | not in the linkage: tags:3",
    ]);
  });

  it("detects a to-one `related` that answers a different resource", async () => {
    const found = await failureOf(
      MATCHES,
      at("/articles/1/author", { body: { data: person("10") } }),
    );
    // Both the get and the list endpoint carry article 1, so its link is
    // followed once, and named where it was found first.
    expect(found).toEqual([
      "the `related` link of articles:1's `author` (in /articles/1, at /data) answers a different resource from the one its linkage names | people:10",
    ]);
  });

  it("detects a to-one `related` that answers a resource where its linkage is `null`", async () => {
    const found = await failureOf(
      MATCHES,
      linked({
        author: (id) => ({ links: { related: `/articles/${id}/author` }, data: null }),
        ids: ["1"],
      }),
    );
    expect(found).toEqual([
      "the `related` link of articles:1's `author` (in /articles/1, at /data) answers a resource where its linkage is `null` | people:9",
    ]);
  });

  it("detects a `related` that answers something other than resource objects", async () => {
    const found = await failureOf(
      RELATED,
      at("/articles/2/comments", { body: { meta: { total: 1 } } }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(
      /^the `related` link of articles:2's `comments` \(in \/articles, at \/data\/1\) answers no related resource data as primary data \| 200 /,
    );
  });

  it("holds a page of a related collection to the linkage as a subset, not as the whole", async () => {
    // The related collection pages: its first page lacks tags:2, which is not a
    // finding, but one listing tags:3 the linkage does not name is.
    const paged = (data: ReadonlyArray<Json>): Canned => ({
      body: { data, links: { next: "/articles/2/tags?page[offset]=1" } },
    });
    expect(await noteOf(MATCHES, at("/articles/2/tags", paged([tag("1")])))).toBeUndefined();
    expect(await failureOf(MATCHES, at("/articles/2/tags", paged([tag("3")])))).toEqual([
      "the `related` link of articles:2's `tags` (in /articles, at /data/1) answers 1 resource its linkage does not name | not in the linkage: tags:3",
    ]);
  });

  it("holds paginated linkage as a subset of the related collection, not as the whole", async () => {
    const pagedLinkage = (id: string): Json => ({
      links: {
        related: `/articles/${id}/tags`,
        next: `/articles/${id}/relationships/tags?page[offset]=1`,
      },
      data: [{ type: "tags", id: "1" }],
    });
    // The linkage is a page: a related collection that also lists tags:2 is fine.
    expect(await noteOf(MATCHES, linked({ tags: pagedLinkage }))).toBeUndefined();
    // But one that omits what the page does name is not.
    expect(
      await failureOf(
        MATCHES,
        at("/articles/2/tags", { body: { data: [tag("2")] } }, linked({ tags: pagedLinkage })),
      ),
    ).toEqual([
      "the `related` link of articles:2's `tags` (in /articles, at /data/1) answers without 1 resource its linkage names | missing: tags:1",
    ]);
  });

  it("does not compare two pages with each other", async () => {
    const note = await noteOf(
      MATCHES,
      at(
        "/articles/2/tags",
        { body: { data: [tag("2")], links: { next: "/articles/2/tags?page[offset]=1" } } },
        linked({
          tags: (id) => ({
            links: { related: `/articles/${id}/tags`, next: `/articles/${id}/tags?x=1` },
            data: [{ type: "tags", id: "1" }],
          }),
        }),
      ),
    );
    expect(note).toBe(
      "1 link not decided: the `related` link of articles:2's `tags` (in /articles, at /data/1) — both its linkage and the collection it answers are pages, so neither can be held against the other",
    );
  });

  it("does not compare a collection holding items it cannot identify", async () => {
    // Without a string `type` and `id`, a missing tags:2 might be either item.
    const note = await noteOf(
      MATCHES,
      at("/articles/2/tags", { body: { data: [tag("1"), { type: "tags", id: 2 }] } }),
    );
    expect(note).toBe(
      "1 link not decided: the `related` link of articles:2's `tags` (in /articles, at /data/1) answers 1 item the kit cannot identify (a string `type` and `id`)",
    );
  });

  it("follows a link object's `href`, not only a bare URL", async () => {
    const server = recording(
      linked({
        self: (id) => ({ href: `/articles/${id}`, title: "the article" }),
        author: (id) => ({
          links: { related: { href: `/articles/${id}/author` } },
          data: { type: "people", id: "9" },
        }),
      }),
    );
    const report = await verifyCanned(server.serve, { only: [SELF, RELATED] }, server.client);
    expect(outcomeFor(report, SELF)).toMatchObject({ _tag: "Passed", note: undefined });
    expect(outcomeFor(report, RELATED)).toMatchObject({ _tag: "Passed", note: undefined });
    expect(server.paths()).toContain("/articles/2");
    expect(server.paths()).toContain("/articles/2/author");
    // And reads what it found there.
    const wrong = await failureOf(
      SELF,
      linked({ self: (id) => ({ href: id === "2" ? "/articles/1" : `/articles/${id}` }) }),
    );
    expect(wrong).toHaveLength(1);
  });

  it("resolves a relative link against the document that carries it, not the base URL", async () => {
    // On `/articles/1`, `./1` is `/articles/1` and `./1/author` is
    // `/articles/1/author`; resolved against the base URL they would be `/1`
    // and `/1/author`, which this server answers 404.
    const server = recording(
      at("/articles/1", {
        body: {
          data: articleOf({
            self: () => "./1",
            author: () => ({ links: { related: "./1/author" }, data: { type: "people", id: "9" } }),
          })("1"),
        },
      }),
    );
    const report = await verifyCanned(server.serve, { only: [SELF, RELATED] }, server.client);
    expect(outcomeFor(report, SELF)).toMatchObject({ _tag: "Passed", note: undefined });
    expect(outcomeFor(report, RELATED)).toMatchObject({ _tag: "Passed", note: undefined });
    expect(server.paths()).toContain("/articles/1/author");
    expect(server.paths().filter((path) => path.startsWith("/1"))).toEqual([]);
  });

  it("names a link with no origin of its own by its scheme", async () => {
    const note = await noteOf(
      SELF,
      linked({ self: (id) => (id === "2" ? "javascript:alert(1)" : `/articles/${id}`) }),
    );
    expect(note).toBe(
      "1 link not decided: the `self` link of articles:2 (in /articles, at /data/1) leads to a `javascript:` URL (no origin), which the kit does not follow",
    );
  });

  it("detects a link that is not a link, rendering it safely", async () => {
    const found = await failureOf(
      SELF,
      linked({ self: (id) => (id === "2" ? { toString: 1 } : `/articles/${id}`) }),
    );
    expect(found).toEqual([
      'the `self` link of articles:2 (in /articles, at /data/1) is not a link the kit can follow | self: {"toString":1}',
    ]);
  });

  it("never follows a link to another origin, and says it did not", async () => {
    const server = recording(
      linked({
        self: (id) => (id === "2" ? "https://elsewhere.test/articles/2" : `/articles/${id}`),
      }),
    );
    const report = await verifyCanned(server.serve, { only: [SELF] }, server.client);
    expect(outcomeFor(report, SELF)).toMatchObject({
      _tag: "Passed",
      note: "1 link not decided: the `self` link of articles:2 (in /articles, at /data/1) leads to another origin, https://elsewhere.test, which the kit does not follow",
    });
    expect(server.urls.every((url) => url.startsWith("http://fixture.test/"))).toBe(true);
    expect(server.paths()).not.toContain("/articles/2");
  });

  it("follows an absolute link to the run's own origin", async () => {
    const server = recording(linked({ self: (id) => `http://fixture.test/articles/${id}` }));
    const report = await verifyCanned(server.serve, { only: [SELF] }, server.client);
    expect(outcomeFor(report, SELF)).toMatchObject({ _tag: "Passed", note: undefined });
    expect(server.paths()).toContain("/articles/2");
  });

  it("skips, naming the origin, when every link leads to another origin", async () => {
    const reason = await skipReasonOf(
      SELF,
      linked({ ids: ["1"], self: () => "http://fixture.test:8080/articles/1" }),
    );
    expect(reason).toBe(
      "no link could be followed to a verdict (the `self` link of articles:1 (in /articles/1, at /data) leads to another origin, http://fixture.test:8080, which the kit does not follow)",
    );
  });

  const unavailable: Canned = {
    status: 503,
    body: { errors: [{ status: "503", title: "Service Unavailable" }] },
  };
  const limited: Canned = {
    status: 429,
    body: { errors: [{ status: "429", title: "Too Many Requests" }] },
  };

  it.each([
    ["503", unavailable],
    ["500", { status: 500, body: { errors: [{ status: "500", title: "Internal Server Error" }] } }],
    ["429", limited],
    ["408", { status: 408, body: { errors: [{ status: "408", title: "Request Timeout" }] } }],
  ] as const satisfies ReadonlyArray<readonly [string, Canned]>)(
    "does not hold a %s against the link",
    async (status, answer) => {
      expect(await noteOf(SELF, at("/articles/2", answer))).toBe(
        `1 link not decided: the \`self\` link of articles:2 (in /articles, at /data/1) got ${status} — a server error, a rate limit, a request timeout or a lost response says nothing of the links`,
      );
      expect(await noteOf(RELATED, at("/articles/2/tags", answer))).toContain(
        `the \`related\` link of articles:2's \`tags\` (in /articles, at /data/1) got ${status}`,
      );
    },
  );

  it("does not hold a lost response against the link", async () => {
    const report = await run(linked(), (client) =>
      HttpClient.make((request) =>
        request.url.endsWith("/articles/2")
          ? Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request, description: "reset" }),
              }),
            )
          : client.execute(request),
      ),
    );
    expect(outcomeFor(report, SELF)).toMatchObject({
      _tag: "Passed",
      note: expect.stringContaining(
        "the `self` link of articles:2 (in /articles, at /data/1) got no response (",
      ),
    });
  });

  it("does not decide a link behind access control", async () => {
    const forbidden: Canned = { status: 403, body: { errors: [{ status: "403" }] } };
    expect(await noteOf(SELF, at("/articles/2", forbidden))).toBe(
      "1 link not decided: the `self` link of articles:2 (in /articles, at /data/1) answered 403 — access control is outside JSON:API, so a link the kit may not follow is not a broken one",
    );
  });

  it("skips, naming the budget, a crawl the budget cannot finish — never a partial pass", async () => {
    const ids = Arr.makeBy(250, (n) => `${n + 1}`);
    const server = recording(linked({ ids }));
    const report = await verifyCanned(server.serve, { only: [SELF] }, server.client);
    expect(server.urls).toHaveLength(200);
    expect(outcomeFor(report, SELF)).toMatchObject({
      _tag: "Skipped",
      reason:
        "the rule's budget of 200 requests ran out with 199 of 250 links followed — a partial crawl is not passed",
    });
  });

  it("still fails on what it found before the budget ran out", async () => {
    const ids = Arr.makeBy(250, (n) => `${n + 1}`);
    const found = await failureOf(
      SELF,
      linked({ ids, self: (id) => (id === "3" ? "/articles/4" : `/articles/${id}`) }),
    );
    expect(found).toEqual([
      "the `self` link of articles:3 (in /articles, at /data/2) answers a different resource as primary data | articles:4",
    ]);
  });

  it("skips, saying what it searched, when no resource carries a `self` or `related` link", async () => {
    expect(await skipReasonOf(SELF, conformantServe)).toBe(
      "no resource object in what the read endpoints answered carries a `self` link (searched /articles/1, /articles)",
    );
    expect(await skipReasonOf(RELATED, conformantServe)).toBe(
      "no relationship in what the read endpoints answered carries a `related` link (searched /articles/1, /articles)",
    );
  });

  it("names a read endpoint it could not search", async () => {
    expect(await skipReasonOf(SELF, at("/articles", unavailable, conformantServe))).toBe(
      "no resource object in what the read endpoints answered carries a `self` link (searched /articles/1, /articles: 503)",
    );
  });

  it("holds the real router to the rule, a link to no route included", async () => {
    // In process, a path no route serves is the router's 404 — as a deployed
    // server answers it — not a defect that kills the rule.
    const linksTo = (self: string) =>
      runOver(
        api,
        HttpApiBuilder.group(api, "articles", (handlers) =>
          handlers
            .handle("get", () => Effect.succeed(Handlers.data({ ...article, links: { self } })))
            .handle("list", () =>
              Effect.succeed(Handlers.collection([{ ...article, links: { self } }])),
            ),
        ).pipe(Layer.provideMerge(Middleware.layer)),
      )({ only: [SELF] });
    expect(outcomeFor(await linksTo("/articles/1"), SELF)).toMatchObject({ _tag: "Passed" });
    const report = await linksTo("/articles/1/moved");
    expect(findingsOf(outcomeFor(report, SELF))).toEqual([
      "the `self` link of articles:1 (in /articles/1, at /data) answered 404 | 404",
    ]);
  });

  it("holds `related` to answering resource data, and leaves identity to the SHOULD", async () => {
    // A to-one `related` answering another resource is resource data: the
    // MUST holds; only the SHOULD that compares it with the linkage fails.
    const report = await run(at("/articles/1/author", { body: { data: person("10") } }));
    expect(outcomeFor(report, RELATED)).toMatchObject({ _tag: "Passed", note: undefined });
    expect(findingsOf(outcomeFor(report, MATCHES))).toEqual([
      "the `related` link of articles:1's `author` (in /articles/1, at /data) answers a different resource from the one its linkage names | people:10",
    ]);
  });

  it("leaves a `related` that does not answer to the MUST, rather than reporting it twice", async () => {
    const report = await run(at("/articles/2/tags", notFound));
    expect(findingsOf(outcomeFor(report, RELATED))).toEqual([
      expect.stringMatching(
        /^the `related` link of articles:2's `tags` \(in \/articles, at \/data\/1\) answered 404 \| 404 /,
      ),
    ]);
    const related = outcomeFor(report, RELATED);
    expect(Predicate.isTagged(related, "Failed") && related.findings[0]?.expected).toBe(
      "a 2xx response with the related resource data as primary data",
    );
    expect(outcomeFor(report, MATCHES)).toMatchObject({
      _tag: "Passed",
      note: "1 link not decided: the `related` link of articles:2's `tags` (in /articles, at /data/1) answered 404, which `spec/links/related-dereferences` reports — there is no answer to compare with its linkage",
    });
    const malformed = await run(
      linked({
        ids: ["1"],
        tags: () => ({ links: { related: { toString: 1 } }, data: [{ type: "tags", id: "1" }] }),
      }),
    );
    expect(findingsOf(outcomeFor(malformed, RELATED))).toEqual([
      'the `related` link of articles:1\'s `tags` (in /articles/1, at /data) is not a link the kit can follow | related: {"toString":1}',
    ]);
    expect(outcomeFor(malformed, MATCHES)).toMatchObject({
      _tag: "Passed",
      note: "1 link not decided: the `related` link of articles:1's `tags` (in /articles/1, at /data) is not a link the kit can follow, which `spec/links/related-dereferences` reports — there is no answer to compare with its linkage",
    });
  });

  it("skips the SHOULD when no relationship carries linkage to compare", async () => {
    const linksOnly = (relation: string) => (id: string) => ({
      links: { related: `/articles/${id}/${relation}` },
    });
    expect(
      await skipReasonOf(MATCHES, linked({ author: linksOnly("author"), tags: linksOnly("tags") })),
    ).toBe(
      "no relationship in what the read endpoints answered carries both a `related` link and resource linkage (searched /articles/1, /articles)",
    );
  });

  it("does not decide a link whose claim it cannot identify, the self link's or the linkage's", async () => {
    // Each side is treated as an answer it cannot identify is: the link is not
    // decided, never followed against a claim with an item dropped from it.
    const toMany = linked({
      ids: ["1"],
      tags: (id) => ({
        links: { related: `/articles/${id}/tags` },
        data: [
          { type: "tags", id: "1" },
          { type: "tags", id: 2 },
        ],
      }),
    });
    expect(await noteOf(MATCHES, toMany)).toBe(
      "1 link not decided: the `related` link of articles:1's `tags` (in /articles/1, at /data) — its linkage names 1 item without a string `type` and `id`, so there is nothing to hold the answer to",
    );
    const toOne = at(
      "/articles/1/author",
      { body: { data: person("10") } },
      linked({
        ids: ["1"],
        author: (id) => ({
          links: { related: `/articles/${id}/author` },
          data: { type: "people", id: 9 },
        }),
      }),
    );
    expect(await noteOf(MATCHES, toOne)).toBe(
      "1 link not decided: the `related` link of articles:1's `author` (in /articles/1, at /data) — its linkage names 1 item without a string `type` and `id`, so there is nothing to hold the answer to",
    );
    const article = articleOf({});
    const unidentified = at("/articles", {
      body: { data: [article("1"), { type: "articles", id: 2, links: { self: "/articles/2" } }] },
    });
    expect(await noteOf(SELF, unidentified)).toBe(
      "1 link not decided: the `self` link of articles:2 (in /articles, at /data/1) — the resource carrying it has no string `type` and `id` to hold the answer to",
    );
  });

  it("lists the first ten findings, counts the rest, and quotes the labels it names", async () => {
    const ids = Arr.makeBy(25, (n) => `${n + 1}`);
    const found = await failureOf(SELF, linked({ ids, self: () => "/articles/1" }));
    expect(found).toHaveLength(11);
    expect(found[0]).toBe(
      "the `self` link of articles:2 (in /articles, at /data/1) answers a different resource as primary data | articles:1",
    );
    expect(found[10]).toBe(
      "14 more links broke the rule; only the first 10 are listed | 14 further findings, not listed",
    );
    // A resource label is a server value, so it is quoted as one: cut to 200
    // UTF-16 code units, never carried whole into every finding.
    const long = "x".repeat(300);
    const named = await failureOf(
      SELF,
      linked({ ids: ["1", long], self: (id) => (id === long ? "/articles/1" : `/articles/${id}`) }),
    );
    expect(named).toEqual([
      `the \`self\` link of ${`articles:${long}`.slice(0, 199)}… (in /articles, at /data/1) answers a different resource as primary data | articles:1`,
    ]);
  });

  it("collects links from every read endpoint answering resource objects, and only those", async () => {
    // A related endpoint's answer is searched; a relationship endpoint, which
    // answers identifiers, is not requested at all.
    const reads = HttpApi.make("reads").add(
      Group.make(
        Article,
        Endpoint.get(Article),
        Endpoint.related(Article, "author"),
        Endpoint.getRelationship(Article, "author"),
      ),
    );
    const seen: Array<string> = [];
    const report = await verifyOver(reads)(
      (request) => {
        seen.push(request.path);
        return Match.value(withoutQuery(request).path).pipe(
          Match.when("/articles/1", (): Canned => ({
            body: { data: { type: "articles", id: "1" } },
          })),
          Match.when("/articles/1/author", (): Canned => ({
            body: { data: { ...person("9"), links: { self: "/people/9" } } },
          })),
          Match.when("/people/9", (): Canned => ({ body: { data: person("9") } })),
          Match.orElse((): Canned => ({
            body: { data: { type: "people", id: "9", links: { self: "/people/404" } } },
          })),
        );
      },
      { only: [SELF] },
    );
    expect(outcomeFor(report, SELF)).toMatchObject({ _tag: "Passed", note: undefined });
    expect(seen).toEqual(["/articles/1", "/articles/1/author", "/people/9"]);
  });

  it("skips, naming the budget, when it runs out before every read endpoint is searched", async () => {
    // 201 list endpoints: the budget fetches 200 of them. The one link they
    // carry leads to a URL already fetched, so it costs nothing and holds —
    // but the last endpoint was never searched, so the crawl is partial.
    const many = Arr.makeBy(201, (n) => Resource.make(`r${n}`, { attributes: {} }));
    const wide = HttpApi.make("wide").add(
      ...Arr.map(many, (resource) => Group.make(resource, Endpoint.list(resource))),
    );
    const seen: Array<string> = [];
    const report = await verifyOver(wide)(
      (request) => {
        seen.push(request.path);
        return request.path === "/r0"
          ? { body: { data: [{ type: "r0", id: "1", links: { self: "/r1" } }] } }
          : request.path === "/r1"
            ? { body: { data: { type: "r0", id: "1" } } }
            : { body: { data: [] } };
      },
      { only: [SELF] },
    );
    expect(seen).toHaveLength(200);
    expect(outcomeFor(report, SELF)).toMatchObject({
      _tag: "Skipped",
      reason:
        "the rule's budget of 200 requests ran out with 200 of 201 read endpoints searched for links — a partial crawl is not passed",
    });
  });

  it("counts a read endpoint whose URL does not resolve as not searched", async () => {
    // 202 list endpoints, one of them given a path that is no URL: the budget
    // fetches 200 of the other 201, so 200 were searched — not 201.
    const many = Arr.makeBy(202, (n) => Resource.make(`r${n}`, { attributes: {} }));
    const wide = HttpApi.make("wide").add(
      ...Arr.map(many, (resource) => Group.make(resource, Endpoint.list(resource))),
    );
    const report = await verifyOver(wide)(() => ({ body: { data: [] } }), {
      only: [SELF],
      paths: { "r201.list": "http://[" },
    });
    expect(outcomeFor(report, SELF)).toMatchObject({
      _tag: "Skipped",
      reason:
        "the rule's budget of 200 requests ran out with 200 of 202 read endpoints searched for links — a partial crawl is not passed",
    });
  });

  /** A JSON body for a hand-built `Response`. */
  const jsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

  /**
   * A `fetch` over `linked()` that follows a redirect unless told not to, as
   * the platform's does: `/articles/2` redirects to `elsewhere`. It records
   * every URL it was sent and the `credentials` each request carried.
   */
  const redirectingFetch = (elsewhere: string) => {
    const sent: Array<string> = [];
    const credentials: Array<string> = [];
    const respond = (url: URL): Response => {
      const canned = linked()({
        method: "GET",
        path: `${url.pathname}${url.search}`,
        headers: new Headers(),
      });
      return new Response(jsonText(canned.body), {
        status: canned.status ?? 200,
        headers: { "content-type": MEDIA_TYPE },
      });
    };
    const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input);
      sent.push(url.href);
      credentials.push(init?.credentials ?? "(none)");
      if (url.pathname !== "/articles/2") return Promise.resolve(respond(url));
      if (init?.redirect === "manual") {
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: elsewhere } }),
        );
      }
      sent.push(elsewhere);
      return Promise.resolve(respond(new URL(elsewhere)));
    };
    return { sent, credentials, fetch };
  };

  /** A `self` run over `fetch`, with `init` as the run's own `RequestInit`. */
  const overFetch = (
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
    init: RequestInit,
  ) =>
    Effect.runPromiseExit(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return yield* Conformance.verifyWith(api, {
          client,
          baseUrl: "http://fixture.test",
          ids: { articles: "1" },
          only: [SELF],
        });
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.provideService(FetchHttpClient.RequestInit, init),
      ),
    ).then((exit) => {
      if (Exit.isFailure(exit)) return expect.unreachable(Cause.pretty(exit.cause));
      return exit.value;
    });

  it("never sends a request off the run's origin on a redirect's say-so, and does not decide the rule", async () => {
    const elsewhere = "https://elsewhere.test/articles/2";
    const { sent, credentials, fetch } = redirectingFetch(elsewhere);
    // The run's own `RequestInit` is kept; only `redirect` is overridden.
    const report = await overFetch(fetch, { credentials: "include" });
    expect(sent.filter((url) => !url.startsWith("http://fixture.test/"))).toEqual([]);
    expect(credentials.every((value) => value === "include")).toBe(true);
    expect(outcomeFor(report, SELF)).toMatchObject({
      _tag: "Skipped",
      reason: `not decided: 1 of 3 requests the rule sent were answered by a redirect the kit does not follow or read (GET /articles/2 answered ${offsite("/articles/2")}), and a rule is not passed on the answers it did read alone; the rule's own note: 1 link not decided: the \`self\` link of articles:2 (in /articles, at /data/1) answered ${offsite("/articles/2")}`,
    });
  });

  it("keeps redirects off the transport even when the run's `RequestInit` says to follow them", async () => {
    // `redirect: "manual"` is applied over the run's own `RequestInit`, never
    // under it: a run that asks `fetch` to follow cannot let it.
    const { sent, fetch } = redirectingFetch("https://elsewhere.test/articles/2");
    const report = await overFetch(fetch, { redirect: "follow", credentials: "include" });
    expect(sent.filter((url) => !url.startsWith("http://fixture.test/"))).toEqual([]);
    expect(outcomeFor(report, SELF)).toMatchObject({
      _tag: "Skipped",
      reason: expect.stringContaining(
        "answered a 302 redirect to https://elsewhere.test/articles/2",
      ),
    });
  });

  /** `serve`, with `from` redirecting (`status`) to `to`. */
  const redirecting =
    (
      from: string,
      to: string,
      serve: (request: CannedRequest) => Canned = linked(),
      status = 302,
    ) =>
    (request: CannedRequest): Canned =>
      withoutQuery(request).path === from ? { status, headers: { location: to } } : serve(request);

  it("skips — never passes — a rule a `self` link redirected off the origin left undecided", async () => {
    // Every other link decides; the one that leaves the origin is not passed over.
    expect(
      await skipReasonOf(SELF, redirecting("/articles/2", "https://elsewhere.test/articles/2")),
    ).toContain(`/articles/2 answered ${offsite("/articles/2")}`);
  });

  it("skips, naming the redirect, a rule whose read endpoint a redirect took off the origin", async () => {
    // `/articles` leaves; `/articles/1` answers, and its links all decide.
    expect(
      await skipReasonOf(SELF, redirecting("/articles", "https://elsewhere.test/articles")),
    ).toContain(`GET /articles answered ${offsite("/articles")}`);
  });

  it("follows a redirect that stays on the run's origin, grading the final answer, and counts the hop", async () => {
    const plain = recording(linked());
    const direct = await run(plain.serve, plain.client);
    const hopped = recording(
      redirecting(
        "/old/2",
        "/articles/2",
        linked({ self: (id) => (id === "2" ? "/old/2" : `/articles/${id}`) }),
      ),
    );
    const report = await run(hopped.serve, hopped.client);
    expect(outcomeFor(report, SELF)).toMatchObject({ _tag: "Passed", note: undefined });
    expect(hopped.paths()).toContain("/old/2");
    expect(hopped.urls.every((url) => url.startsWith("http://fixture.test/"))).toBe(true);
    // The hop is a request of its own, counted against the rule's budget.
    const probesOf = (outcome: Conformance.Outcome) =>
      Predicate.isTagged(outcome, "Passed") ? outcome.probes : -1;
    expect(probesOf(outcomeFor(report, SELF))).toBe(probesOf(outcomeFor(direct, SELF)) + 1);
    // What the redirect leads to is what is graded.
    expect(
      await failureOf(
        SELF,
        redirecting(
          "/old/2",
          "/articles/1",
          linked({ self: (id) => (id === "2" ? "/old/2" : `/articles/${id}`) }),
        ),
      ),
    ).toEqual([
      "the `self` link of articles:2 (in /articles, at /data/1) answers a different resource as primary data | articles:1",
    ]);
  });

  it("treats an http → https redirect on the same host as a redirect to another origin", async () => {
    const hopped = recording(redirecting("/articles/2", "https://fixture.test/articles/2"));
    expect(await skipReasonOf(SELF, hopped.serve)).toContain(
      "the `self` link of articles:2 (in /articles, at /data/1) answered a 302 redirect to https://fixture.test/articles/2, which the kit does not follow: https://fixture.test is another origin than the base URL's, http://fixture.test — the kit follows a redirect only within the base URL's origin, and a change of scheme or port is a change of origin",
    );
    const report = await run(hopped.serve, hopped.client);
    expect(hopped.urls.filter((url) => url.startsWith("https:"))).toEqual([]);
    expect(outcomeFor(report, SELF)._tag).toBe("Skipped");
  });

  it("follows at most five redirects for one link, naming the one it stopped at", async () => {
    // `/hop/n` redirects to `/hop/n+1`, until `/hop/<end>` redirects to the article.
    const chain =
      (end: number) =>
      (request: CannedRequest): Canned => {
        const match = /^\/hop\/(\d+)$/.exec(withoutQuery(request).path);
        if (match === null)
          return linked({ self: (id) => (id === "2" ? "/hop/1" : `/articles/${id}`) })(request);
        const n = Number(match[1]);
        return { status: 307, headers: { location: n === end ? "/articles/2" : `/hop/${n + 1}` } };
      };
    // Five hops: /hop/1 … /hop/5, then the article.
    expect(await noteOf(SELF, chain(5))).toBeUndefined();
    expect(await skipReasonOf(SELF, chain(6))).toContain(
      "the `self` link of articles:2 (in /articles, at /data/1) answered a 307 redirect to http://fixture.test/articles/2, which the kit does not follow: it would be redirect 6 in a row, past the kit's cap of 5",
    );
  });

  it("resolves a relative link in a redirected answer against where the answer came from", async () => {
    // `/articles` redirects to `/v1/articles`, which redirects to
    // `/v2/articles`, whose `self` links are relative: `articles/1` resolves
    // against the last hop, `/v2/articles/1` — not the first hop's
    // `/v1/articles/1`, nor the requested `/articles/1`.
    const v2 = (request: CannedRequest): Canned => {
      const path = withoutQuery(request).path;
      if (path === "/articles") return { status: 308, headers: { location: "/v1/articles" } };
      if (path === "/v1/articles") return { status: 308, headers: { location: "/v2/articles" } };
      if (path === "/v2/articles") {
        return { body: { data: [{ type: "articles", id: "1", links: { self: "articles/1" } }] } };
      }
      if (path === "/v2/articles/1") return { body: { data: { type: "articles", id: "1" } } };
      return notFound;
    };
    expect(await noteOf(SELF, v2)).toBeUndefined();
  });

  it("holds `related` to answering resource data: a string or an array of strings is not", async () => {
    const answering = (data: Json) => at("/articles/2/author", { body: { data } });
    expect(await failureOf(RELATED, answering(["x"]))).toEqual([
      'the `related` link of articles:2\'s `author` (in /articles, at /data/1) answers no related resource data as primary data | 200 application/vnd.api+json — {"data":["x"]}',
    ]);
    expect(await failureOf(RELATED, answering("x"))).toEqual([
      'the `related` link of articles:2\'s `author` (in /articles, at /data/1) answers no related resource data as primary data | 200 application/vnd.api+json — {"data":"x"}',
    ]);
    // A resource object carries a string `type`.
    expect(await failureOf(RELATED, answering([{ id: "1" }]))).toEqual([
      'the `related` link of articles:2\'s `author` (in /articles, at /data/1) answers no related resource data as primary data | 200 application/vnd.api+json — {"data":[{"id":"1"}]}',
    ]);
    // …and a `type` that is a string, not merely present.
    expect(await failureOf(RELATED, answering([{ type: 1, id: "1" }]))).toEqual([
      'the `related` link of articles:2\'s `author` (in /articles, at /data/1) answers no related resource data as primary data | 200 application/vnd.api+json — {"data":[{"type":1,"id":"1"}]}',
    ]);
    expect(await noteOf(RELATED, answering(null))).toBeUndefined();
  });

  it("quotes the label of a resource its linkage names", async () => {
    const long = "y".repeat(300);
    const found = await failureOf(
      MATCHES,
      linked({
        ids: ["1"],
        author: (id) => ({
          links: { related: `/articles/${id}/author` },
          data: { type: "people", id: long },
        }),
      }),
    );
    expect(found).toEqual([
      "the `related` link of articles:1's `author` (in /articles/1, at /data) answers a different resource from the one its linkage names | people:9",
    ]);
    const outcome = outcomeFor(
      await run(
        linked({
          ids: ["1"],
          author: (id) => ({
            links: { related: `/articles/${id}/author` },
            data: { type: "people", id: long },
          }),
        }),
      ),
      MATCHES,
    );
    expect(Predicate.isTagged(outcome, "Failed") && outcome.findings[0]?.expected).toBe(
      `${`people:${long}`.slice(0, 199)}… as primary data`,
    );
  });

  it("does not read, or pass on the rest, an answer a transport fetched from another origin all the same", async () => {
    // A transport that follows redirects on its own (`HttpClient.followRedirects`,
    // say) reports where its answer came from.
    const report = await run(linked(), (client) =>
      HttpClient.make((request) =>
        request.url.endsWith("/articles/2")
          ? Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Object.defineProperty(
                  new Response(jsonText({ data: { type: "articles", id: "2" } }), {
                    headers: { "content-type": MEDIA_TYPE },
                  }),
                  "url",
                  { value: "https://elsewhere.test/articles/2" },
                ),
              ),
            )
          : client.execute(request),
      ),
    );
    // Not read, and so not decided — never a pass on the links the kit did read.
    expect(outcomeFor(report, SELF)).toEqual({
      _tag: "Skipped",
      rule: expect.anything(),
      reason: `not decided: 1 of 3 requests the rule sent were answered by a redirect the kit does not follow or read (GET /articles/2 answered ${followed("/articles/2")}), and a rule is not passed on the answers it did read alone; the rule's own note: 1 link not decided: the \`self\` link of articles:2 (in /articles, at /data/1) answered ${followed("/articles/2")}`,
    });
  });

  it("is in the spec tier, at the specification's level, and closes its coverage gap", () => {
    expect(Conformance.rules.find(({ id }) => id === SELF)).toMatchObject({
      tier: "spec",
      level: "MUST",
      reference: "https://jsonapi.org/format/1.1/#document-resource-object-links",
    });
    expect(Conformance.rules.find(({ id }) => id === RELATED)).toMatchObject({
      tier: "spec",
      level: "MUST",
      section: "Fetching Resources",
      reference: "https://jsonapi.org/format/1.1/#fetching-resources",
    });
    // The spec says what a `related` link answers in prose without a keyword,
    // so the comparison with the linkage is graded SHOULD (owner, #312).
    expect(Conformance.rules.find(({ id }) => id === MATCHES)).toMatchObject({
      tier: "spec",
      level: "SHOULD",
      section: "Related Resource Links",
      reference: "https://jsonapi.org/format/1.1/#document-resource-object-related-resource-links",
    });
    expect(Conformance.rules.find(({ id }) => id === RELATIONSHIP_SELF)).toMatchObject({
      tier: "spec",
      level: "MUST",
      section: "Fetching Relationships",
      reference: "https://jsonapi.org/format/1.1/#fetching-relationships",
    });
    // A relationship link answering the relationship's own identifiers is
    // §Relationships' definition, without a keyword: a SHOULD (owner, #309).
    expect(Conformance.rules.find(({ id }) => id === RELATIONSHIP_MATCHES)).toMatchObject({
      tier: "spec",
      level: "SHOULD",
      section: "Relationships",
      reference: "https://jsonapi.org/format/1.1/#document-resource-object-relationships",
    });
    expect(Conformance.rules.find(({ id }) => id === TOP_SELF)).toMatchObject({
      tier: "spec",
      level: "MUST",
      section: "Fetching Resources",
      reference: "https://jsonapi.org/format/1.1/#fetching-resources",
    });
    // So is a top-level `self` answering the same document (owner, #309).
    expect(Conformance.rules.find(({ id }) => id === TOP_MATCHES)).toMatchObject({
      tier: "spec",
      level: "SHOULD",
      section: "Document Top Level",
      reference: "https://jsonapi.org/format/1.1/#document-top-level",
    });
    expect(
      Conformance.rules.map(({ id }) => id).filter((id) => id.startsWith("spec/links/")),
    ).toEqual(LINK_RULES);
    expect(Conformance.gaps.map(({ area }) => area)).not.toContain("Link dereferenceability");
    // The narrower gap #168 declared in its place is closed too (#309).
    expect(Conformance.gaps.map(({ area }) => area)).not.toContain(
      "Relationship and top-level `self` links",
    );
    expect(Conformance.gaps.flatMap(({ tracking }) => tracking)).not.toContain("#309");
  });

  it('leaves every link rule out under `skip: ["spec/links/"]`', async () => {
    const server = recording(linked());
    const report = await verifyCanned(server.serve, { skip: ["spec/links/"] }, server.client);
    expect(report.outcomes.filter(({ rule }) => rule.id.startsWith("spec/links/"))).toEqual([]);
    // Without it, all seven run — the two SHOULDs #309 split off included.
    const all = await verifyCanned(server.serve, {}, server.client);
    expect(
      all.outcomes.map(({ rule }) => rule.id).filter((id) => id.startsWith("spec/links/")),
    ).toEqual(LINK_RULES);
  });

  // -------------------------------------------------------------------------
  // A relationship's own `self` link (#309)
  // -------------------------------------------------------------------------

  /** The relationship-`self` MUST's findings against `serve`. */
  const relationshipFailures = (serve: (request: CannedRequest) => Canned) =>
    failureOf(RELATIONSHIP_SELF, serve);

  /**
   * The relationship-`self` SHOULD's findings against `serve`, asserting the
   * MUST passes the same answers: an identifier mismatch is the SHOULD's alone.
   */
  const linkageMismatches = async (serve: (request: CannedRequest) => Canned) => {
    const report = await run(serve);
    expect(outcomeFor(report, RELATIONSHIP_SELF)).toMatchObject({ _tag: "Passed" });
    return findingsOf(outcomeFor(report, RELATIONSHIP_MATCHES));
  };

  it("follows every relationship's `self` link, once each, and passes", async () => {
    const server = recording(linked());
    const report = await verifyCanned(server.serve, { only: [RELATIONSHIP_SELF] }, server.client);
    const outcome = outcomeFor(report, RELATIONSHIP_SELF);
    expect(outcome).toMatchObject({ _tag: "Passed", note: undefined, probes: 8 });
    expect(server.paths()).toEqual([
      "/articles/1",
      "/articles",
      "/articles/1/relationships/author",
      "/articles/1/relationships/tags",
      "/articles/1/relationships/comments",
      "/articles/2/relationships/author",
      "/articles/2/relationships/tags",
      "/articles/2/relationships/comments",
    ]);
    // The SHOULD follows the same links, less the links-only `comments`.
    const matches = recording(linked());
    const compared = await verifyCanned(
      matches.serve,
      { only: [RELATIONSHIP_MATCHES] },
      matches.client,
    );
    expect(outcomeFor(compared, RELATIONSHIP_MATCHES)).toMatchObject({
      _tag: "Passed",
      note: undefined,
      probes: 6,
    });
    expect(matches.paths().filter((path) => path.endsWith("/comments"))).toEqual([]);
  });

  it("detects a relationship `self` whose linkage omits an identifier the relationship names", async () => {
    expect(
      await linkageMismatches(
        at("/articles/2/relationships/tags", { body: { data: [{ type: "tags", id: "1" }] } }),
      ),
    ).toEqual([
      "the `self` link of articles:2's `tags` (in /articles, at /data/1) answers without 1 resource its linkage names | missing: tags:2",
    ]);
  });

  it("detects a relationship `self` whose linkage names an identifier the relationship does not", async () => {
    expect(
      await linkageMismatches(
        at("/articles/2/relationships/tags", {
          body: {
            data: [
              { type: "tags", id: "1" },
              { type: "tags", id: "2" },
              { type: "tags", id: "3" },
            ],
          },
        }),
      ),
    ).toEqual([
      "the `self` link of articles:2's `tags` (in /articles, at /data/1) answers 1 resource its linkage does not name | not in the linkage: tags:3",
    ]);
  });

  it("detects a to-one relationship `self` whose linkage is a different identifier", async () => {
    expect(
      await linkageMismatches(
        at("/articles/1/relationships/author", { body: { data: { type: "people", id: "10" } } }),
      ),
    ).toEqual([
      "the `self` link of articles:1's `author` (in /articles/1, at /data) answers a different resource from the one its linkage names | people:10",
    ]);
  });

  it("detects a relationship `self` that answers no resource linkage, linkage or not", async () => {
    // With linkage to compare (`tags`), and without (the links-only `comments`).
    const tags = await relationshipFailures(
      at("/articles/2/relationships/tags", { body: { meta: { total: 2 } } }),
    );
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatch(
      /^the `self` link of articles:2's `tags` \(in \/articles, at \/data\/1\) answers no resource linkage as primary data \| 200 /,
    );
    const outcome = outcomeFor(
      await run(at("/articles/2/relationships/comments", { body: { data: ["x"] } })),
      RELATIONSHIP_SELF,
    );
    expect(outcome).toMatchObject({
      _tag: "Failed",
      findings: [
        {
          detail:
            "the `self` link of articles:2's `comments` (in /articles, at /data/1) answers no resource linkage as primary data",
          expected: "`null`, a resource identifier or an array of them as primary data",
        },
      ],
    });
  });

  it("detects a relationship `self` that leads to a 404", async () => {
    const found = await relationshipFailures(at("/articles/2/relationships/tags", notFound));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(
      /^the `self` link of articles:2's `tags` \(in \/articles, at \/data\/1\) answered 404 \| 404 /,
    );
    const outcome = outcomeFor(
      await run(at("/articles/2/relationships/tags", notFound)),
      RELATIONSHIP_SELF,
    );
    // The MUST holds the answer to being resource linkage, not to naming the
    // relationship's own identifiers, and says so whether the relationship
    // carries linkage (`tags`) or only links (`comments`).
    expect(Predicate.isTagged(outcome, "Failed") && outcome.findings[0]?.expected).toBe(
      "a 2xx response with resource linkage as primary data",
    );
    const linksOnly = outcomeFor(
      await run(at("/articles/2/relationships/comments", notFound)),
      RELATIONSHIP_SELF,
    );
    expect(Predicate.isTagged(linksOnly, "Failed") && linksOnly.findings).toEqual([
      expect.objectContaining({
        detail: expect.stringContaining("articles:2's `comments`"),
        expected: "a 2xx response with resource linkage as primary data",
      }),
    ]);
    // The SHOULD leaves it to the MUST rather than reporting it twice.
    expect(
      outcomeFor(await run(at("/articles/2/relationships/tags", notFound)), RELATIONSHIP_MATCHES),
    ).toMatchObject({
      _tag: "Passed",
      note: expect.stringMatching(
        /^1 link not decided: the `self` link of articles:2's `tags` \(in \/articles, at \/data\/1\) answered 404, which `spec\/links\/relationship-self-dereferences` reports — there is no answer to compare with its linkage$/,
      ),
    });
  });

  it("holds a page of linkage, either side, as a subset — as `related-matches-linkage` does", async () => {
    const paged = (data: ReadonlyArray<Json>): Canned => ({
      body: { data, links: { next: "/articles/2/relationships/tags?page[offset]=1" } },
    });
    expect(
      await noteOf(
        RELATIONSHIP_MATCHES,
        at("/articles/2/relationships/tags", paged([{ type: "tags", id: "1" }])),
      ),
    ).toBeUndefined();
    expect(
      await linkageMismatches(
        at("/articles/2/relationships/tags", paged([{ type: "tags", id: "3" }])),
      ),
    ).toEqual([
      "the `self` link of articles:2's `tags` (in /articles, at /data/1) answers 1 resource its linkage does not name | not in the linkage: tags:3",
    ]);
  });

  it("fails a relationship `self` answering resource objects, not identifiers — the MUST, not the SHOULD", async () => {
    // To-many linkage, to-one linkage, and a links-only relationship, each
    // answered by full resource objects where identifiers belong.
    const report = await run(
      at(
        "/articles/2/relationships/tags",
        { body: { data: [tag("1"), tag("2")] } },
        at(
          "/articles/1/relationships/author",
          { body: { data: person("9") } },
          at("/articles/2/relationships/comments", { body: { data: [comment("5")] } }),
        ),
      ),
    );
    expect(findingsOf(outcomeFor(report, RELATIONSHIP_SELF))).toEqual([
      "the `self` link of articles:1's `author` (in /articles/1, at /data) answers no resource linkage as primary data | /data carries `attributes`, which a resource identifier object does not",
      "the `self` link of articles:2's `tags` (in /articles, at /data/1) answers no resource linkage as primary data | /data/0 carries `attributes`, which a resource identifier object does not",
      "the `self` link of articles:2's `comments` (in /articles, at /data/1) answers no resource linkage as primary data | /data/0 carries `attributes`, which a resource identifier object does not",
    ]);
    // The SHOULD names the same identifiers either way, so it leaves both
    // links to the MUST (and never follows the links-only `comments`).
    expect(outcomeFor(report, RELATIONSHIP_MATCHES)).toMatchObject({
      _tag: "Passed",
      note: "2 links not decided: the `self` link of articles:1's `author` (in /articles/1, at /data) answers no resource linkage as primary data, which `spec/links/relationship-self-dereferences` reports — there is no answer to compare with its linkage; the `self` link of articles:2's `tags` (in /articles, at /data/1) answers no resource linkage as primary data, which `spec/links/relationship-self-dereferences` reports — there is no answer to compare with its linkage",
    });
    // An identifier carrying `links` or `relationships` is no identifier either.
    expect(
      await relationshipFailures(
        at("/articles/2/relationships/tags", {
          body: {
            data: [
              { type: "tags", id: "1" },
              { type: "tags", id: "2", links: { self: "/tags/2" }, relationships: {} },
            ],
          },
        }),
      ),
    ).toEqual([
      "the `self` link of articles:2's `tags` (in /articles, at /data/1) answers no resource linkage as primary data | /data/1 carries `links`, `relationships`, which a resource identifier object does not",
    ]);
  });

  it("holds a relationship `self` to identifiers with a `type` and an `id`, and `lid` and `meta` at most", async () => {
    expect(
      await relationshipFailures(
        at("/articles/2/relationships/tags", { body: { data: [{ type: "tags" }] } }),
      ),
    ).toEqual([
      "the `self` link of articles:2's `tags` (in /articles, at /data/1) answers no resource linkage as primary data | /data/0 has no string `id`",
    ]);
    // A `lid` stands for a resource not yet assigned an `id`; what a
    // relationship's `self` answers is stored, so it names each by `id`. The
    // SHOULD leaves the link to the MUST.
    const lidOnly = await run(
      at("/articles/2/relationships/tags", {
        body: {
          data: [
            { type: "tags", id: "1" },
            { type: "tags", lid: "local-2" },
          ],
        },
      }),
    );
    expect(findingsOf(outcomeFor(lidOnly, RELATIONSHIP_SELF))).toEqual([
      "the `self` link of articles:2's `tags` (in /articles, at /data/1) answers no resource linkage as primary data | /data/1 has a `lid` but no string `id`",
    ]);
    expect(outcomeFor(lidOnly, RELATIONSHIP_MATCHES)).toMatchObject({
      _tag: "Passed",
      note: "1 link not decided: the `self` link of articles:2's `tags` (in /articles, at /data/1) answers no resource linkage as primary data, which `spec/links/relationship-self-dereferences` reports — there is no answer to compare with its linkage",
    });
    expect(
      await relationshipFailures(
        at("/articles/2/relationships/tags", { body: { data: [{ id: "1" }, "x"] } }),
      ),
    ).toEqual([
      "the `self` link of articles:2's `tags` (in /articles, at /data/1) answers no resource linkage as primary data | /data/0 has no string `type`",
    ]);
    expect(
      await relationshipFailures(
        at("/articles/1/relationships/author", { body: { data: "people:9" } }),
      ),
    ).toEqual([
      "the `self` link of articles:1's `author` (in /articles/1, at /data) answers no resource linkage as primary data | `data: people:9`",
    ]);
    // `meta` is an identifier's own member, and a `lid` may stand beside the
    // `id`. An @-member, which §Member Names has a processor ignore, and an
    // extension member (`ns:member`) are not the base specification's to
    // judge, so neither is a member that does not belong.
    const report = await run(
      at("/articles/2/relationships/tags", {
        body: {
          data: [
            { type: "tags", id: "1", meta: { primary: true }, "@foo": "bar" },
            { type: "tags", id: "2", lid: "local-2", "version:id": "3" },
          ],
        },
      }),
    );
    expect(outcomeFor(report, RELATIONSHIP_SELF)).toMatchObject({
      _tag: "Passed",
      note: undefined,
    });
    expect(outcomeFor(report, RELATIONSHIP_MATCHES)).toMatchObject({
      _tag: "Passed",
      note: undefined,
    });
  });

  it("counts a member against an identifier when it is no extension member's name", async () => {
    // An extension member is an alphanumeric namespace, one colon and a name;
    // a colon anywhere else does not make one.
    const failures = await Promise.all(
      [":x", "a:", "a:b:c"].map((member) =>
        relationshipFailures(
          at("/articles/2/relationships/tags", {
            body: { data: [{ type: "tags", id: "1", [member]: "v" }] },
          }),
        ),
      ),
    );
    expect(failures).toEqual(
      [":x", "a:", "a:b:c"].map((member) => [
        `the \`self\` link of articles:2's \`tags\` (in /articles, at /data/1) answers no resource linkage as primary data | /data/0 carries \`${member}\`, which a resource identifier object does not`,
      ]),
    );
  });

  it("fails a relationship `self` answering linkage of the wrong cardinality — the MUST, not the SHOULD", async () => {
    const report = await run(
      at(
        "/articles/2/relationships/tags",
        { body: { data: { type: "tags", id: "1" } } },
        at("/articles/1/relationships/author", { body: { data: [{ type: "people", id: "9" }] } }),
      ),
    );
    expect(findingsOf(outcomeFor(report, RELATIONSHIP_SELF))).toEqual([
      'the `self` link of articles:1\'s `author` (in /articles/1, at /data) answers to-many linkage (an array of resource identifiers) where the relationship is to-one | `data: [{"type":"people","id":"9"}]`',
      "the `self` link of articles:2's `tags` (in /articles, at /data/1) answers to-one linkage (`null` or a resource identifier) where the relationship is to-many | tags:1",
    ]);
    const outcome = outcomeFor(report, RELATIONSHIP_SELF);
    expect(
      Predicate.isTagged(outcome, "Failed") && outcome.findings.map(({ expected }) => expected),
    ).toEqual([
      "`null` or a resource identifier as primary data, as the relationship's to-one linkage is",
      "an array of resource identifiers as primary data, as the relationship's to-many linkage is",
    ]);
    expect(outcomeFor(report, RELATIONSHIP_MATCHES)).toMatchObject({
      _tag: "Passed",
      note: expect.stringMatching(
        /^2 links not decided: .*answers to-many linkage .*which `spec\/links\/relationship-self-dereferences` reports.*answers to-one linkage .*which `spec\/links\/relationship-self-dereferences` reports/,
      ),
    });
    // `null` is to-one: the MUST holds, and only the SHOULD, comparing it with
    // the identifier the linkage names, fails.
    expect(
      await linkageMismatches(at("/articles/1/relationships/author", { body: { data: null } })),
    ).toEqual([
      "the `self` link of articles:1's `author` (in /articles/1, at /data) answers a different resource from the one its linkage names | `data: null`",
    ]);
    // A links-only relationship shows no cardinality, so either shape holds.
    expect(
      await noteOf(
        RELATIONSHIP_SELF,
        at("/articles/2/relationships/comments", { body: { data: { type: "comments", id: "5" } } }),
      ),
    ).toBeUndefined();
  });

  it("holds a links-only relationship's `self` to the cardinality its relationship endpoint declares", async () => {
    const Comment = Resource.make("comments", { attributes: { body: Schema.String } });
    const Paged = Resource.make("articles", {
      attributes: { title: Schema.NonEmptyString, body: Schema.String },
      relationships: {
        author: Relationship.one(() => Person),
        comments: Relationship.paginated(() => Comment),
      },
    });
    const declaring = (...relationships: ReadonlyArray<"author" | "comments">) =>
      verifyOver(
        HttpApi.make("declared").add(
          Group.make(
            Paged,
            Endpoint.get(Paged),
            Endpoint.list(Paged),
            ...relationships.map((name) => Endpoint.getRelationship(Paged, name)),
          ),
        ),
      );
    // `author` links-only too, beside the paginated `comments`.
    const linksOnlyAuthor = (id: string) => ({
      links: { self: `/articles/${id}/relationships/author` },
    });
    const wrong = at(
      "/articles/2/relationships/comments",
      { body: { data: { type: "comments", id: "5" } } },
      at(
        "/articles/1/relationships/author",
        { body: { data: [{ type: "people", id: "9" }] } },
        linked({ author: linksOnlyAuthor }),
      ),
    );
    const outcomeOver = async (
      verify: ReturnType<typeof declaring>,
      serve: (request: CannedRequest) => Canned,
    ) => outcomeFor(await verify(serve, { only: [RELATIONSHIP_SELF] }), RELATIONSHIP_SELF);

    // Answering what the endpoints declare — an array for the paginated
    // `comments`, one identifier for `author` — passes.
    expect(
      await outcomeOver(declaring("author", "comments"), linked({ author: linksOnlyAuthor })),
    ).toMatchObject({ _tag: "Passed", note: undefined });
    const authorFinding =
      'the `self` link of articles:1\'s `author` (in /articles/1, at /data) answers to-many linkage (an array of resource identifiers) where the relationship is to-one, as the relationship endpoint `articles.authorRelationship` (`GET /articles/:id/relationships/author`) declares | `data: [{"type":"people","id":"9"}]`';
    const outcome = await outcomeOver(declaring("author", "comments"), wrong);
    expect(findingsOf(outcome)).toEqual([
      authorFinding,
      "the `self` link of articles:2's `comments` (in /articles, at /data/1) answers to-one linkage (`null` or a resource identifier) where the relationship is to-many, as the relationship endpoint `articles.commentsRelationship` (`GET /articles/:id/relationships/comments`) declares | comments:5",
    ]);
    expect(
      Predicate.isTagged(outcome, "Failed") && outcome.findings.map(({ expected }) => expected),
    ).toEqual([
      "`null` or a resource identifier as primary data, as the success schema of `articles.authorRelationship` (`GET /articles/:id/relationships/author`), the relationship endpoint the link resolves to, declares",
      "an array of resource identifiers as primary data, as the success schema of `articles.commentsRelationship` (`GET /articles/:id/relationships/comments`), the relationship endpoint the link resolves to, declares",
    ]);

    // A link to no declared relationship endpoint shows no cardinality, so
    // either shape holds: here `comments`, with only `author` declared.
    expect(findingsOf(await outcomeOver(declaring("author"), wrong))).toEqual([authorFinding]);
    // Nor does an endpoint whose success schema says nothing of `data`.
    const unknown = verifyOver(
      HttpApi.make("hand-built").add(
        Group.make(Paged, Endpoint.get(Paged), Endpoint.list(Paged)),
        HttpApiGroup.make("linkage").add(
          HttpApiEndpoint.get("author", "/articles/:id/relationships/author", {
            success: Schema.Unknown,
          }),
          HttpApiEndpoint.get("comments", "/articles/:id/relationships/comments", {
            success: Schema.Unknown,
          }),
        ),
      ),
    );
    expect(await outcomeOver(unknown, wrong)).toMatchObject({ _tag: "Passed", note: undefined });
  });

  it("skips the relationship SHOULD when no relationship carries linkage to compare", async () => {
    const linksOnly = (relation: string) => (id: string) => ({
      links: { self: `/articles/${id}/relationships/${relation}` },
    });
    const serve = linked({ author: linksOnly("author"), tags: linksOnly("tags") });
    expect(await skipReasonOf(RELATIONSHIP_MATCHES, serve)).toBe(
      "no relationship in what the read endpoints answered carries both a `self` link and resource linkage (searched /articles/1, /articles)",
    );
    expect(await noteOf(RELATIONSHIP_SELF, serve)).toBeUndefined();
  });

  it("never follows a relationship `self` to another origin, and says it did not", async () => {
    const server = recording(
      linked({
        ids: ["1"],
        author: () => ({
          links: { self: "https://elsewhere.test/articles/1/relationships/author" },
          data: { type: "people", id: "9" },
        }),
      }),
    );
    const report = await verifyCanned(server.serve, { only: [RELATIONSHIP_SELF] }, server.client);
    expect(outcomeFor(report, RELATIONSHIP_SELF)).toMatchObject({
      _tag: "Passed",
      note: "1 link not decided: the `self` link of articles:1's `author` (in /articles/1, at /data) leads to another origin, https://elsewhere.test, which the kit does not follow",
    });
    expect(server.urls.every((url) => url.startsWith("http://fixture.test/"))).toBe(true);
  });

  it("does not hold a 503 against a relationship `self`", async () => {
    expect(await noteOf(RELATIONSHIP_SELF, at("/articles/2/relationships/tags", unavailable))).toBe(
      "1 link not decided: the `self` link of articles:2's `tags` (in /articles, at /data/1) got 503 — a server error, a rate limit, a request timeout or a lost response says nothing of the links",
    );
  });

  it("skips, naming the budget, a relationship crawl the budget cannot finish", async () => {
    const ids = Arr.makeBy(250, (n) => `${n + 1}`);
    const server = recording(linked({ ids }));
    const report = await verifyCanned(server.serve, { only: [RELATIONSHIP_SELF] }, server.client);
    expect(server.urls).toHaveLength(200);
    expect(outcomeFor(report, RELATIONSHIP_SELF)).toMatchObject({
      _tag: "Skipped",
      reason:
        "the rule's budget of 200 requests ran out with 198 of 750 links followed — a partial crawl is not passed",
    });
  });

  // -------------------------------------------------------------------------
  // A document's top-level `self` link (#309)
  // -------------------------------------------------------------------------

  /**
   * `linked()`, with the document at `path` carrying `self` as its top-level
   * `self` (its only top-level link, as on every document `linked()` answers).
   */
  const selfAt =
    (path: string, self: Json, serve: (request: CannedRequest) => Canned = linked()) =>
    (request: CannedRequest): Canned => {
      const answer = serve(request);
      if (withoutQuery(request).path !== path || !Predicate.isObject(answer.body)) return answer;
      return { ...answer, body: { ...answer.body, links: { self } } };
    };

  it("follows every document's top-level `self` link, and passes", async () => {
    const server = recording(selfAt("/articles", "/articles?sort=title"));
    const report = await verifyCanned(server.serve, { only: [TOP_SELF] }, server.client);
    // `/articles/1`'s own `self` is the URL it was fetched by, so it costs no request.
    expect(outcomeFor(report, TOP_SELF)).toMatchObject({
      _tag: "Passed",
      note: undefined,
      probes: 3,
    });
    expect(server.paths()).toEqual(["/articles/1", "/articles", "/articles"]);
    // The SHOULD follows the same links, and holds each to its document.
    const matches = recording(selfAt("/articles", "/articles?sort=title"));
    const compared = await verifyCanned(matches.serve, { only: [TOP_MATCHES] }, matches.client);
    expect(outcomeFor(compared, TOP_MATCHES)).toMatchObject({
      _tag: "Passed",
      note: undefined,
      probes: 3,
    });
    expect(matches.paths()).toEqual(server.paths());
  });

  it("holds a top-level `self` to answering resource data, and leaves identity to the SHOULD", async () => {
    // A different resource is resource data: the MUST holds, the SHOULD fails.
    const report = await run(selfAt("/articles/1", "/articles/2"));
    expect(outcomeFor(report, TOP_SELF)).toMatchObject({ _tag: "Passed", note: undefined });
    expect(findingsOf(outcomeFor(report, TOP_MATCHES))).toEqual([
      "the top-level `self` link of /articles/1 answers a different resource as primary data | articles:2",
    ]);
  });

  it("fails a top-level `self` that answers no resource data — the MUST, not the SHOULD", async () => {
    const answering = (answer: Canned) =>
      at("/everything", answer, selfAt("/articles", "/everything"));
    const unanswered = async (body: Json) => {
      const report = await run(answering({ body }));
      expect(outcomeFor(report, TOP_MATCHES)).toMatchObject({
        _tag: "Passed",
        note: "1 link not decided: the top-level `self` link of /articles answers no resource data as primary data, which `spec/links/top-level-self-dereferences` reports — there is no answer to compare with the document carrying it",
      });
      return findingsOf(outcomeFor(report, TOP_SELF));
    };
    const finding = (body: string) =>
      `the top-level \`self\` link of /articles answers no resource data as primary data | 200 application/vnd.api+json — ${body}`;
    expect(await unanswered({ meta: { total: 2 } })).toEqual([finding('{"meta":{"total":2}}')]);
    expect(await unanswered({ data: "x" })).toEqual([finding('{"data":"x"}')]);
    expect(await unanswered({ data: [{ id: "1" }] })).toEqual([finding('{"data":[{"id":"1"}]}')]);
    const outcome = outcomeFor(await run(answering({ body: { meta: {} } })), TOP_SELF);
    expect(Predicate.isTagged(outcome, "Failed") && outcome.findings[0]?.expected).toBe(
      "a resource object, an array of them or `null` as primary data",
    );
  });

  it("leaves a top-level `self` that does not answer to the MUST, rather than reporting it twice", async () => {
    const report = await run(selfAt("/articles/1", "/articles/one"));
    const outcome = outcomeFor(report, TOP_SELF);
    expect(Predicate.isTagged(outcome, "Failed") && outcome.findings[0]?.expected).toBe(
      "a 2xx response with resource data as primary data",
    );
    expect(outcomeFor(report, TOP_MATCHES)).toMatchObject({
      _tag: "Passed",
      note: "1 link not decided: the top-level `self` link of /articles/1 answered 404, which `spec/links/top-level-self-dereferences` reports — there is no answer to compare with the document carrying it",
    });
  });

  it("names the endpoints each `self` rule searches when the api declares none", async () => {
    const writesOnly = HttpApi.make("writes-only").add(
      Group.make(Article, Endpoint.create(Article)),
    );
    const report = await verifyOver(writesOnly)(() => notFound, { only: LINK_RULES });
    const resources = "no JSON:API endpoint answering resource objects in this api";
    const documents = "no JSON:API read endpoint answering a document in this api";
    expect(
      report.outcomes.map((outcome) =>
        Predicate.isTagged(outcome, "Skipped") ? outcome.reason : outcome._tag,
      ),
    ).toEqual([resources, resources, resources, resources, resources, documents, documents]);
    expect(report.outcomes.map(({ rule }) => rule.id)).toEqual(LINK_RULES);
  });

  it("detects a top-level `self` that leads to a different resource", async () => {
    expect(await failureOf(TOP_MATCHES, selfAt("/articles/1", "/articles/2"))).toEqual([
      "the top-level `self` link of /articles/1 answers a different resource as primary data | articles:2",
    ]);
  });

  it("detects a top-level `self` of a collection that answers no collection", async () => {
    expect(await failureOf(TOP_MATCHES, selfAt("/articles", "/articles/1"))).toEqual([
      "the top-level `self` link of /articles answers no resource collection as primary data | articles:1",
    ]);
  });

  it("detects a top-level `self` that leads to a 404", async () => {
    const found = await failureOf(TOP_SELF, selfAt("/articles/1", "/articles/one"));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^the top-level `self` link of \/articles\/1 answered 404 \| 404 /);
  });

  it("detects a top-level `self` of `null` that answers a resource", async () => {
    const serve = at("/articles/1", { body: { data: null, links: { self: "/articles/2" } } });
    expect(await failureOf(TOP_MATCHES, serve)).toEqual([
      "the top-level `self` link of /articles/1 answers a resource where the document carrying it has `null` | articles:2",
    ]);
  });

  it("holds a whole collection's `self` to the same resources, in any order", async () => {
    const article = articleOf({});
    const everything = (data: ReadonlyArray<Json>, links?: Json) =>
      at(
        "/everything",
        { body: links === undefined ? { data } : { data, links } },
        selfAt("/articles", "/everything"),
      );
    expect(await noteOf(TOP_MATCHES, everything([article("2"), article("1")]))).toBeUndefined();
    expect(await failureOf(TOP_MATCHES, everything([article("1")]))).toEqual([
      "the top-level `self` link of /articles answers without 1 resource the document carrying it lists | missing: articles:2",
    ]);
    expect(
      await failureOf(TOP_MATCHES, everything([article("1"), article("2"), article("3")])),
    ).toEqual([
      "the top-level `self` link of /articles answers 1 resource the document carrying it does not list | not in the document: articles:3",
    ]);
  });

  it("holds a page, either document's, only to answering a collection", async () => {
    const article = articleOf({});
    // The answer is a page: it need not list what the document does.
    expect(
      await noteOf(
        TOP_MATCHES,
        at(
          "/everything",
          { body: { data: [article("3")], links: { next: "/everything?page[offset]=1" } } },
          selfAt("/articles", "/everything"),
        ),
      ),
    ).toBeUndefined();
    // The document carrying the link is a page (`prev`): likewise.
    expect(
      await noteOf(
        TOP_MATCHES,
        at(
          "/everything",
          { body: { data: [article("3")] } },
          at("/articles", {
            body: {
              data: [article("1"), article("2")],
              links: { self: "/everything", prev: "/articles?page[offset]=0" },
            },
          }),
        ),
      ),
    ).toBeUndefined();
    // But a page is still a collection.
    expect(
      await failureOf(
        TOP_MATCHES,
        at(
          "/everything",
          { body: { data: article("3") } },
          at("/articles", {
            body: { data: [article("1")], links: { self: "/everything", next: "/articles?p=2" } },
          }),
        ),
      ),
    ).toEqual([
      "the top-level `self` link of /articles answers no resource collection as primary data | articles:3",
    ]);
  });

  it("never follows a top-level `self` to another origin, and says it did not", async () => {
    const server = recording(selfAt("/articles", "https://elsewhere.test/articles"));
    const report = await verifyCanned(server.serve, { only: [TOP_SELF] }, server.client);
    expect(outcomeFor(report, TOP_SELF)).toMatchObject({
      _tag: "Passed",
      note: "1 link not decided: the top-level `self` link of /articles leads to another origin, https://elsewhere.test, which the kit does not follow",
    });
    expect(server.urls.every((url) => url.startsWith("http://fixture.test/"))).toBe(true);
  });

  it("detects a top-level `self` that is not a link, and does not hold a 503 against one", async () => {
    expect(await failureOf(TOP_SELF, selfAt("/articles", { toString: 1 }))).toEqual([
      'the top-level `self` link of /articles is not a link the kit can follow | self: {"toString":1}',
    ]);
    expect(
      await noteOf(TOP_SELF, at("/elsewhere", unavailable, selfAt("/articles", "/elsewhere"))),
    ).toBe(
      "1 link not decided: the top-level `self` link of /articles got 503 — a server error, a rate limit, a request timeout or a lost response says nothing of the links",
    );
  });

  it("skips, saying what it searched, when no document carries a top-level `self`", async () => {
    expect(await skipReasonOf(TOP_SELF, conformantServe)).toBe(
      "no document a read endpoint answered carries a top-level `self` link (searched /articles/1, /articles)",
    );
  });

  it("follows a relationship endpoint's top-level `self` too, holding it to the same linkage", async () => {
    const reads = HttpApi.make("reads").add(
      Group.make(Article, Endpoint.get(Article), Endpoint.getRelationship(Article, "author")),
    );
    const linkageAt =
      (answer: Json) =>
      (request: CannedRequest): Canned =>
        Match.value(request.path).pipe(
          Match.when("/articles/1", (): Canned => ({
            body: { data: { type: "articles", id: "1" } },
          })),
          Match.when("/articles/1/relationships/author", (): Canned => ({
            body: {
              data: { type: "people", id: "9" },
              links: { self: "/articles/1/relationships/author?canonical=1" },
            },
          })),
          Match.when("/articles/1/relationships/author?canonical=1", (): Canned => ({
            body: { data: answer },
          })),
          Match.orElse(() => notFound),
        );
    const passed = await verifyOver(reads)(linkageAt({ type: "people", id: "9" }), {
      only: [TOP_SELF, TOP_MATCHES],
    });
    expect(outcomeFor(passed, TOP_MATCHES)).toMatchObject({ _tag: "Passed", probes: 3 });
    const report = await verifyOver(reads)(linkageAt({ type: "people", id: "10" }), {
      only: [TOP_SELF, TOP_MATCHES],
    });
    expect(findingsOf(outcomeFor(report, TOP_MATCHES))).toEqual([
      "the top-level `self` link of /articles/1/relationships/author answers a different resource as primary data | people:10",
    ]);
    // Another identifier is still resource data: the MUST holds.
    expect(outcomeFor(report, TOP_SELF)).toMatchObject({ _tag: "Passed", probes: 3 });
  });

  it("skips the top-level `self` rule, naming the budget, when it cannot search every read endpoint", async () => {
    const many = Arr.makeBy(201, (n) => Resource.make(`r${n}`, { attributes: {} }));
    const wide = HttpApi.make("wide").add(
      ...Arr.map(many, (resource) => Group.make(resource, Endpoint.list(resource))),
    );
    const seen: Array<string> = [];
    const report = await verifyOver(wide)(
      (request) => {
        seen.push(request.path);
        return { body: { data: [], links: { self: request.path } } };
      },
      { only: [TOP_SELF] },
    );
    expect(seen).toHaveLength(200);
    expect(outcomeFor(report, TOP_SELF)).toMatchObject({
      _tag: "Skipped",
      reason:
        "the rule's budget of 200 requests ran out with 200 of 201 read endpoints searched for links — a partial crawl is not passed",
    });
  });
});

// ---------------------------------------------------------------------------
// In-process: the same rules over the real router
// ---------------------------------------------------------------------------

describe("Conformance: in-process", () => {
  const ArticlesLive = HttpApiBuilder.group(api, "articles", (handlers) =>
    handlers
      .handle("get", ({ query }) =>
        Effect.succeed(
          Handlers.data(article, {
            included: query.include?.includes("author") ? [author] : [],
            self: "/articles/1",
          }),
        ),
      )
      .handle("list", ({ query }) =>
        Effect.succeed(
          Handlers.collection([article], {
            included: query.include?.includes("author") ? [author] : [],
          }),
        ),
      ),
  );

  const Live = ArticlesLive.pipe(Layer.provideMerge(Middleware.layer));

  const run = runOver(api, Live);

  it("drives the real router, middleware and handlers", async () => {
    const report = await run();
    expect(report.transport).toBe("in-process");
    expect(Conformance.summarise(report).probes).toBeGreaterThan(20);
    // The endpoints really were discovered from the api value.
    const reachable = outcomeFor(report, "spec/target/reachable");
    expect(reachable._tag).toBe("Passed");
  });

  it("observes the wire, not the typed client: it sees the raw media type", async () => {
    const report = await run({ only: ["spec/content-negotiation/response-media-type"] });
    expect(outcomeFor(report, "spec/content-negotiation/response-media-type")._tag).toBe("Passed");
  });

  it("holds the middleware to the 400 for `sort` on a collection endpoint without it (#261)", async () => {
    // `list` declares `include` and `fields` but no `sort`.
    const report = await run({ only: ["spec/query/sort-unsupported-endpoint"] });
    expect(outcomeFor(report, "spec/query/sort-unsupported-endpoint")).toMatchObject({
      _tag: "Passed",
      probes: 2,
      note: undefined,
    });
  });

  it("holds the middleware to the 400 for `include` on an endpoint without it (#261)", async () => {
    const undeclared = HttpApi.make("undeclared").add(
      Group.make(Article, Endpoint.get(Article, { fields: true })),
    );
    const UndeclaredLive = HttpApiBuilder.group(undeclared, "articles", (handlers) =>
      handlers.handle("get", () => Effect.succeed(Handlers.data(article, { self: "/articles/1" }))),
    ).pipe(Layer.provideMerge(Middleware.layer));
    const report = await runOver(
      undeclared,
      UndeclaredLive,
    )({ only: ["spec/query/include-unsupported-endpoint"] });
    expect(outcomeFor(report, "spec/query/include-unsupported-endpoint")).toMatchObject({
      _tag: "Passed",
      probes: 2,
      note: undefined,
    });
  });

  it("holds the middleware to the Accept-weight rule #101 fixed", async () => {
    // `q` is an Accept-header weight, not a media type parameter (RFC 9110
    // §12.4.2). The kit reported this against the shipped middleware before
    // #101 was fixed; it now guards the fix against regressing.
    const report = await run({
      only: [
        "spec/content-negotiation/accept-weight-is-not-a-parameter",
        "spec/content-negotiation/accept-weight-zero-refuses",
      ],
    });
    const weight = outcomeFor(report, "spec/content-negotiation/accept-weight-is-not-a-parameter");
    expect(weight._tag).toBe("Passed");
    // `q=0` is still a refusal, so the fix did not simply stop reading weights.
    expect(outcomeFor(report, "spec/content-negotiation/accept-weight-zero-refuses")._tag).toBe(
      "Passed",
    );
  });
});

describe("Conformance: a target that redirects some read endpoints off its origin", () => {
  // Six list endpoints, `/r0` … `/r3` redirected to another origin, and a
  // `get` with no id to probe, which every read rule notes as not probed.
  const lists = Arr.makeBy(6, (n) => Resource.make(`r${n}`, { attributes: {} }));
  const Unprobed = Resource.make("unprobed", { attributes: {} });
  const partly = HttpApi.make("partly")
    .add(...Arr.map(lists, (resource) => Group.make(resource, Endpoint.list(resource))))
    .add(Group.make(Unprobed, Endpoint.get(Unprobed)));
  const serve = (request: CannedRequest): Canned =>
    /^\/r[0-3]$/.test(request.path)
      ? { status: 302, headers: { location: `https://elsewhere.test${request.path}` } }
      : { body: { data: [] } };

  it("reports the redirected endpoints once, and skips a rule that read the rest, keeping its note", async () => {
    const report = await verifyOver(partly)(serve, {
      only: ["spec/target/reachable", "spec/content-negotiation/response-media-type"],
    });
    expect(outcomeFor(report, "spec/target/reachable")).toMatchObject({
      _tag: "Failed",
      findings: [
        {
          detail:
            "4 of 6 read endpoints the kit probed answered with a redirect it does not follow or read, so the rules that probe them have no answer to decide on — point `baseUrl` at the URL that serves the api",
          observed: `/r0: ${offsite("/r0")}; and 3 more (/r1, /r2, /r3)`,
        },
      ],
    });
    // Four redirects named, three of them in full; the rule's own coverage note kept.
    expect(outcomeFor(report, "spec/content-negotiation/response-media-type")).toEqual({
      _tag: "Skipped",
      rule: expect.anything(),
      reason: `not decided: 4 of 6 requests the rule sent were answered by a redirect the kit does not follow or read (GET /r0 answered ${offsite("/r0")}; GET /r1 answered ${offsite("/r1")}; GET /r2 answered ${offsite("/r2")}; and 1 more), and a rule is not passed on the answers it did read alone; the rule's own note: 1 endpoint not probed: no sample id for "unprobed" — pass ids["unprobed"] or paths["unprobed.get"]`,
    });
  });
});

// ---------------------------------------------------------------------------
// The Idempotency-Key profile
// ---------------------------------------------------------------------------

describe("Conformance: the Idempotency-Key profile advertisement", () => {
  const RULE = "profile/idempotency/advertises-profile-uri";

  const idempotentApi = HttpApi.make("idempotent").add(
    Group.make(Article, Endpoint.get(Article), Endpoint.create(Article, { idempotency: true })),
  );
  const requiredApi = HttpApi.make("required").add(
    Group.make(
      Article,
      Endpoint.get(Article),
      Endpoint.create(Article, { idempotency: "required" }),
    ),
  );
  const plainApi = HttpApi.make("plain").add(
    Group.make(Article, Endpoint.get(Article), Endpoint.create(Article)),
  );

  const profiled = `${MEDIA_TYPE}; profile="${Idempotency.PROFILE_URI}"`;

  /** Where a create's answer names the profile, if anywhere. */
  type Advertises = "document" | "media type" | "neither";

  /**
   * A server whose create answers 201 with the created article, naming the
   * profile where `advertises` says; `status` overrides the create's status.
   * `keys` collects the `Idempotency-Key` each create carried.
   */
  const idempotentServer = (advertises: Advertises, keys: Array<string>, status = 201) => {
    let next = 100;
    return (request: CannedRequest): Canned => {
      if (`${request.method} ${request.path}` !== "POST /articles") return conformantServe(request);
      keys.push(request.headers.get("idempotency-key") ?? "(no key)");
      const id = `${next++}`;
      const data = { type: "articles", id, attributes: { title: "t", body: "" } };
      return {
        status,
        headers: { location: `/articles/${id}` },
        contentType: advertises === "media type" ? profiled : MEDIA_TYPE,
        body:
          advertises === "document"
            ? { jsonapi: Idempotency.jsonapi, data }
            : { jsonapi: { version: "1.1" }, data },
      };
    };
  };

  const fixture: Conformance.WriteFixture = {
    create: () => ({ type: "articles", attributes: { title: "probe", body: "" } }),
  };

  const verifyIdempotent = verifyOver(idempotentApi);
  const verifyRequired = verifyOver(requiredApi);
  const verifyPlain = verifyOver(plainApi);

  const runRule = (
    verify: typeof verifyIdempotent | typeof verifyRequired | typeof verifyPlain,
    serve: (request: CannedRequest) => Canned,
    options: Conformance.Options = {},
  ) =>
    verify(serve, {
      only: [RULE],
      mutating: true,
      writes: { articles: fixture },
      ...options,
    });

  it("is a profile-tier SHOULD citing docs/idempotency.md §1", () => {
    const rule = Conformance.rules.find((candidate) => candidate.id === RULE);
    expect(rule).toMatchObject({
      tier: "profile",
      level: "SHOULD",
      reference: expect.stringMatching(/docs\/idempotency\.md#1-what-the-profile-is-and-is-not$/),
    });
  });

  it("passes a create that names the profile in `jsonapi.profile`, sending no key where it is optional", async () => {
    const keys: Array<string> = [];
    const report = await runRule(verifyIdempotent, idempotentServer("document", keys));
    expect(outcomeFor(report, RULE)).toMatchObject({ _tag: "Passed", probes: 1 });
    expect(keys).toEqual(["(no key)"]);
    expect(report.writes?.map((write) => write.rule)).toEqual([RULE]);
  });

  it("holds an endpoint that requires the key too, sending a fresh one", async () => {
    const keys: Array<string> = [];
    const report = await runRule(verifyRequired, (request) =>
      request.method === "POST" && !request.headers.has("idempotency-key")
        ? { status: 400, body: { errors: [{ status: "400" }] } }
        : idempotentServer("neither", keys)(request),
    );
    expect(outcomeFor(report, RULE)._tag).toBe("Failed");
    // One create, carrying a key no earlier request did — never a replay.
    expect(keys).toEqual([expect.stringMatching(/^conformance-/)]);
  });

  it("sends each required endpoint a key of its own", async () => {
    const twoTypes = HttpApi.make("two").add(
      Group.make(
        Article,
        Endpoint.get(Article),
        Endpoint.create(Article, { idempotency: "required" }),
      ),
      Group.make(Person, Endpoint.create(Person, { idempotency: "required" })),
    );
    const keys: Array<string> = [];
    let next = 100;
    const report = await verifyOver(twoTypes)(
      (request) => {
        if (request.method !== "POST") return conformantServe(request);
        keys.push(request.headers.get("idempotency-key") ?? "(no key)");
        const type = request.path.slice(1);
        return {
          status: 201,
          body: { jsonapi: Idempotency.jsonapi, data: { type, id: `${next++}`, attributes: {} } },
        };
      },
      {
        only: [RULE],
        mutating: true,
        writes: {
          articles: fixture,
          people: {
            create: () => ({ type: "people", attributes: { firstName: "a", lastName: "b" } }),
          },
        },
      },
    );
    expect(outcomeFor(report, RULE)).toMatchObject({ _tag: "Passed", probes: 2 });
    expect(keys).toEqual([
      expect.stringMatching(/^conformance-/),
      expect.stringMatching(/^conformance-/),
    ]);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("finds the profile in a space-separated `profile` list", async () => {
    const report = await runRule(verifyIdempotent, (request) =>
      request.method === "POST"
        ? {
            ...idempotentServer("neither", [])(request),
            contentType: `${MEDIA_TYPE}; profile="${Filter.PROFILE_URI} ${Idempotency.PROFILE_URI}"`,
          }
        : conformantServe(request),
    );
    expect(outcomeFor(report, RULE)).toMatchObject({ _tag: "Passed", probes: 1 });
  });

  it("counts only the `profile` parameter, not `ext` naming the URI", async () => {
    const report = await runRule(verifyIdempotent, (request) =>
      request.method === "POST"
        ? {
            ...idempotentServer("neither", [])(request),
            contentType: `${MEDIA_TYPE}; ext="${Idempotency.PROFILE_URI}"`,
          }
        : conformantServe(request),
    );
    expect(outcomeFor(report, RULE)._tag).toBe("Failed");
  });

  it("does not take another profile of this package's for this one", async () => {
    // The filter grammar's URI shares the idempotency profile's prefix.
    const report = await runRule(verifyIdempotent, (request) =>
      request.method === "POST"
        ? {
            ...idempotentServer("neither", [])(request),
            contentType: `${MEDIA_TYPE}; profile="${Filter.PROFILE_URI}"`,
            body: {
              jsonapi: { version: "1.1", profile: [Filter.PROFILE_URI] },
              data: { type: "articles", id: "100", attributes: { title: "t", body: "" } },
            },
          }
        : conformantServe(request),
    );
    expect(outcomeFor(report, RULE)._tag).toBe("Failed");
  });

  it("passes a create that names the profile on its media type", async () => {
    const report = await runRule(verifyIdempotent, idempotentServer("media type", []));
    expect(outcomeFor(report, RULE)).toMatchObject({ _tag: "Passed", probes: 1 });
  });

  it("fails a create that names the profile in neither place", async () => {
    const report = await runRule(verifyIdempotent, idempotentServer("neither", []));
    expect(outcomeFor(report, RULE)).toMatchObject({
      _tag: "Failed",
      findings: [
        {
          detail: expect.stringContaining("does not advertise the profile"),
          observed: `jsonapi: {"version":"1.1"} · Content-Type: ${MEDIA_TYPE}`,
        },
      ],
    });
  });

  it("does not decide on a create the server did not accept", async () => {
    const report = await runRule(verifyIdempotent, idempotentServer("document", [], 422));
    expect(outcomeFor(report, RULE)).toEqual(
      expect.objectContaining({
        _tag: "Skipped",
        reason: expect.stringContaining(`did not accept writes["articles"].create (422`),
      }),
    );
  });

  it("does not decide on a 2xx with no document to name the profile in", async () => {
    const report = await runRule(verifyIdempotent, (request) =>
      request.method === "POST" ? { status: 204 } : conformantServe(request),
    );
    expect(outcomeFor(report, RULE)).toEqual(
      expect.objectContaining({ _tag: "Skipped", reason: expect.stringContaining("no document") }),
    );
  });

  it("passes a 2xx with no document whose media type names the profile", async () => {
    const report = await runRule(verifyIdempotent, (request) =>
      request.method === "POST"
        ? { status: 204, headers: { "content-type": profiled } }
        : conformantServe(request),
    );
    expect(outcomeFor(report, RULE)).toMatchObject({ _tag: "Passed", probes: 1 });
  });

  describe("on update endpoints", () => {
    const updatableApi = (create: Idempotency.Option) =>
      HttpApi.make("updatable").add(
        Group.make(
          Article,
          Endpoint.get(Article),
          Endpoint.create(Article, { idempotency: create }),
          Endpoint.update(Article, { idempotency: "required" }),
        ),
      );

    /** One request the server saw: its method and path, and the key it carried. */
    type Seen = { readonly request: string; readonly key: string };

    /**
     * Creates as {@link idempotentServer} does; an update (a `PATCH` or a
     * `PUT`) answers 200 with the article, naming the profile where
     * `onUpdate` says, or `updateStatus`.
     */
    const updatableServer = (
      onCreate: Advertises,
      onUpdate: Advertises,
      seen: Array<Seen>,
      updateStatus = 200,
    ) => {
      const create = idempotentServer(onCreate, []);
      return (request: CannedRequest): Canned => {
        const line = `${request.method} ${request.path}`;
        const updates = request.method === "PATCH" || request.method === "PUT";
        if (request.method === "POST" || updates)
          seen.push({ request: line, key: request.headers.get("idempotency-key") ?? "(no key)" });
        if (!updates) return create(request);
        const id = request.path.split("/")[2] ?? "";
        const data = { type: "articles", id, attributes: { title: "u", body: "" } };
        return {
          status: updateStatus,
          contentType: onUpdate === "media type" ? profiled : MEDIA_TYPE,
          body:
            onUpdate === "document"
              ? { jsonapi: Idempotency.jsonapi, data }
              : { jsonapi: { version: "1.1" }, data },
        };
      };
    };

    const updating: Conformance.WriteFixture = {
      ...fixture,
      update: () => ({ attributes: { title: "updated" } }),
    };

    const runUpdates = (
      create: Idempotency.Option,
      serve: (request: CannedRequest) => Canned,
      writes: Conformance.Options["writes"] = { articles: updating },
    ) => verifyOver(updatableApi(create))(serve, { only: [RULE], mutating: true, writes });

    it("judges one create and one update per type, keying only the required update", async () => {
      const seen: Array<Seen> = [];
      const report = await runUpdates(true, updatableServer("document", "media type", seen));
      expect(outcomeFor(report, RULE)).toMatchObject({ _tag: "Passed", probes: 2 });
      expect(seen).toEqual([
        { request: "POST /articles", key: "(no key)" },
        { request: "PATCH /articles/100", key: expect.stringMatching(/^conformance-/) },
      ]);
    });

    it("probes each of a type's update endpoints with a create and an update of its own", async () => {
      // A `PUT` beside the `PATCH`: each gets the create and update the spec
      // tier's `update-response` gives it, rather than one per type.
      const withPut = HttpApi.make("put").add(
        Group.make(
          Article,
          Endpoint.get(Article),
          Endpoint.create(Article, { idempotency: true }),
          Endpoint.update(Article, { idempotency: "required" }),
        ),
        HttpApiGroup.make("replace").add(
          HttpApiEndpoint.put("replace", "/articles/:id", {
            params: { id: Schema.String },
            headers: Schema.Struct({ "idempotency-key": Schema.String }),
            success: Schema.Unknown,
          }),
        ),
      );
      const seen: Array<Seen> = [];
      const report = await verifyOver(withPut)(updatableServer("document", "document", seen), {
        only: [RULE],
        mutating: true,
        writes: { articles: updating },
      });
      expect(outcomeFor(report, RULE)).toMatchObject({ _tag: "Passed", probes: 4 });
      expect(seen).toEqual([
        { request: "POST /articles", key: "(no key)" },
        { request: "PATCH /articles/100", key: expect.stringMatching(/^conformance-/) },
        { request: "POST /articles", key: "(no key)" },
        { request: "PUT /articles/101", key: expect.stringMatching(/^conformance-/) },
      ]);
    });

    it("fails an update that names the profile in neither place", async () => {
      const report = await runUpdates(true, updatableServer("document", "neither", []));
      expect(outcomeFor(report, RULE)).toMatchObject({
        _tag: "Failed",
        findings: [
          { detail: expect.stringContaining("updating articles:100 through /articles/:id") },
        ],
      });
    });

    it("judges the create too when its endpoint declares the header", async () => {
      const report = await runUpdates(true, updatableServer("neither", "document", []));
      expect(outcomeFor(report, RULE)).toMatchObject({
        _tag: "Failed",
        findings: [{ detail: expect.stringContaining(`creating a "articles" resource`) }],
      });
    });

    it("judges only the update when the create endpoint does not declare the header", async () => {
      const report = await runUpdates(false, updatableServer("neither", "document", []));
      // Both requests count, as when the create is judged too.
      expect(outcomeFor(report, RULE)).toMatchObject({ _tag: "Passed", probes: 2 });
    });

    it("does not decide on an update the server did not accept", async () => {
      const report = await runUpdates(false, updatableServer("neither", "document", [], 422));
      expect(outcomeFor(report, RULE)).toEqual(
        expect.objectContaining({
          _tag: "Skipped",
          reason: expect.stringContaining(`did not accept writes["articles"].update`),
        }),
      );
    });

    it("still probes the create when there is no update fixture", async () => {
      const seen: Array<Seen> = [];
      const report = await runUpdates(true, updatableServer("document", "neither", seen), {
        articles: fixture,
      });
      expect(outcomeFor(report, RULE)).toMatchObject({
        _tag: "Passed",
        probes: 1,
        note: expect.stringContaining(`writes["articles"].update`),
      });
      expect(seen.map(({ request }) => request)).toEqual(["POST /articles"]);
    });
  });

  it("skips, naming why, when no create endpoint declares the header", async () => {
    const keys: Array<string> = [];
    const report = await runRule(verifyPlain, idempotentServer("neither", keys));
    expect(outcomeFor(report, RULE)).toEqual(
      expect.objectContaining({
        _tag: "Skipped",
        reason: "no create or update endpoint declaring the `Idempotency-Key` header in this api",
      }),
    );
    expect(keys).toEqual([]);
  });

  it("skips without `mutating: true`, writing nothing", async () => {
    const keys: Array<string> = [];
    const report = await runRule(verifyIdempotent, idempotentServer("neither", keys), {
      mutating: false,
    });
    expect(outcomeFor(report, RULE)).toEqual(
      expect.objectContaining({
        _tag: "Skipped",
        reason: expect.stringContaining("mutating: true"),
      }),
    );
    expect(keys).toEqual([]);
  });

  it("skips without a write fixture, naming the key it wanted", async () => {
    const report = await runRule(verifyIdempotent, idempotentServer("neither", []), { writes: {} });
    expect(outcomeFor(report, RULE)).toEqual(
      expect.objectContaining({
        _tag: "Skipped",
        reason: expect.stringContaining(`writes["articles"].create`),
      }),
    );
  });

  describe("the spec tier's writes", () => {
    const keyedApi = (idempotency: Idempotency.Option) =>
      HttpApi.make("keyed").add(
        Group.make(
          Article,
          Endpoint.get(Article),
          Endpoint.create(Article, { idempotency }),
          Endpoint.update(Article, { idempotency }),
          Endpoint.delete(Article, { idempotency }),
        ),
      );

    /**
     * A server that refuses a write without a key when `required`, as an
     * `idempotency: "required"` endpoint does, and records the key each write
     * carried.
     */
    const keyedServer = (required: boolean, seen: Array<string>) => {
      let next = 100;
      return (request: CannedRequest): Canned => {
        if (request.method === "GET") return conformantServe(request);
        const key = request.headers.get("idempotency-key");
        seen.push(`${request.method} ${key === null ? "(no key)" : "key"}`);
        if (required && key === null) return { status: 400, body: { errors: [{ status: "400" }] } };
        if (request.method === "DELETE") return { status: 204 };
        const id = request.method === "POST" ? `${next++}` : (request.path.split("/")[2] ?? "");
        return {
          status: request.method === "POST" ? 201 : 200,
          headers: { location: `/articles/${id}` },
          body: { data: { type: "articles", id, attributes: { title: "t", body: "" } } },
        };
      };
    };

    const options: Conformance.Options = {
      only: [
        "spec/status/create-response-document",
        "spec/status/update-response",
        "spec/status/delete-response",
      ],
      mutating: true,
      writes: {
        articles: { ...fixture, update: () => ({ attributes: { title: "updated" } }) },
      },
    };

    it("send a fresh key to every endpoint that requires one", async () => {
      const seen: Array<string> = [];
      const report = await verifyOver(keyedApi("required"))(keyedServer(true, seen), options);
      expect(report.outcomes.map((outcome) => outcome._tag)).toEqual([
        "Passed",
        "Passed",
        "Passed",
      ]);
      expect(seen).toEqual(["POST key", "POST key", "PATCH key", "POST key", "DELETE key"]);
    });

    it("send none where the key is optional", async () => {
      const seen: Array<string> = [];
      const report = await verifyOver(keyedApi(true))(keyedServer(false, seen), options);
      expect(report.outcomes.map((outcome) => outcome._tag)).toEqual([
        "Passed",
        "Passed",
        "Passed",
      ]);
      expect(seen.every((line) => line.endsWith("(no key)"))).toBe(true);
    });

    /** The package's own `400` for a missing required key, naming the header as its source. */
    const missingKey = (status = 400): Canned => ({
      status,
      body: { errors: [{ status: `${status}`, source: { header: "idempotency-key" } }] },
    });

    /**
     * The package's own answer with `Refusal`, at that error's status; both
     * errors name the header as their source.
     */
    const keyError = (Refusal: (typeof Idempotency.Errors)[number]): Canned => ({
      status: Refusal.status,
      body: ApiError.toDocument(new Refusal()),
    });

    it("leave a delete refused for the missing key undecided where the endpoint declares the header", async () => {
      // `idempotency: true` reads as optional, as a key required through a
      // union does, so the kit sends none — and a 4xx naming the header as its
      // source is that refusal, not an answer to the delete.
      const seen: Array<string> = [];
      const serve = keyedServer(false, seen);
      const report = await verifyOver(keyedApi(true))(
        (request) =>
          request.method === "DELETE" && !request.headers.has("idempotency-key")
            ? missingKey()
            : serve(request),
        { ...options, only: ["spec/status/delete-response"] },
      );
      expect(outcomeFor(report, "spec/status/delete-response")).toEqual(
        expect.objectContaining({
          _tag: "Skipped",
          reason: expect.stringContaining(
            "which declares `Idempotency-Key` without plainly requiring it, so the kit sent no key, and the error names that header as its source",
          ),
        }),
      );
    });

    it("still fail a refused delete the missing key cannot explain", async () => {
      // Each case but one names the header as the error's source, so each
      // fails on its own condition: an endpoint declaring no key, a delete
      // that did carry the key its endpoint requires, a 5xx and a 3xx, which
      // no missing key is, the package's own `KeyInProgress` (409) and
      // `KeyMismatch` (422), which a missing key is not either, and a 4xx
      // that does not name the header.
      const cases = [
        { idempotency: false, answer: missingKey() },
        { idempotency: "required", answer: missingKey() },
        { idempotency: true, answer: missingKey(500) },
        { idempotency: true, answer: missingKey(303) },
        { idempotency: true, answer: keyError(Idempotency.KeyInProgress) },
        { idempotency: true, answer: keyError(Idempotency.KeyMismatch) },
        { idempotency: true, answer: { status: 400, body: { errors: [{ status: "400" }] } } },
        {
          idempotency: true,
          answer: {
            status: 400,
            body: { errors: [{ status: "400", source: { parameter: "idempotency-key" } }] },
          },
        },
      ] as const;
      const outcomes = await Promise.all(
        cases.map(async ({ idempotency, answer }) => {
          const serve = keyedServer(idempotency === "required", []);
          const report = await verifyOver(keyedApi(idempotency))(
            (request) => (request.method === "DELETE" ? answer : serve(request)),
            { ...options, only: ["spec/status/delete-response"] },
          );
          return outcomeFor(report, "spec/status/delete-response")._tag;
        }),
      );
      expect(outcomes).toEqual(cases.map(() => "Failed"));
    });

    it("read the header as the error's source case-insensitively", async () => {
      const serve = keyedServer(false, []);
      const report = await verifyOver(keyedApi(true))(
        (request) =>
          request.method === "DELETE"
            ? {
                status: 400,
                body: { errors: [{ status: "400" }, { source: { header: "Idempotency-Key" } }] },
              }
            : serve(request),
        { ...options, only: ["spec/status/delete-response"] },
      );
      expect(outcomeFor(report, "spec/status/delete-response")._tag).toBe("Skipped");
    });

    describe("through the atomic operations endpoint", () => {
      const atomicApi = (idempotency: Idempotency.Option) =>
        HttpApi.make("atomic")
          .add(Group.make(Article, Endpoint.get(Article)))
          .add(Group.make("operations", Endpoint.operations([Article, Person], { idempotency })));

      const atomicType = `${MEDIA_TYPE};ext="${ATOMIC_EXTENSION_URI}"`;

      const decodeOperations = Schema.decodeUnknownOption(
        Schema.Struct({
          "atomic:operations": Schema.Array(
            Schema.Struct({ data: Schema.Struct({ type: Schema.String }) }),
          ),
        }),
      );

      /**
       * An operations endpoint that, when `requiresKey`, refuses a request
       * without a key with the package's missing-key `400`, and otherwise
       * applies every `add` — and, unless `rejects`, answers a document that
       * is no operations document 200 too. `seen` records the key each request
       * carried.
       */
      const atomicServer = (seen: Array<string>, rejects: boolean, requiresKey = true) => {
        let next = 100;
        return (request: CannedRequest): Canned => {
          if (request.method !== "POST") return conformantServe(request);
          const key = request.headers.get("idempotency-key");
          seen.push(key ?? "(no key)");
          if (requiresKey && key === null) return missingKey();
          return Option.match(decodeOperations(request.body), {
            onNone: (): Canned =>
              rejects
                ? { status: 400, body: { errors: [{ status: "400" }] } }
                : { contentType: atomicType, body: { "atomic:results": [] } },
            onSome: (document): Canned => ({
              contentType: atomicType,
              body: {
                "atomic:results": document["atomic:operations"].map(({ data }) => ({
                  data: { type: data.type, id: `${next++}`, attributes: {} },
                })),
              },
            }),
          });
        };
      };

      const atomicOptions = (only: string): Conformance.Options => ({
        only: [only],
        mutating: true,
        writes: {
          articles: fixture,
          people: {
            create: () => ({ type: "people", attributes: { firstName: "a", lastName: "b" } }),
          },
        },
      });

      it("key each `add` sent to an endpoint that requires one afresh", async () => {
        const seen: Array<string> = [];
        const report = await verifyOver(atomicApi("required"))(
          atomicServer(seen, true),
          atomicOptions("spec/atomic/response-ext-parameter"),
        );
        expect(outcomeFor(report, "spec/atomic/response-ext-parameter")).toMatchObject({
          _tag: "Passed",
          probes: 2,
        });
        // One `add` per type, each with a key no earlier request carried.
        expect(seen).toEqual([
          expect.stringMatching(/^conformance-/),
          expect.stringMatching(/^conformance-/),
        ]);
        expect(seen[0]).not.toBe(seen[1]);
      });

      it("key the malformed document, so a 4xx is never the missing key's", async () => {
        const seen: Array<string> = [];
        const report = await verifyOver(atomicApi("required"))(
          atomicServer(seen, false),
          atomicOptions("spec/atomic/malformed-operations-rejected"),
        );
        expect(outcomeFor(report, "spec/atomic/malformed-operations-rejected")._tag).toBe("Failed");
        expect(seen).toEqual([expect.stringMatching(/^conformance-/)]);
        const rejected = await verifyOver(atomicApi("required"))(
          atomicServer([], true),
          atomicOptions("spec/atomic/malformed-operations-rejected"),
        );
        expect(outcomeFor(rejected, "spec/atomic/malformed-operations-rejected")._tag).toBe(
          "Passed",
        );
      });

      it("send no key where it is optional", async () => {
        const adds: Array<string> = [];
        const added = await verifyOver(atomicApi(true))(
          atomicServer(adds, true, false),
          atomicOptions("spec/atomic/response-ext-parameter"),
        );
        expect(outcomeFor(added, "spec/atomic/response-ext-parameter")).toMatchObject({
          _tag: "Passed",
          probes: 2,
        });
        expect(adds).toEqual(["(no key)", "(no key)"]);
        const malformed: Array<string> = [];
        const rejected = await verifyOver(atomicApi(true))(
          atomicServer(malformed, true, false),
          atomicOptions("spec/atomic/malformed-operations-rejected"),
        );
        // A 4xx that does not name the header rejects the document.
        expect(outcomeFor(rejected, "spec/atomic/malformed-operations-rejected")._tag).toBe(
          "Passed",
        );
        expect(malformed).toEqual(["(no key)"]);
      });

      it("leave a malformed document refused for the missing key undecided", async () => {
        // `idempotency: true` reads as optional, as a key required through a
        // union does, so the kit sends none; a 4xx naming the header as its
        // source refused the missing key, not the document.
        const seen: Array<string> = [];
        const report = await verifyOver(atomicApi(true))(
          atomicServer(seen, true),
          atomicOptions("spec/atomic/malformed-operations-rejected"),
        );
        expect(outcomeFor(report, "spec/atomic/malformed-operations-rejected")).toEqual(
          expect.objectContaining({
            _tag: "Skipped",
            reason: expect.stringContaining(
              "which declares `Idempotency-Key` without plainly requiring it, so the kit sent no key, and the error names that header as its source",
            ),
          }),
        );
        expect(seen).toEqual(["(no key)"]);
      });

      it("leave a malformed document refused on any other key grounds undecided", async () => {
        // Unlike the delete rule, which judges the answer itself, this rule
        // judges only whether the server examined the document; a 409 or 422
        // naming the header refused the request over its key, which says
        // nothing about that.
        const refusals = [Idempotency.KeyInProgress, Idempotency.KeyMismatch] as const;
        const results = await Promise.all(
          refusals.map(async (Refusal) => {
            const seen: Array<string> = [];
            const serve = atomicServer([], true, false);
            const report = await verifyOver(atomicApi(true))((request) => {
              if (request.method !== "POST") return serve(request);
              seen.push(request.headers.get("idempotency-key") ?? "(no key)");
              return keyError(Refusal);
            }, atomicOptions("spec/atomic/malformed-operations-rejected"));
            return {
              outcome: outcomeFor(report, "spec/atomic/malformed-operations-rejected"),
              seen,
            };
          }),
        );
        expect(results).toEqual(
          refusals.map((Refusal) => ({
            outcome: expect.objectContaining({
              _tag: "Skipped",
              reason: expect.stringContaining(
                `the malformed document answered ${Refusal.status} from /operations, which declares \`Idempotency-Key\` without plainly requiring it, so the kit sent no key, and the error names that header as its source`,
              ),
            }),
            seen: ["(no key)"],
          })),
        );
      });

      it("still fail a malformed document refused outside the 4xx range", async () => {
        // A 5xx or a 3xx naming the header as its source is no refusal over
        // the key, so it answers the document — wrongly.
        const outcomes = await Promise.all(
          [500, 303].map(async (status) => {
            const serve = atomicServer([], true, false);
            const report = await verifyOver(atomicApi(true))(
              (request) => (request.method === "POST" ? missingKey(status) : serve(request)),
              atomicOptions("spec/atomic/malformed-operations-rejected"),
            );
            return outcomeFor(report, "spec/atomic/malformed-operations-rejected")._tag;
          }),
        );
        expect(outcomes).toEqual(["Failed", "Failed"]);
      });
    });
  });

  describe("against a package-built server", () => {
    const live = (advertise: boolean) =>
      HttpApiBuilder.group(idempotentApi, "articles", (handlers) =>
        handlers
          .handle("get", () => Effect.succeed(Handlers.data(article)))
          .handle("create", ({ payload }) =>
            Effect.succeed(
              Handlers.data(
                Article.make({
                  id: Article.Id.make("200"),
                  attributes: payload.data.attributes,
                  relationships: { author: { data: Person.ref(author.id) } },
                }),
                advertise ? { jsonapi: Idempotency.jsonapi } : {},
              ),
            ),
          ),
      ).pipe(
        Layer.provideMerge(Middleware.layer),
        Layer.provideMerge(Idempotency.layer(Idempotency.memoryStore())),
      );

    const options: Conformance.Options = {
      only: [RULE],
      mutating: true,
      writes: {
        articles: {
          create: () => ({
            type: "articles",
            attributes: { title: "probe", body: "" },
            relationships: { author: { data: { type: "people", id: "9" } } },
          }),
        },
      },
    };

    it("passes when the handler answers with `jsonapi: Idempotency.jsonapi`", async () => {
      const report = await runOver(idempotentApi, live(true))(options);
      expect(outcomeFor(report, RULE)).toMatchObject({ _tag: "Passed", probes: 1 });
    });

    it("fails when the handler answers without it", async () => {
      const report = await runOver(idempotentApi, live(false))(options);
      expect(outcomeFor(report, RULE)._tag).toBe("Failed");
    });
  });
});

// ---------------------------------------------------------------------------
// Client-generated ids and relationship mutation
// ---------------------------------------------------------------------------

/**
 * The write rules that need more than a payload: the client-generated id
 * rules, which need a `clientId` in the fixture, and the relationship
 * mutation rules, which need relationship endpoints and an `ids` sample to
 * link to. A canned server over a store of posts, conformant by default, with
 * one switch per deliberate breakage.
 */
describe("Conformance: client-generated ids and relationship mutation", () => {
  const Tag = Resource.make("tags", { attributes: { name: Schema.String } });
  const Post = Resource.make("posts", {
    attributes: { title: Schema.String },
    relationships: {
      author: Relationship.optional(() => Person),
      tags: Relationship.many(() => Tag),
    },
  });
  const mutationApi = HttpApi.make("mutation").add(
    Group.make(
      Post,
      Endpoint.get(Post),
      Endpoint.create(Post),
      Endpoint.getRelationship(Post, "author"),
      Endpoint.updateRelationship(Post, "author"),
      Endpoint.getRelationship(Post, "tags"),
      Endpoint.updateRelationship(Post, "tags"),
      Endpoint.addRelationship(Post, "tags"),
      Endpoint.removeRelationship(Post, "tags"),
    ),
  );

  interface Identifier {
    readonly type: string;
    readonly id: string;
  }
  interface Stored {
    readonly title: string;
    author: Identifier | null;
    tags: Array<Identifier>;
  }
  type Posts = Map<string, Stored>;

  /** How the canned server departs from the specification, one switch per breakage. */
  interface Breakage {
    /** What a create carrying an id does: honour it (the default), refuse it with 403, or drop it. */
    readonly clientIds?: "supported" | "unsupported" | "ignored";
    /** Answer a create under a client id with 204 rather than 201. */
    readonly noContent?: boolean;
    /** Overwrite a resource on a create under an id it already holds, rather than 409. */
    readonly overwrites?: boolean;
    /**
     * What the 403 refusing a client id names as `source.pointer`: the
     * resource object's id (the default), the resource object itself, or
     * nothing.
     */
    readonly pointer?: "id" | "resource" | "none";
    /** Relationship writes of these methods answer 204 and change nothing (but still 404 an absent resource). */
    readonly ignores?: ReadonlyArray<string>;
    /** Relationship writes of these methods answer 403. */
    readonly forbids?: ReadonlyArray<string>;
    /**
     * What an accepted relationship write answers: 204 (the default), 200
     * with the linkage as it now stands, 200 with top-level `meta` alone, 200
     * with the linkage as it stood before the write, a bare 201, or a 202
     * (having applied the write all the same).
     */
    readonly responds?: "204" | "202" | "linkage" | "meta" | "stale" | "201";
    /** A `PATCH` of `{ "data": null }` to the to-one `author` answers 204 and changes nothing. */
    readonly keepsOnNull?: boolean;
    /** Link a resource that does not exist rather than answer 404. */
    readonly linksAbsent?: boolean;
    /** Answer a `DELETE` naming a resource that does not exist 404, rather than succeed. */
    readonly removesAbsent404?: boolean;
  }

  const Body = Schema.Struct({
    data: Schema.Struct({
      type: Schema.Literal("posts"),
      id: Schema.optionalKey(Schema.String),
      attributes: Schema.optionalKey(Schema.Struct({ title: Schema.String })),
    }),
  });
  const decodeBody = Schema.decodeUnknownOption(Body);
  const Linkage = Schema.Struct({
    data: Schema.Union([
      Schema.Null,
      Schema.Struct({ type: Schema.String, id: Schema.String }),
      Schema.Array(Schema.Struct({ type: Schema.String, id: Schema.String })),
    ]),
  });
  const decodeLinkage = Schema.decodeUnknownOption(Linkage);

  /** An error document of `code`, as the canned server answers every refusal. */
  const refused = (code: number): Canned => ({
    status: code,
    body: { errors: [{ status: `${code}` }] },
  });
  /** The 403 refusing a client id, naming the pointer `named` picks, or none. */
  const forbidden = (named: NonNullable<Breakage["pointer"]>): Canned =>
    named === "none"
      ? refused(403)
      : {
          status: 403,
          body: {
            errors: [{ status: "403", source: { pointer: named === "id" ? "/data/id" : "/data" } }],
          },
        };

  const sameIdentifier = (item: Identifier) => (other: Identifier) =>
    other.type === item.type && other.id === item.id;

  /** A to-many linkage after a `PATCH`, `POST` or `DELETE` of `data`. */
  const applied = (
    method: string,
    tags: ReadonlyArray<Identifier>,
    data: ReadonlyArray<Identifier>,
  ): Array<Identifier> => {
    if (method === "PATCH") return [...data];
    if (method === "POST")
      return [...tags, ...data.filter((item) => !tags.some(sameIdentifier(item)))];
    return tags.filter((tag) => !data.some((item) => sameIdentifier(item)(tag)));
  };

  /** The resources a relationship write may link to: the `ids` samples the runs pass. */
  const linkable: ReadonlyArray<string> = ["people:9", "tags:7"];

  const mutationServer = (posts: Posts, breakage: Breakage) => {
    let next = 100;
    const resource = (id: string, post: Stored) => ({
      type: "posts",
      id,
      attributes: { title: post.title },
      relationships: { author: { data: post.author }, tags: { data: post.tags } },
    });
    const honours = (asked: string | undefined): asked is string =>
      asked !== undefined && (breakage.clientIds ?? "supported") === "supported";
    const refusesId = (asked: string | undefined): boolean =>
      asked !== undefined && breakage.clientIds === "unsupported";
    /** The answer to a create that stored `post` under `id`, `asked` the id it carried. */
    const created = (id: string, post: Stored, asked: string | undefined): Canned =>
      asked !== undefined && breakage.noContent === true
        ? { status: 204 }
        : { status: 201, body: { data: resource(id, post) } };
    const onCreate = (request: CannedRequest): Canned =>
      Option.match(decodeBody(request.body), {
        onNone: () => refused(400),
        onSome: ({ data }) => {
          if (refusesId(data.id)) return forbidden(breakage.pointer ?? "id");
          const id = honours(data.id) ? data.id : `${next++}`;
          if (posts.has(id) && breakage.overwrites !== true) return refused(409);
          const post: Stored = { title: data.attributes?.title ?? "", author: null, tags: [] };
          posts.set(id, post);
          return created(id, post, data.id);
        },
      });
    /** What an accepted write to `name` answers, `before` its linkage as the write found it. */
    const answer = (
      post: Stored,
      name: "author" | "tags",
      before: Stored["author"] | Stored["tags"],
    ): Canned =>
      Match.value(breakage.responds ?? "204").pipe(
        Match.when("linkage", (): Canned => ({ body: { data: post[name] } })),
        Match.when("meta", (): Canned => ({ body: { meta: { applied: true } } })),
        Match.when("stale", (): Canned => ({ body: { data: before } })),
        Match.when("201", (): Canned => ({ status: 201 })),
        Match.when("202", (): Canned => ({ status: 202 })),
        Match.orElse((): Canned => ({ status: 204 })),
      );
    /**
     * Whether a write of `data` by `method` names a resource that does not
     * exist and is answered 404: a `PATCH` or `POST` is, unless it
     * `linksAbsent`; a `DELETE`, already missing it, only when it
     * `removesAbsent404`.
     */
    const absent = (method: string, data: Stored["author"] | ReadonlyArray<Identifier>): boolean =>
      (method === "DELETE" ? breakage.removesAbsent404 === true : breakage.linksAbsent !== true) &&
      (Array.isArray(data) ? data : data === null ? [] : [data]).some(
        (item: Identifier) => !linkable.includes(`${item.type}:${item.id}`),
      );
    const onWrite = (request: CannedRequest, post: Stored, name: "author" | "tags"): Canned =>
      Option.match(decodeLinkage(request.body), {
        onNone: () => refused(400),
        onSome: ({ data }) => {
          if (Array.isArray(data) !== (name === "tags")) return refused(400);
          if (absent(request.method, data)) return refused(404);
          if (breakage.ignores?.includes(request.method) === true) return { status: 204 };
          const before = post[name];
          if (Array.isArray(data)) post.tags = applied(request.method, post.tags, data);
          else if (data !== null || breakage.keepsOnNull !== true)
            post.author = data as Identifier | null;
          return answer(post, name, before);
        },
      });
    const onRelationship = (
      request: CannedRequest,
      post: Stored,
      name: "author" | "tags",
    ): Canned => {
      if (request.method === "GET") return { body: { data: post[name] } };
      if (breakage.forbids?.includes(request.method) === true) return refused(403);
      return onWrite(request, post, name);
    };
    return (request: CannedRequest): Canned => {
      if (request.method === "POST" && request.path === "/posts") return onCreate(request);
      const match = /^\/posts\/([^/?]+)(?:\/relationships\/(author|tags))?$/.exec(request.path);
      const post = match === null ? undefined : posts.get(decodeURIComponent(match[1]!));
      if (match === null || post === undefined) return refused(404);
      const name = match[2] as "author" | "tags" | undefined;
      if (name !== undefined) return onRelationship(request, post, name);
      return request.method === "GET"
        ? { body: { data: resource(match[1]!, post) } }
        : refused(405);
    };
  };

  let sequence = 0;
  /** A run of the rules under test, with `breakage` and the fixture's `clientId` as given — `"none"` for none. */
  const run = async (
    breakage: Breakage = {},
    clientId: Conformance.ClientIdFixture | "none" = {
      supported: true,
      id: () => `client-${++sequence}`,
    },
    ids: Readonly<Record<string, string>> = { people: "9", tags: "7" },
    verify: typeof verifyCanned = verifyOver(mutationApi),
  ) => {
    const posts: Posts = new Map();
    const seen: Array<string> = [];
    const serve = mutationServer(posts, breakage);
    const report = await verify(
      (request) => {
        seen.push(`${request.method} ${request.path}`);
        return serve(request);
      },
      {
        ids,
        mutating: true,
        only: [...CLIENT_ID_RULES, ...RELATIONSHIP_RULES],
        writes: {
          posts: {
            create: () => ({ type: "posts", attributes: { title: `post ${++sequence}` } }),
            cleanup: (id) => Effect.sync(() => posts.delete(id)),
            clientId: clientId === "none" ? undefined : clientId,
          },
        },
      },
    );
    return { report, posts, seen, writes: report.writes ?? [] };
  };

  const tags = (report: Conformance.Report, ids: ReadonlyArray<string>) =>
    ids.map((id) => outcomeFor(report, id)._tag);

  const findingsOf = (report: Conformance.Report, id: string) => {
    const outcome = outcomeFor(report, id);
    return Predicate.isTagged(outcome, "Failed") ? outcome.findings : [];
  };

  it("passes a conformant server on every rule its fixture opts into, and leaves nothing behind", async () => {
    const { report, posts, writes } = await run();
    expect(failed(report)).toEqual([]);
    expect(
      tags(report, [
        "spec/status/create-client-id",
        "spec/status/create-conflict-id",
        ...RELATIONSHIP_RULES,
      ]),
    ).toEqual(["Passed", "Passed", ...RELATIONSHIP_RULES.map(() => "Passed")]);
    // The fixture declares client ids supported, so the 403 probe is not run.
    expect(outcomeFor(report, "spec/status/create-client-id-unsupported")).toMatchObject({
      _tag: "Skipped",
      reason: expect.stringContaining("declares client-generated ids supported"),
    });
    // Every relationship write endpoint was probed: replace twice (to-one and to-many).
    expect(outcomeFor(report, "spec/relationships/update-replaces")).toMatchObject({
      probes: 6,
    });
    // Clearing `author`, which a fresh post leaves empty: create, read, link
    // the sample, read, PATCH `null`, read back.
    expect(outcomeFor(report, "spec/relationships/update-to-one-null")).toMatchObject({
      probes: 6,
    });
    // Every write answers 204, so only the writes are counted (and what
    // precedes them): PATCH author and tags 2 each, POST 3, DELETE 5.
    expect(outcomeFor(report, "spec/relationships/write-response")).toMatchObject({
      probes: 12,
    });
    // The to-one and to-many PATCH and the POST, each linking an absent
    // resource; the DELETE is not probed for the 404.
    expect(outcomeFor(report, "spec/relationships/absent-related-404")).toMatchObject({
      probes: 6,
    });
    // The DELETE naming an absent resource instead: create, DELETE, a 204.
    expect(outcomeFor(report, "spec/relationships/remove-absent-succeeds")).toMatchObject({
      probes: 2,
    });
    expect(posts.size).toBe(0);
    expect(writes.map((write) => write.disposal)).toEqual(writes.map(() => "cleaned-up"));
    // The first create under a client id is the kit's under that id.
    expect(
      writes.filter((write) => write.rule === "spec/status/create-client-id").map((w) => w.id),
    ).toEqual([expect.stringMatching(/^client-\d+$/)]);
  });

  it("passes a 204 to a create under a client id, and cleans up under the id it sent", async () => {
    const { report, posts, writes } = await run({ noContent: true });
    expect(failed(report)).toEqual([]);
    expect(
      tags(report, ["spec/status/create-client-id", "spec/status/create-conflict-id"]),
    ).toEqual(["Passed", "Passed"]);
    expect(posts.size).toBe(0);
    expect(writes.find((write) => write.rule === "spec/status/create-client-id")).toEqual(
      expect.objectContaining({ id: expect.stringMatching(/^client-/), disposal: "cleaned-up" }),
    );
  });

  it("detects a server that drops a client-generated id and creates under its own", async () => {
    const { report, posts } = await run({ clientIds: "ignored" });
    expect(failed(report)).toEqual(["spec/status/create-client-id"]);
    expect(findingsOf(report, "spec/status/create-client-id")).toEqual([
      expect.objectContaining({
        detail: expect.stringMatching(
          /carries `posts:\d+` — the server created it under another id/,
        ),
        probe: expect.objectContaining({ method: "POST" }),
      }),
    ]);
    // With no resource under the client id, there is no duplicate to send.
    expect(outcomeFor(report, "spec/status/create-conflict-id")).toMatchObject({
      _tag: "Skipped",
      reason: expect.stringContaining("see spec/status/create-client-id"),
    });
    expect(posts.size).toBe(0);
  });

  it("detects a server that answers a duplicate client-generated id with anything but 409", async () => {
    const { report, posts, writes } = await run({ overwrites: true });
    expect(failed(report)).toEqual(["spec/status/create-conflict-id"]);
    expect(findingsOf(report, "spec/status/create-conflict-id")).toEqual([
      expect.objectContaining({
        detail: expect.stringMatching(
          /^a POST to \/posts .*, sent again while posts:client-\d+ the kit had just created holds that id, answered 201, accepting it$/,
        ),
        expected: "409 Conflict",
      }),
    ]);
    // The second answer names the id the first create holds, so the kit
    // refuses it; the first is disposed of, which leaves the store empty.
    expect(writes.filter((write) => write.rule === "spec/status/create-conflict-id")).toEqual([
      expect.objectContaining({ disposal: "cleaned-up" }),
      expect.objectContaining({ id: undefined, disposal: "left" }),
    ]);
    expect(posts.size).toBe(0);
  });

  it("probes the 403 only where the fixture declares client ids unsupported", async () => {
    const unsupported = { supported: false, id: () => `client-${++sequence}` };
    const passing = await run({ clientIds: "unsupported" }, unsupported);
    expect(failed(passing.report)).toEqual([]);
    expect(outcomeFor(passing.report, "spec/status/create-client-id-unsupported")._tag).toBe(
      "Passed",
    );
    expect(
      tags(passing.report, ["spec/status/create-client-id", "spec/status/create-conflict-id"]),
    ).toEqual(["Skipped", "Skipped"]);

    // What `Endpoint.create` does (#429): drops the id and answers 201.
    const { report, posts, writes } = await run({ clientIds: "ignored" }, unsupported);
    expect(failed(report)).toEqual(["spec/status/create-client-id-unsupported"]);
    expect(findingsOf(report, "spec/status/create-client-id-unsupported")).toEqual([
      expect.objectContaining({
        detail: expect.stringMatching(
          /answered 201, accepting it under the id "\d+" of its own, ignoring the one sent$/,
        ),
        expected: "403 Forbidden",
      }),
    ]);
    expect(posts.size).toBe(0);
    expect(writes.map((write) => write.disposal)).toEqual(writes.map(() => "cleaned-up"));
  });

  it.each([
    [
      "names the resource object, not its id",
      "resource",
      'names `source.pointer` "/data", not the resource\'s id',
    ],
    ["names no pointer", "none", "names no `source.pointer`"],
  ] as const)("detects a 403 to a create under a client id that %s", async (_, pointer, detail) => {
    const unsupported = { supported: false, id: () => `client-${++sequence}` };
    const { report } = await run({ clientIds: "unsupported", pointer }, unsupported);
    expect(failed(report)).toEqual(["spec/status/create-client-id-unsupported"]);
    expect(findingsOf(report, "spec/status/create-client-id-unsupported")).toEqual([
      expect.objectContaining({
        detail: expect.stringContaining(detail),
        expected: "403 Forbidden with an error object whose `source.pointer` is /data/id",
      }),
    ]);
  });

  it("never makes up a client id: without `clientId` every client id rule skips naming it", async () => {
    const { report, seen } = await run({}, "none");
    expect(tags(report, CLIENT_ID_RULES)).toEqual(["Skipped", "Skipped", "Skipped"]);
    for (const id of CLIENT_ID_RULES)
      expect(outcomeFor(report, id)).toMatchObject({
        reason: expect.stringContaining('pass writes["posts"].clientId'),
      });
    // The relationship rules still ran — 13 creates — and no create carried an id.
    expect(seen.filter((line) => line === "POST /posts").length).toBe(13);
  });

  it.each([
    ["PATCH", "spec/relationships/update-replaces"],
    ["POST", "spec/relationships/add-appends"],
    ["DELETE", "spec/relationships/remove-deletes"],
  ])("detects a server whose %s on a relationship changes nothing", async (method, id) => {
    const { report, posts } = await run({ ignores: [method] });
    expect(failed(report)).toEqual([id]);
    const findings = findingsOf(report, id);
    expect(findings).not.toEqual([]);
    for (const found of findings) {
      expect(found.probe?.method).toBe(method);
      expect(found.detail).toMatch(/reads back/);
    }
    expect(posts.size).toBe(0);
  });

  it("decides nothing on a relationship write the server forbids", async () => {
    const { report } = await run({ forbids: ["DELETE"] });
    expect(failed(report)).toEqual([]);
    expect(outcomeFor(report, "spec/relationships/remove-deletes")).toMatchObject({
      _tag: "Skipped",
      reason: expect.stringContaining("did not accept DELETE"),
    });
  });

  it("skips the relationship rules naming the `ids` sample they want", async () => {
    const { report, seen } = await run({}, "none", { people: "9" });
    expect(outcomeFor(report, "spec/relationships/add-appends")).toMatchObject({
      _tag: "Skipped",
      reason: expect.stringContaining('pass ids["tags"]'),
    });
    // The to-one replacement still has its sample.
    expect(outcomeFor(report, "spec/relationships/update-replaces")).toMatchObject({
      _tag: "Passed",
      note: expect.stringContaining('ids["tags"]'),
    });
    // Nothing is created for a probe that cannot link anything: of the 13
    // creates a full run makes, only the three on \`author\` (replace, clear and
    // the answer to a replace), the three for the 404 and the one for the
    // absent removal — which name \`absentId\`, not a sample — remain.
    expect(seen.filter((line) => line === "POST /posts").length).toBe(7);
  });

  it('detects a server that answers `{ "data": null }` to a to-one relationship and changes nothing', async () => {
    const { report, posts } = await run({ keepsOnNull: true });
    expect(failed(report)).toEqual(["spec/relationships/update-to-one-null"]);
    expect(findingsOf(report, "spec/relationships/update-to-one-null")).toEqual([
      expect.objectContaining({
        detail: expect.stringMatching(
          /^after PATCH \S+\/relationships\/author replacing its linkage with `null`, \S+ reads back \[people:9\]$/,
        ),
        expected: "no linkage",
        probe: expect.objectContaining({ method: "PATCH" }),
      }),
    ]);
    expect(posts.size).toBe(0);
  });

  it.each(["linkage", "meta"] as const)(
    "passes a relationship write answered 200 with %s",
    async (responds) => {
      const { report } = await run({ responds });
      expect(failed(report)).toEqual([]);
      expect(outcomeFor(report, "spec/relationships/write-response")._tag).toBe("Passed");
    },
  );

  it("detects a 200 whose linkage is not the relationship as it now stands", async () => {
    const { report, posts } = await run({ responds: "stale" });
    expect(failed(report)).toEqual(["spec/relationships/write-response"]);
    const findings = findingsOf(report, "spec/relationships/write-response");
    // Each of the four writes answers what the relationship held before it.
    expect(findings).toEqual(
      ["PATCH", "PATCH", "POST", "DELETE"].map((method) =>
        expect.objectContaining({
          detail: expect.stringMatching(/, but \S+ then reads back /),
          probe: expect.objectContaining({ method }),
        }),
      ),
    );
    expect(posts.size).toBe(0);
  });

  it("detects a relationship write answered with a status the specification does not name", async () => {
    const { report } = await run({ responds: "201" });
    // The DELETE naming an absent resource answers 201 too.
    expect(failed(report)).toEqual([
      "spec/relationships/write-response",
      "spec/relationships/remove-absent-succeeds",
    ]);
    expect(findingsOf(report, "spec/relationships/remove-absent-succeeds")).toEqual([
      expect.objectContaining({
        detail: expect.stringMatching(/^DELETE \S+\/relationships\/tags answered 201$/),
      }),
    ]);
    const findings = findingsOf(report, "spec/relationships/write-response");
    expect(findings).toHaveLength(4);
    expect(findings).toEqual(
      findings.map(() =>
        expect.objectContaining({
          detail: expect.stringMatching(/answered 201$/),
          expected: expect.stringMatching(/^202, 204 with no document, or 200/),
        }),
      ),
    );
  });

  it("detects a server that links a resource that does not exist rather than answer 404", async () => {
    const { report, posts } = await run({ linksAbsent: true });
    expect(failed(report)).toEqual(["spec/relationships/absent-related-404"]);
    expect(
      findingsOf(report, "spec/relationships/absent-related-404").map((found) => found.detail),
    ).toEqual([
      expect.stringMatching(
        /^PATCH \S+\/relationships\/author linking people:conformance-absent-id-0000, which does not exist, answered 204$/,
      ),
      expect.stringMatching(
        /^PATCH \S+\/relationships\/tags linking tags:conformance-absent-id-0000/,
      ),
      expect.stringMatching(
        /^POST \S+\/relationships\/tags linking tags:conformance-absent-id-0000/,
      ),
    ]);
    expect(posts.size).toBe(0);
  });

  it("detects a server that answers 404 to a DELETE naming a resource that does not exist", async () => {
    const { report, posts } = await run({ removesAbsent404: true });
    expect(failed(report)).toEqual(["spec/relationships/remove-absent-succeeds"]);
    expect(findingsOf(report, "spec/relationships/remove-absent-succeeds")).toEqual([
      expect.objectContaining({
        detail: expect.stringMatching(
          /^DELETE \S+\/relationships\/tags removing tags:conformance-absent-id-0000, which does not exist, answered 404: /,
        ),
        expected: expect.stringMatching(/^202, 204 with no document, or 200/),
        probe: expect.objectContaining({ method: "DELETE" }),
      }),
    ]);
    expect(posts.size).toBe(0);
  });

  it("decides nothing on a DELETE naming an absent resource that the server forbids", async () => {
    const { report } = await run({ forbids: ["DELETE"] });
    expect(outcomeFor(report, "spec/relationships/remove-absent-succeeds")).toMatchObject({
      _tag: "Skipped",
      reason: expect.stringContaining("answered 403 Forbidden"),
    });
  });

  it("judges a 200 to a DELETE naming an absent resource against the linkage read back", async () => {
    const conformant = await run({ responds: "linkage" });
    expect(
      outcomeFor(conformant.report, "spec/relationships/remove-absent-succeeds"),
    ).toMatchObject({ _tag: "Passed", probes: 3 });
  });

  it("judges a 200's linkage by what the write leaves when there is no relationship GET to read", async () => {
    // `author` with a PATCH and no GET: the read-back rules cannot decide it.
    const unread = HttpApi.make("unread").add(
      Group.make(
        Post,
        Endpoint.get(Post),
        Endpoint.create(Post),
        Endpoint.updateRelationship(Post, "author"),
      ),
    );
    const conformant = await run({ responds: "linkage" }, "none", undefined, verifyOver(unread));
    expect(outcomeFor(conformant.report, "spec/relationships/write-response")).toMatchObject({
      _tag: "Passed",
      probes: 2,
    });
    const { report } = await run({ responds: "stale" }, "none", undefined, verifyOver(unread));
    expect(failed(report)).toEqual(["spec/relationships/write-response"]);
    expect(findingsOf(report, "spec/relationships/write-response")).toEqual([
      expect.objectContaining({
        detail: expect.stringMatching(
          /^the 200 to PATCH \S+\/relationships\/author carries no linkage, but the write leaves \[people:9\]$/,
        ),
      }),
    ]);
  });

  it("passes a 202 as the answer to a relationship write, and reads nothing back after one", async () => {
    const { report } = await run({ responds: "202" });
    expect(failed(report)).toEqual([]);
    expect(outcomeFor(report, "spec/relationships/write-response")._tag).toBe("Passed");
    const readBacks = [
      "spec/relationships/update-replaces",
      "spec/relationships/update-to-one-null",
      "spec/relationships/add-appends",
    ];
    expect(readBacks.map((id) => outcomeFor(report, id))).toEqual(
      readBacks.map(() =>
        expect.objectContaining({
          _tag: "Skipped",
          reason: expect.stringContaining("answered 202 Accepted"),
        }),
      ),
    );
  });

  it("decides nothing on a 404 probe the server forbids", async () => {
    const forbidden = await run({ forbids: ["PATCH", "POST"] });
    expect(outcomeFor(forbidden.report, "spec/relationships/absent-related-404")).toMatchObject({
      _tag: "Skipped",
      reason: expect.stringContaining("answered 403 Forbidden"),
    });
    // The DELETE still runs, linked first through a POST the server forbids.
    expect(outcomeFor(forbidden.report, "spec/relationships/write-response")._tag).toBe("Skipped");
  });
});

// ---------------------------------------------------------------------------
// Client-generated ids through the atomic operations endpoint
// ---------------------------------------------------------------------------

/**
 * The client-generated id rules for an atomic `add` (#471), against a canned
 * operations endpoint over a store of posts, conformant by default, with one
 * switch per deliberate breakage. Each request carries one `add`, so a refusal
 * applies nothing.
 */
describe("Conformance: client-generated ids through atomic operations", () => {
  const Post = Resource.make("posts", { attributes: { title: Schema.String } });
  const atomicApi = HttpApi.make("atomicClientIds")
    .add(Group.make(Post, Endpoint.get(Post)))
    .add(Group.make("operations", Endpoint.operations([Post])));
  const atomicType = `${MEDIA_TYPE};ext="${ATOMIC_EXTENSION_URI}"`;

  /** How the canned server departs from the extension, one switch per breakage. */
  interface Breakage {
    /** What an `add` carrying an id does: honour it (the default), refuse it with 403, or drop it. */
    readonly clientIds?: "supported" | "unsupported" | "ignored";
    /** Answer an `add` under a client id with a result carrying no `data`. */
    readonly bareResult?: boolean;
    /** Answer an `add` under a client id with 204 No Content. */
    readonly noContent?: boolean;
    /** Overwrite a post on an `add` under an id it already holds, rather than 409. */
    readonly overwrites?: boolean;
    /**
     * What the 403 names as `source.pointer`: the operation's id (the
     * default), `/data/id` as a create endpoint's refusal would, the operation
     * itself, or nothing.
     */
    readonly pointer?: "id" | "create" | "operation" | "none";
    /** Refuse every `add` over its `type`, as an endpoint that does not take it would. */
    readonly refusesType?: boolean;
  }

  const Operations = Schema.Struct({
    "atomic:operations": Schema.Tuple([
      Schema.Struct({
        op: Schema.Literal("add"),
        data: Schema.Struct({
          type: Schema.Literal("posts"),
          id: Schema.optionalKey(Schema.String),
          attributes: Schema.Struct({ title: Schema.String }),
        }),
      }),
    ]),
  });
  const decodeOperations = Schema.decodeUnknownOption(Operations);

  /** An error document of `code`, its one error naming `pointer` as its source. */
  const refused = (code: number, pointer: string): Canned => ({
    status: code,
    contentType: atomicType,
    body: { errors: [{ status: `${code}`, source: { pointer } }] },
  });
  const ID_POINTER = "/atomic:operations/0/data/id";
  const POINTERS = { id: ID_POINTER, create: "/data/id", operation: "/atomic:operations/0" };
  /** The 403 refusing a client id, naming the pointer `named` picks, or none. */
  const forbidden = (named: NonNullable<Breakage["pointer"]>): Canned =>
    named === "none"
      ? { status: 403, contentType: atomicType, body: { errors: [{ status: "403" }] } }
      : refused(403, POINTERS[named]);

  /** An `add` result: the post it made as `data`, or no `data`. */
  interface AddResult {
    readonly data?: {
      readonly type: "posts";
      readonly id: string;
      readonly attributes: { readonly title: string };
    };
  }

  /** The one `add` result of a request. */
  const results = (result: AddResult): Canned => ({
    contentType: atomicType,
    body: { "atomic:results": [result] },
  });

  /**
   * An operations endpoint over `posts` that applies the one `add` a request
   * carries; every other request answers 404 (the rules under test read
   * nothing back).
   */
  const atomicServer = (
    posts: MutableHashMap.MutableHashMap<string, string>,
    breakage: Breakage,
  ) => {
    let next = 100;
    const mode = breakage.clientIds ?? "supported";
    /** The refusal of an `add` the server does not apply, if it refuses it. */
    const refusal = (asked: Option.Option<string>): Option.Option<Canned> => {
      if (breakage.refusesType === true)
        return Option.some(refused(400, "/atomic:operations/0/data/type"));
      if (Option.isNone(asked) || mode !== "unsupported") return Option.none();
      return Option.some(forbidden(breakage.pointer ?? "id"));
    };
    /** The answer to an `add` stored under `id`, `asked` the id it carried. */
    const added = (asked: Option.Option<string>, id: string, title: string): Canned => {
      const data: AddResult = { data: { type: "posts", id, attributes: { title } } };
      if (Option.isNone(asked)) return results(data);
      if (breakage.noContent === true) return { status: 204 };
      return results(breakage.bareResult === true ? {} : data);
    };
    const onAdd = (asked: Option.Option<string>, title: string): Canned =>
      Option.getOrElse(refusal(asked), () => {
        const id = mode === "supported" ? Option.getOrElse(asked, () => `${next++}`) : `${next++}`;
        if (MutableHashMap.has(posts, id) && breakage.overwrites !== true)
          return refused(409, ID_POINTER);
        MutableHashMap.set(posts, id, title);
        return added(asked, id, title);
      });
    return (request: CannedRequest): Canned =>
      request.method === "POST" && request.path === "/operations"
        ? Option.match(decodeOperations(request.body), {
            onNone: () => refused(400, "/atomic:operations"),
            onSome: (document) => {
              const [{ data }] = document["atomic:operations"];
              return onAdd(Option.fromUndefinedOr(data.id), data.attributes.title);
            },
          })
        : refused(404, "/");
  };

  let sequence = 0;
  const run = async (
    breakage: Breakage = {},
    clientId: Conformance.ClientIdFixture | "none" = {
      supported: true,
      id: () => `client-${++sequence}`,
    },
  ) => {
    const posts = MutableHashMap.empty<string, string>();
    const seen: Array<string> = [];
    const serve = atomicServer(posts, breakage);
    const report = await verifyOver(atomicApi)(
      (request) => {
        seen.push(`${request.method} ${request.path}`);
        return serve(request);
      },
      {
        ids: {},
        mutating: true,
        only: ATOMIC_CLIENT_ID_RULES,
        writes: {
          posts: {
            create: () => ({ type: "posts", attributes: { title: `post ${++sequence}` } }),
            cleanup: (id) => Effect.sync(() => MutableHashMap.remove(posts, id)),
            clientId: clientId === "none" ? undefined : clientId,
          },
        },
      },
    );
    return { report, posts, seen, writes: report.writes ?? [] };
  };
  const unsupported = { supported: false, id: () => `client-${++sequence}` };

  const tags = (report: Conformance.Report) =>
    ATOMIC_CLIENT_ID_RULES.map((id) => outcomeFor(report, id)._tag);

  const findingsOf = (report: Conformance.Report, id: string) => {
    const outcome = outcomeFor(report, id);
    return Predicate.isTagged(outcome, "Failed") ? outcome.findings : [];
  };

  it("passes a server that honours the id, and leaves nothing behind", async () => {
    const { report, posts, writes } = await run();
    expect(tags(report)).toEqual(["Passed", "Passed", "Skipped"]);
    expect(outcomeFor(report, "spec/atomic/add-client-id-unsupported")).toMatchObject({
      reason: expect.stringContaining("declares client-generated ids supported"),
    });
    expect(MutableHashMap.size(posts)).toBe(0);
    expect(writes.map((write) => write.disposal)).toEqual(writes.map(() => "cleaned-up"));
    expect(
      writes.filter((write) => write.rule === "spec/atomic/add-client-id").map((w) => w.id),
    ).toEqual([expect.stringMatching(/^client-\d+$/)]);
  });

  it.each([
    ["a result with no `data`", { bareResult: true }],
    ["204 No Content", { noContent: true }],
  ])("passes %s, and cleans up under the id it sent", async (_, breakage) => {
    const { report, posts, writes } = await run(breakage);
    expect(tags(report)).toEqual(["Passed", "Passed", "Skipped"]);
    expect(MutableHashMap.size(posts)).toBe(0);
    expect(writes.find((write) => write.rule === "spec/atomic/add-client-id")).toEqual(
      expect.objectContaining({ id: expect.stringMatching(/^client-/), disposal: "cleaned-up" }),
    );
  });

  it("detects a server that drops the id and creates under its own", async () => {
    const { report, posts } = await run({ clientIds: "ignored" });
    expect(failed(report)).toEqual(["spec/atomic/add-client-id"]);
    expect(findingsOf(report, "spec/atomic/add-client-id")).toEqual([
      expect.objectContaining({
        detail: expect.stringMatching(
          /^the 200 to an atomic `add` to \/operations .* carries `posts:\d+` — the server created it under another id/,
        ),
        probe: expect.objectContaining({ method: "POST" }),
      }),
    ]);
    expect(outcomeFor(report, "spec/atomic/add-conflict-id")).toMatchObject({
      _tag: "Skipped",
      reason: expect.stringContaining("see spec/atomic/add-client-id"),
    });
    expect(MutableHashMap.size(posts)).toBe(0);
  });

  it("detects a server that answers a duplicate id with anything but 409", async () => {
    const { report, posts, writes } = await run({ overwrites: true });
    expect(failed(report)).toEqual(["spec/atomic/add-conflict-id"]);
    expect(findingsOf(report, "spec/atomic/add-conflict-id")).toEqual([
      expect.objectContaining({
        detail: expect.stringMatching(
          /, sent again while posts:client-\d+ the kit had just created holds that id, answered 200, accepting it$/,
        ),
        expected: "409 Conflict",
      }),
    ]);
    // The second answer names the id the first holds, so the kit refuses it;
    // the first is disposed of, which leaves the store empty.
    expect(writes.filter((write) => write.rule === "spec/atomic/add-conflict-id")).toEqual([
      expect.objectContaining({ disposal: "cleaned-up" }),
      expect.objectContaining({ id: undefined, disposal: "left" }),
    ]);
    expect(MutableHashMap.size(posts)).toBe(0);
  });

  it("passes a 403 naming the operation where the fixture declares ids unsupported", async () => {
    const { report, seen } = await run({ clientIds: "unsupported" }, unsupported);
    expect(tags(report)).toEqual(["Skipped", "Skipped", "Passed"]);
    expect(seen).toEqual(["POST /operations"]);
  });

  it("detects a server that accepts an unsupported id", async () => {
    const { report, posts, writes } = await run({ clientIds: "ignored" }, unsupported);
    expect(failed(report)).toEqual(["spec/atomic/add-client-id-unsupported"]);
    expect(findingsOf(report, "spec/atomic/add-client-id-unsupported")).toEqual([
      expect.objectContaining({
        detail: expect.stringMatching(
          /answered 200, accepting it under the id "\d+" of its own, ignoring the one sent$/,
        ),
        expected: "403 Forbidden",
      }),
    ]);
    expect(MutableHashMap.size(posts)).toBe(0);
    expect(writes.map((write) => write.disposal)).toEqual(["cleaned-up"]);
  });

  it.each([
    [
      "names `/data/id`, as a create endpoint's refusal would",
      "create",
      'names `source.pointer` "/data/id", not the operation\'s id',
    ],
    [
      "names the operation, not its id",
      "operation",
      'names `source.pointer` "/atomic:operations/0", not the operation\'s id',
    ],
    ["names no pointer", "none", "names no `source.pointer`"],
  ] as const)("detects a 403 that %s", async (_, pointer, detail) => {
    const { report } = await run({ clientIds: "unsupported", pointer }, unsupported);
    expect(failed(report)).toEqual(["spec/atomic/add-client-id-unsupported"]);
    expect(findingsOf(report, "spec/atomic/add-client-id-unsupported")).toEqual([
      expect.objectContaining({
        detail: expect.stringContaining(detail),
        expected:
          "403 Forbidden with an error object whose `source.pointer` is /atomic:operations/0/data/id",
      }),
    ]);
  });

  it("decides nothing on an `add` refused over its `type`", async () => {
    const { report } = await run({ refusesType: true }, unsupported);
    expect(outcomeFor(report, "spec/atomic/add-client-id-unsupported")).toMatchObject({
      _tag: "Skipped",
      reason: expect.stringContaining("was refused over its `type`"),
    });
  });

  it("never makes up a client id: without `clientId` every rule skips naming it", async () => {
    const { report, seen } = await run({}, "none");
    expect(tags(report)).toEqual(["Skipped", "Skipped", "Skipped"]);
    expect(ATOMIC_CLIENT_ID_RULES.map((id) => outcomeFor(report, id))).toEqual(
      ATOMIC_CLIENT_ID_RULES.map(() =>
        expect.objectContaining({
          reason: expect.stringContaining('pass writes["posts"].clientId'),
        }),
      ),
    );
    expect(seen).toEqual([]);
  });

  it("skips every rule where the api has no operations endpoint", async () => {
    const report = await verifyOver(
      HttpApi.make("plain").add(Group.make(Post, Endpoint.get(Post))),
    )(() => refused(404, "/"), { ids: {}, mutating: true, only: ATOMIC_CLIENT_ID_RULES });
    expect(ATOMIC_CLIENT_ID_RULES.map((id) => outcomeFor(report, id))).toEqual(
      ATOMIC_CLIENT_ID_RULES.map(() =>
        expect.objectContaining({ _tag: "Skipped", reason: "no atomic operations endpoint" }),
      ),
    );
  });
});
