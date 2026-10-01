/**
 * Tests for the conformance kit.
 *
 * The important ones are at the bottom: a deliberately broken server, served by
 * a canned transport, that the kit must catch — and a correct one it must not
 * flag. A kit that reports nothing against a real server is only trustworthy
 * once it has been shown to report the right things against a broken one.
 */
import { describe, expect, it } from "vite-plus/test";
import { Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import * as Conformance from "./Conformance.js";
import * as Endpoint from "./Endpoint.js";
import * as Filter from "./Filter.js";
import * as Group from "./Group.js";
import * as Handlers from "./Handlers.js";
import * as Middleware from "./Middleware.js";
import * as Relationship from "./Relationship.js";
import * as Resource from "./Resource.js";
import { MEDIA_TYPE } from "./internal/media.js";

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
}

const cannedClient = (
  serve: (request: {
    readonly method: string;
    readonly path: string;
    readonly headers: Headers;
  }) => Canned,
): HttpClient.HttpClient =>
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
      });
      const status = canned.status ?? 200;
      const contentType = canned.contentType ?? MEDIA_TYPE;
      const hasBody = canned.body !== undefined && status !== 204;
      return HttpClientResponse.fromWeb(
        request,
        new Response(hasBody ? JSON.stringify(canned.body) : null, {
          status,
          headers: hasBody ? { "content-type": contentType } : {},
        }),
      );
    }),
  );

const verifyCanned = (
  serve: (request: {
    readonly method: string;
    readonly path: string;
    readonly headers: Headers;
  }) => Canned,
  options?: Conformance.Options,
) =>
  Effect.runPromise(
    Conformance.verifyWith(api, {
      client: cannedClient(serve),
      baseUrl: "http://fixture.test",
      ids: { articles: "1" },
      ...options,
    }),
  );

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
