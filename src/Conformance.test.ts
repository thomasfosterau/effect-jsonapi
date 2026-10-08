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
import { HttpClient, HttpClientResponse } from "effect/http";
import type { HttpClientRequest } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import type { HttpApiGroup } from "effect/http-api";
import * as Conformance from "./Conformance.js";
import * as Endpoint from "./Endpoint.js";
import * as Filter from "./Filter.js";
import * as Group from "./Group.js";
import * as Handlers from "./Handlers.js";
import * as Middleware from "./Middleware.js";
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

const verifyCanned = verifyOver(api);

const failed = (report: Conformance.Report): ReadonlyArray<string> =>
  report.outcomes.filter((outcome) => outcome._tag === "Failed").map((outcome) => outcome.rule.id);

const outcomeFor = (report: Conformance.Report, id: string): Conformance.Outcome => {
  const found = report.outcomes.find((outcome) => outcome.rule.id === id);
  if (found === undefined) throw new Error(`no outcome for ${id}`);
  return found;
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
  const reserved = new Set(["include", "sort", "page", "filter", "fields"]);
  for (const key of params.keys()) {
    const family = key.split("[")[0]!;
    if (reserved.has(family)) continue;
    // §Query Parameters: an implementation-specific name must carry a non a-z
    // character; a purely a-z name the server does not know is a 400.
    if (/^[a-z]+$/.test(key)) {
      return {
        status: 400,
        body: { errors: [{ status: "400", title: "Bad Request", source: { parameter: key } }] },
      };
    }
  }

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

  // A fixture that throws a value the kit can render is not a defect: no rule
  // dies of it. One it can't render still does, until #271.
  it.each([
    {
      member: "create",
      expected: (report: Conformance.Report, writes: ReadonlyArray<Conformance.Write>) => {
        everyWriteRule(report, `writes["articles"].create threw: FixtureBroke: create broke`);
        expect(writes).toEqual([]);
      },
    },
    {
      member: "update",
      expected: (report: Conformance.Report, writes: ReadonlyArray<Conformance.Write>) => {
        expect(outcomeFor(report, "spec/status/update-response")).toEqual(
          skippedFor(`writes["articles"].update threw: FixtureBroke: update broke`),
        );
        const others = WRITE_RULES.filter((id) => id !== "spec/status/update-response");
        expect(others.map((id) => outcomeFor(report, id)._tag)).toEqual(others.map(() => "Passed"));
        expect(disposals(writes)).not.toContain("left");
      },
    },
    {
      member: "cleanup",
      expected: (report: Conformance.Report, writes: ReadonlyArray<Conformance.Write>) => {
        everyWriteRule(report);
        const stuck = writes.filter((write) => write.disposal === "cleanup-failed");
        // Every creation but the one the kit's own DELETE removed.
        expect(stuck.length).toBe(WRITE_RULES.length - 1);
        expect(stuck[0]?.detail).toContain("cleanup broke");
      },
    },
  ] as const)(
    "skips or records — never dies — when the fixture's $member throws",
    async ({ member, expected }) => {
      const { report, writes } = await run(undefined, (store, cleaned) => ({
        writes: {
          articles: {
            ...fixture(store, cleaned),
            [member]: () => {
              throw new FixtureBroke({ message: `${member} broke` });
            },
          },
        },
      }));
      expect(report.outcomes.filter((outcome) => Predicate.isTagged(outcome, "Errored"))).toEqual(
        [],
      );
      expect(failed(report)).toEqual([]);
      expected(report, writes);
    },
  );

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

  const run = (options?: Conformance.Options) =>
    Effect.runPromise(
      Conformance.verify(api, { ids: { articles: "1" }, ...options }).pipe(
        Effect.provide(Live),
        Effect.scoped,
      ) as Effect.Effect<Conformance.Report, never, never>,
    );

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
