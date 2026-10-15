/**
 * Tests for the conformance kit.
 *
 * The important ones are at the bottom: a deliberately broken server, served by
 * a canned transport, that the kit must catch — and a correct one it must not
 * flag. A kit that reports nothing against a real server is only trustworthy
 * once it has been shown to report the right things against a broken one.
 */
import { describe, expect, it } from "vite-plus/test";
import {
  Array as Arr,
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Match,
  MutableHashMap,
  Option,
  Predicate,
  Schema,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { HttpClientRequest } from "effect/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import * as Conformance from "./Conformance.js";
import * as Endpoint from "./Endpoint.js";
import * as Filter from "./Filter.js";
import * as Group from "./Group.js";
import * as Handlers from "./Handlers.js";
import * as Middleware from "./Middleware.js";
import * as Query from "./Query.js";
import * as Relationship from "./Relationship.js";
import * as Resource from "./Resource.js";
import { ATOMIC_EXTENSION_URI, MEDIA_TYPE } from "./internal/media.js";

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
  report.outcomes.filter((outcome) => outcome._tag === "Failed").map((outcome) => outcome.rule.id);

const outcomeFor = (report: Conformance.Report, id: string): Conformance.Outcome => {
  const found = report.outcomes.find((outcome) => outcome.rule.id === id);
  if (found === undefined) throw new Error(`no outcome for ${id}`);
  return found;
};

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
 * — a purely a-z name it does not know.
 */
const refusesParameter = (key: string): boolean =>
  FAMILIES.includes(key.split("[")[0] ?? key) ? !PROCESSED.includes(key) : /^[a-z]+$/.test(key);

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
    if (jsonApi.length > 0 || !wildcard) {
      const usable = jsonApi.filter((entry) => {
        if (weightOf(entry) === 0) return false;
        if (!mediaTypeParameters(entry).every((name) => name === "ext" || name === "profile"))
          return false;
        // §Extensions: this fixture supports no extension, so any `ext` is unsupported.
        return !/;\s*ext=/.test(entry);
      });
      if (usable.length === 0) {
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
    relationships: { author: { data: { type: "people", id: "9" } } },
  };
  const personObject = {
    type: "people",
    id: "9",
    attributes: project("people", {
      firstName: author.attributes.firstName,
      lastName: author.attributes.lastName,
    }),
  };
  const included = include.includes("author") ? { included: [personObject] } : {};

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
    expect(partial._tag).toBe("Passed");
    if (partial._tag === "Passed") {
      expect(partial.note).toContain("not probed");
      expect(partial.note).toContain(`ids["articles"]`);
    }

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
    expect(skipped._tag).toBe("Skipped");
    if (skipped._tag === "Skipped") expect(skipped.reason).toContain(`ids["articles"]`);
  });

  it("records the transport it drove", async () => {
    const report = await verifyCanned(conformantServe);
    expect(report.transport).toBe("http");
    expect(report.target).toBe("fixture");
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
    expect(outcome._tag).toBe("Failed");
    if (outcome._tag === "Failed") {
      expect(outcome.findings.length).toBeGreaterThan(0);
      // A finding always says what it wanted and what it got.
      for (const found of outcome.findings) {
        expect(found.expected).not.toBe("");
        expect(found.observed).not.toBe("");
      }
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
        return included.length === 0 ? body : { ...body, included: [...included, included[0]] };
      }),
  );

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

  broken(
    "a resource object with a non-string id",
    "spec/document/resource-identification",
    (canned) =>
      withData(canned, (body) => {
        const data = body["data"];
        const bad = (resource: unknown) => ({ ...(resource as object), id: 1 });
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

  broken(
    "an unknown query parameter that is not rejected",
    "spec/query/unknown-query-parameter",
    (canned, request) =>
      request.path.includes("unknown=")
        ? conformantServe({ ...request, path: request.path.split("?")[0]! })
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

  it("says a probe that got no response got none, not that it was not rejected", async () => {
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
    const noResponse = (sent: string) => ({
      _tag: "Failed",
      findings: [
        {
          detail: `${sent} got no response`,
          expected: "400 Bad Request",
          observed: expect.stringMatching(/^no response \(/),
        },
      ],
    });
    expect(outcomeFor(report, INCLUDE)).toMatchObject(
      noResponse("`?include=author` on /articles/1"),
    );
    expect(outcomeFor(report, SORT)).toMatchObject(noResponse("`?sort=title` on /articles"));
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

  it.each([503, 429, 408])("does not decide on a probe answered %i", async (status) => {
    const report = await verifyFamily((request) =>
      queryOf(request).size > 0
        ? { status, body: { errors: [{ status: `${status}` }] } }
        : familyServe()(request),
    );
    expect(Arr.map(PROBES, ([id]) => outcomeFor(report, id))).toEqual(
      Arr.map(PROBES, ([id, , url]) => ({
        _tag: "Skipped",
        rule: expect.objectContaining({ id }),
        reason: `not decided: \`${url.slice(url.indexOf("?"))}\` on ${url.split("?")[0]} answered ${status}, and a server error, a rate limit, a request timeout or a lost response says nothing of whether the server refuses the parameter`,
      })),
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
          reason: expect.stringMatching(/^not decided: .* answered no response \(/),
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

    const declared: Readonly<Record<string, ReadonlyArray<string>>> = {
      name: ["eq", "ne"],
      priceCents: ["eq", "gt", "lt"],
    };
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
      if (segments.length > 2 || segments.length === 0) return reject(key);
      const field = segments[0]!;
      const operators = declared[field];
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
      const operators = declared[condition.path];
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
      expect(outcome._tag).toBe("Skipped");
      if (outcome._tag === "Skipped") expect(outcome.reason).toContain("filter: true");
    }
  });

  it("detects a server that does not advertise the profile", async () => {
    const report = await verifyGrammar((request) => {
      const canned = grammarServe(request);
      return { ...canned, contentType: MEDIA_TYPE };
    });
    expect(failed(report)).toContain("profile/filter/advertises-profile-uri");
  });

  it("detects an operator outside the closed core being accepted", async () => {
    const report = await verifyGrammar((request) =>
      request.path.includes("definitelyNotAnOperator")
        ? { contentType: `${MEDIA_TYPE};profile="${Filter.PROFILE_URI}"`, body: { data: [row] } }
        : grammarServe(request),
    );
    const outcome = outcomeFor(report, "profile/filter/rejections");
    expect(outcome._tag).toBe("Failed");
    if (outcome._tag === "Failed") {
      expect(outcome.findings.some((found) => found.detail.includes("outside the core"))).toBe(
        true,
      );
    }
  });

  it("detects a rejection that does not name the offending key in source.parameter", async () => {
    const report = await verifyGrammar((request) => {
      const canned = grammarServe(request);
      if (canned.status !== 400) return canned;
      return { ...canned, body: { errors: [{ status: "400", title: "Bad Request" }] } };
    });
    const outcome = outcomeFor(report, "profile/filter/rejections");
    expect(outcome._tag).toBe("Failed");
    if (outcome._tag === "Failed") {
      expect(outcome.findings.every((found) => found.detail.includes("source.parameter"))).toBe(
        true,
      );
    }
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
    "spec/atomic/response-ext-parameter",
  ];

  const atomicType = `${MEDIA_TYPE};ext="${ATOMIC_EXTENSION_URI}"`;

  const Attributes = Schema.Record(Schema.String, Schema.Unknown);
  type Attributes = typeof Attributes.Type;
  const NewArticle = Schema.Struct({
    type: Schema.Literal("articles"),
    attributes: Schema.optionalKey(Attributes),
  });
  const decodeCreate = Schema.decodeUnknownOption(Schema.Struct({ data: NewArticle }));
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
        onNone: () => refusal(400, "Bad Request"),
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
    /** PATCH and DELETE on a stored article; none for anything else. */
    const onStored = (request: CannedRequest): Option.Option<Canned> => {
      const id = /^\/articles\/([^/?]+)$/.exec(request.path)?.[1];
      if (id === undefined || !MutableHashMap.has(store, id)) return Option.none();
      if (request.method === "PATCH")
        return Option.some(
          Option.match(decodeUpdate(request.body), {
            onNone: () => refusal(400, "Bad Request"),
            onSome: ({ data }) => ({ body: { data: resource(id, data.attributes ?? {}) } }),
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
    // the `include` probe was not.
    const queries = await run(undefined, undefined, {
      client: redirectingSome((_, url) => url.search !== ""),
    });
    expect(outcomeFor(queries.report, "spec/query/include-unsupported-endpoint")).toEqual({
      _tag: "Skipped",
      rule: expect.anything(),
      reason: `not decided: 1 of 2 requests the rule sent were answered by a redirect the kit does not follow or read (GET /articles/1?include=author answered ${offsite("/articles/1?include=author")}), and a rule is not passed on the answers it did read alone`,
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
    expect(outcomeFor(report, "spec/query/unknown-query-parameter")).toEqual({
      _tag: "Skipped",
      rule: expect.anything(),
      reason: `no answer to decide on: every request the rule sent was answered by a redirect the kit does not follow or read (GET /articles/1?unknown=1 answered ${refused("/articles/1?unknown=1")})`,
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
   * of `canned`. `sent` is every URL it sent on.
   */
  const rewritingOrigin = () => {
    const sent: Array<string> = [];
    return {
      sent,
      rewrite: (client: HttpClient.HttpClient) =>
        HttpClient.mapRequest(client, (request) =>
          HttpClientRequest.setUrl(
            request,
            request.url.replace("http://fixture.test", "http://127.0.0.1:4010"),
          ),
        ),
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

  it("names a redirect the transport followed off the origin in the rule it leaves undecided", async () => {
    const unknown = await run(undefined, undefined, {
      client: followingOffsite((_, url) => url.searchParams.has("unknown")),
    });
    expect(outcomeFor(unknown.report, "spec/query/unknown-query-parameter")).toEqual({
      _tag: "Skipped",
      rule: expect.anything(),
      reason: `no answer to decide on: every request the rule sent was answered by a redirect the kit does not follow or read (GET /articles/1?unknown=1 answered ${followed("/articles/1?unknown=1")})`,
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
    expect(writes.map((write) => write.rule)).toEqual(WRITE_RULES);
    expect(disposals(writes)).toEqual([
      "cleaned-up",
      "cleaned-up",
      "cleaned-up",
      "cleaned-up",
      "deleted",
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
    // Only the rule whose probe died is Errored, and it names the defect.
    const errored = report.outcomes.filter((outcome) => Predicate.isTagged(outcome, "Errored"));
    expect(errored.map((outcome) => outcome.rule.id)).toEqual(["spec/status/update-response"]);
    expect(errored[0]).toMatchObject({ message: "TransportFellOver" });
    expect(Predicate.isTagged(errored[0], "Errored") && errored[0].defect).toBeInstanceOf(
      TransportFellOver,
    );
    // The rules after it still ran, the write rules among them.
    expect(failed(report)).toEqual([]);
    const survivors = WRITE_RULES.filter((id) => id !== "spec/status/update-response");
    expect(survivors.map((id) => outcomeFor(report, id)._tag)).toEqual(
      survivors.map(() => "Passed"),
    );
    // The ledger survives, the dead rule's creation included, and it was
    // cleaned up.
    expect(writes.map((write) => write.rule)).toEqual(WRITE_RULES);
    expect(disposals(writes)).not.toContain("left");
    expect(MutableHashMap.size(store)).toBe(0);
    expect(Conformance.summarise(report).errored).toBe(1);
    const text = Conformance.format(report);
    expect(text).toContain("DIED  spec/status/update-response");
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
    expect(errored.map((outcome) => outcome.rule.id)).toEqual(WRITE_RULES);
    expect(errored.map((outcome) => outcome.message)).toEqual(
      WRITE_RULES.map(() => "FixturesUnreadable"),
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
    expect(stuck.length).toBe(WRITE_RULES.length - 1);
    expect(stuck[0]?.detail).toContain("store offline");
    expect(MutableHashMap.size(store)).toBe(WRITE_RULES.length - 1);
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
        expect(outcomeFor(report, "spec/status/update-response")).toEqual(
          skippedFor(`writes["articles"].update threw: ${rendered}`),
        );
        const others = WRITE_RULES.filter((id) => id !== "spec/status/update-response");
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
    expect(stuck.length).toBe(WRITE_RULES.length - 1);
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
    expect(left.length).toBe(WRITE_RULES.length - 1);
    expect(left[0]?.detail).toContain(`writes["articles"].cleanup`);
    expect(MutableHashMap.size(store)).toBe(WRITE_RULES.length - 1);
    const text = Conformance.format(report);
    expect(text).toContain("WRITES");
    expect(text).toContain(`${WRITE_RULES.length - 1} still in place`);
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
        WRITE_RULES.map(() =>
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
        WRITE_RULES.map(() =>
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
      WRITE_RULES.map(() =>
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
      ...WRITE_RULES.slice(1).map(() => [undefined, "left"]),
    ]);
    expect(writes[1]?.detail).toMatch(/`articles:500`.*not touched/);
  });

  it("accepts an id the server reuses once the kit has removed its first holder", async () => {
    const { report, store, writes } = await run(undefined, undefined, { reuseIds: true });
    expect(failed(report)).toEqual([]);
    expect(writes.map((write) => write.id)).toEqual(WRITE_RULES.map(() => "100"));
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
          method: expect.stringMatching(/POST|PATCH|DELETE/),
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
  // of the five create-endpoint rules leaves its resource behind, and the
  // report says so rather than pretending otherwise.
  brokenWrite(
    "a 201 whose primary data is not the created resource",
    "spec/status/create-response-document",
    (canned, request) =>
      creates(request, canned) ? { ...canned, body: { meta: { ok: true } } } : canned,
    5,
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
    "an atomic response without the extension's media type",
    "spec/atomic/response-ext-parameter",
    (canned, request) =>
      request.path === "/operations" && (canned.status ?? 200) === 200
        ? { ...canned, contentType: MEDIA_TYPE }
        : canned,
  );
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
          links: { related: `/articles/${id}/author` },
          data: { type: "people", id: "9" },
        },
        tags: site.tags?.(id) ?? {
          links: { related: `/articles/${id}/tags` },
          data: [
            { type: "tags", id: "1" },
            { type: "tags", id: "2" },
          ],
        },
        // Paginated: links only, no linkage.
        comments: site.comments?.(id) ?? { links: { related: `/articles/${id}/comments` } },
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

  /**
   * A server whose every link resolves to what it names: `/articles`, each
   * article, its author, its two tags and its (paginated) comments.
   */
  const linked =
    (site: Site = {}) =>
    (request: CannedRequest): Canned => {
      const ids = site.ids ?? ["1", "2"];
      const article = articleOf(site);
      const path = withoutQuery(request).path;
      if (path === "/articles") return { body: { data: ids.map(article) } };
      const match = /^\/articles\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
      const id = match?.[1];
      if (id === undefined || !ids.includes(id)) return notFound;
      return Match.value(match?.[2]).pipe(
        Match.when(undefined, (): Canned => ({ body: { data: article(id) } })),
        Match.when("author", (): Canned => ({ body: { data: person("9") } })),
        Match.when("tags", (): Canned => ({ body: { data: [tag("1"), tag("2")] } })),
        Match.when("comments", (): Canned => ({
          body: { data: [comment("5")], links: { next: null } },
        })),
        Match.orElse(() => notFound),
      );
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
  ) => verifyCanned(serve, { only: [SELF, RELATED, MATCHES] }, client);

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
    expect(
      Conformance.rules.map(({ id }) => id).filter((id) => id.startsWith("spec/links/")),
    ).toEqual([SELF, RELATED, MATCHES]);
    expect(Conformance.gaps.map(({ area }) => area)).not.toContain("Link dereferenceability");
    // What it does not follow yet is declared, narrower, in its place.
    expect(
      Conformance.gaps.find(({ area }) => area === "Relationship and top-level `self` links")
        ?.tracking,
    ).toEqual(["#309"]);
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
    const report = await run({ only: ["spec/content-negotiation/accept-weight"] });
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
