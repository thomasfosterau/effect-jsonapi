import { describe, expect, it } from "vite-plus/test";
import { Effect, Layer, Match, Result, Schema, SchemaTransformation, Tracer } from "effect";
import { HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import type { ContentNegotiation, SchemaErrors } from "./Middleware.js";
import * as Middleware from "./Middleware.js";
import * as Query from "./Query.js";
import * as Relationship from "./Relationship.js";
import { platformLayer } from "./Registry.js";
import * as Resource from "./Resource.js";

// JSON:API 1.1 §Query Parameters (#148): a query parameter whose family base
// name is made only of a-z is reserved for the specification, so one the
// endpoint does not process is a 400 naming it in `source.parameter`; a name
// carrying any other character is implementation-specific and still ignored.

const Article = Resource.make("articles", {
  attributes: { title: Resource.attribute(Schema.NonEmptyString, { filter: true }) },
});

const Api = HttpApi.make("blog")
  .add(
    Group.make(
      Article,
      Endpoint.get(Article),
      Endpoint.list(Article, { page: Query.Page.Offset, sort: true, filter: true }),
      Endpoint.delete(Article),
    ),
  )
  .add(
    // A hand-built endpoint that declares an all-lowercase parameter of its
    // own: declaring it is how an endpoint "knows how to process" it.
    HttpApiGroup.make("search").add(
      HttpApiEndpoint.get("search", "/search", {
        query: Schema.Struct({ q: Schema.optionalKey(Schema.String) }),
        success: Schema.Struct({ q: Schema.optionalKey(Schema.String) }),
      })
        .middleware(Middleware.ContentNegotiation)
        .middleware(Middleware.SchemaErrors),
    ),
  );

// The decoded `query` each `get` handler call received.
const getQueries: Array<unknown> = [];

const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
  handlers
    .handle("get", ({ params, query }) => {
      getQueries.push(query);
      return Effect.succeed({
        data: Article.make({ id: params.id, attributes: { title: "Hello" } }),
      });
    })
    .handle("list", () => Effect.succeed({ data: [] }))
    .handle("delete", () => Effect.void),
);

const SearchLive = HttpApiBuilder.group(Api, "search", (handlers) =>
  handlers.handle("search", ({ query }) => Effect.succeed(query)),
);

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Any));

const request = async (
  url: string,
  middlewareLayer: Layer.Layer<ContentNegotiation | SchemaErrors> = Middleware.layer,
  init: RequestInit = {},
) => {
  const spans: Array<Tracer.NativeSpan> = [];
  const recordingTracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  const appLayer = HttpApiBuilder.layer(Api).pipe(
    Layer.provide([ArticlesLive, SearchLive]),
    Layer.provide(middlewareLayer),
    Layer.provide(Layer.succeed(Tracer.Tracer, recordingTracer)),
    Layer.provide(platformLayer),
  );
  const { dispose, handler } = HttpRouter.toWebHandler(appLayer);
  const response = await handler(new Request(`http://localhost${url}`, init)).finally(dispose);
  const text = await response.text();
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: text === "" ? undefined : decodeJson(text),
    spans,
  };
};

const rejection = (parameter: string) => ({
  status: "400",
  code: "bad_request",
  title: "Bad Request",
  detail: expect.stringContaining(`"${parameter}"`),
  source: { parameter },
});

describe("unknown all-lowercase query parameters (#148)", () => {
  it("rejects `?unknown=1` with a 400 naming the parameter", async () => {
    const response = await request("/articles/1?unknown=1");
    expect(response.status).toBe(400);
    expect(response.contentType).toContain("application/vnd.api+json");
    expect(response.body).toEqual({ errors: [rejection("unknown")] });
  });

  it("tests the family base name, so a bracketed member of an unknown family is rejected too", async () => {
    const response = await request("/articles/1?foo[bar]=1");
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ errors: [rejection("foo[bar]")] });
  });

  it("answers one error object per offending parameter, a repeated key once", async () => {
    const response = await request("/articles?unknown=1&unknown=2&other=3&fooBar=4");
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ errors: [rejection("unknown"), rejection("other")] });
  });

  it("rejects on an endpoint that declares no query schema at all", async () => {
    const response = await request("/articles/1?unknown=1", Middleware.layer, {
      method: "DELETE",
    });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ errors: [rejection("unknown")] });
  });

  it.each(["fooBar=1", "x-trace=1", "foo_bar=1", "fooBar[x]=1", "ext:param=1", "x1=1"])(
    "still ignores the implementation-specific `?%s`",
    async (query) => {
      const response = await request(`/articles/1?${query}`);
      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({ type: "articles", id: "1" });
    },
  );

  it("leaves the specification's own families to the endpoint's query schema", async () => {
    expect((await request("/articles?page[limit]=1&sort=-title")).status).toBe(200);
    expect((await request("/articles?filter[title]=Hello")).status).toBe(200);
    // the family's codec still rejects a malformed value, naming it
    const malformed = await request("/articles?page[limit]=nope");
    expect(malformed.status).toBe(400);
    expect(malformed.body.errors[0].source).toEqual({ parameter: "page[limit]" });
  });

  it("accepts an all-lowercase parameter the endpoint's own query schema declares", async () => {
    const response = await request("/search?q=hello");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ q: "hello" });
    expect((await request("/search?q=hello&unknown=1")).status).toBe(400);
  });

  it("is decided before content negotiation", async () => {
    const response = await request("/articles/1?unknown=1", Middleware.layer, {
      headers: { accept: "application/vnd.api+json; charset=utf-8" },
    });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ errors: [rejection("unknown")] });
    // without the reserved parameter, the same request is the 406
    expect(
      (
        await request("/articles/1", Middleware.layer, {
          headers: { accept: "application/vnd.api+json; charset=utf-8" },
        })
      ).status,
    ).toBe(406);
  });

  it("applies under the host-negotiated layer too", async () => {
    const response = await request("/articles/1?unknown=1", Middleware.layerHostNegotiated);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ errors: [rejection("unknown")] });
  });

  it("emits Span.schemaError tagged `Query`, never the parameter name", async () => {
    const { spans, status } = await request("/articles/1?unknown=1");
    expect(status).toBe(400);
    const span = spans.find((s) => s.name === Middleware.Span.schemaError);
    expect(span?.attributes.get("jsonapi.request_part")).toBe("Query");
    expect([...(span?.attributes.keys() ?? [])]).toEqual(["jsonapi.request_part"]);
  });
});

describe("allowedQueryParameters", () => {
  const allowing = Middleware.layerWith({ allowedQueryParameters: ["lang"] });

  it.each(["lang=en", "lang[region]=au"])("admits `?%s` from a listed family", async (query) => {
    const response = await request(`/articles/1?${query}`, allowing);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ type: "articles", id: "1" });
  });

  // #260: `Endpoint.get(Article)` declares no query family, and its empty
  // query struct used to hand every parameter to the handler and to the
  // bracket reshaper, which threw (a 500) on a bare/bracketed collision.
  it.each(["lang=en", "lang[region]=au", "lang=en&lang[region]=au", "lang[region]=au&lang=en"])(
    "never hands `?%s` to the handler's decoded query",
    async (query) => {
      getQueries.length = 0;
      const response = await request(`/articles/1?${query}`, allowing);
      expect(response.status).toBe(200);
      expect(getQueries).toEqual([{}]);
    },
  );

  it("rejects every other all-lowercase family", async () => {
    const other = await request("/articles/1?lang=en&unknown=1", allowing);
    expect(other.status).toBe(400);
    expect(other.body).toEqual({ errors: [rejection("unknown")] });
  });

  it("composes with the host-negotiated passthrough through schemaErrorsLayer", async () => {
    const hostNegotiated = Layer.mergeAll(
      Middleware.ContentNegotiationPassthrough,
      Middleware.schemaErrorsLayer({ allowedQueryParameters: ["lang"] }),
    );
    const response = await request("/articles/1?lang=en", hostNegotiated, {
      headers: { accept: "application/json" },
    });
    expect(response.status).toBe(200);
    expect((await request("/articles/1?unknown=1", hostNegotiated)).status).toBe(400);
  });
});

describe("allowedQueryParameters entries", () => {
  // Each entry is a family base name made only of a-z, the only names the
  // check ever rejects. Anything else could never match one, so it is refused
  // when the layer is built rather than left to admit nothing.
  const invalid = [
    "lang[region]",
    "lang[]",
    "Lang",
    "LANG",
    " lang",
    "lang ",
    "la ng",
    "lang\n",
    "",
  ];

  it.each(invalid)("refuses %j when schemaErrorsLayer is built", (entry) => {
    const build = () => Middleware.schemaErrorsLayer({ allowedQueryParameters: [entry] });
    expect(build).toThrow(Middleware.InvalidAllowedQueryParameter);
    expect(build).toThrow(
      expect.objectContaining({
        _tag: "InvalidAllowedQueryParameter",
        parameter: entry,
        message: expect.stringContaining(`"${entry}"`),
      }),
    );
  });

  it.each(invalid)("refuses %j when layerWith is built", (entry) => {
    expect(() => Middleware.layerWith({ allowedQueryParameters: ["lang", entry] })).toThrow(
      Middleware.InvalidAllowedQueryParameter,
    );
  });

  it.each(invalid)("refuses %j in a checkQueryParameters call", (entry) => {
    expect(() =>
      Middleware.checkQueryParameters(["lang"], { allowedQueryParameters: [entry] }),
    ).toThrow(Middleware.InvalidAllowedQueryParameter);
  });

  it("names the base name to list for a bracketed entry", () => {
    expect(() =>
      Middleware.schemaErrorsLayer({ allowedQueryParameters: ["lang[region]"] }),
    ).toThrow('List its base name "lang"');
  });

  // A bracketed member of a family the specification defines: listing its
  // base name would be refused in turn, so the advice is the family's own.
  it.each(["page[size]", "filter[status]", "fields[articles]", "include[]", "sort[x][y]"])(
    "refuses %j as a member of a specification family, not by its base name",
    (entry) => {
      const family = entry.slice(0, entry.indexOf("["));
      const build = () => Middleware.schemaErrorsLayer({ allowedQueryParameters: [entry] });
      expect(build).toThrow(
        expect.objectContaining({
          _tag: "InvalidAllowedQueryParameter",
          parameter: entry,
          message: expect.stringContaining(
            `"${entry}" is a member of the "${family}" query parameter family JSON:API defines`,
          ),
        }),
      );
      expect(build).toThrow("declaring it in its query schema");
      expect(build).toThrow("remove the entry");
      expect(build).not.toThrow("List its base name");
      expect(() => Middleware.layerWith({ allowedQueryParameters: [entry] })).toThrow(
        `"${entry}" is a member of the "${family}" query parameter family`,
      );
      expect(() =>
        Middleware.checkQueryParameters([entry], { allowedQueryParameters: [entry] }),
      ).toThrow(`"${entry}" is a member of the "${family}" query parameter family`);
    },
  );

  // The allow-list is matched against the decoded parameter names, so a
  // percent-encoded spelling of a bracket names nothing the check ever sees:
  // its `%` makes it an implementation-specific name.
  it("refuses a percent-encoded `page%5Bsize%5D` as a name with any other character", () => {
    const build = () =>
      Middleware.schemaErrorsLayer({ allowedQueryParameters: ["page%5Bsize%5D"] });
    expect(build).toThrow(
      expect.objectContaining({
        _tag: "InvalidAllowedQueryParameter",
        parameter: "page%5Bsize%5D",
      }),
    );
    expect(build).toThrow("needs no entry");
  });

  // Family names are case-sensitive: `Page` is not the specification's
  // `page`, but an implementation-specific name the check never rejects.
  it.each(["Page", "Page[size]"])("refuses the mixed-case %j as needing no entry", (entry) => {
    const build = () => Middleware.schemaErrorsLayer({ allowedQueryParameters: [entry] });
    expect(build).toThrow("needs no entry");
    expect(build).not.toThrow("query parameter family JSON:API defines");
  });

  it("says a name with any other character needs no entry", () => {
    const build = () => Middleware.schemaErrorsLayer({ allowedQueryParameters: ["Lang"] });
    expect(build).toThrow("needs no entry");
    expect(build).not.toThrow("List its base name");
  });

  it("says an empty entry names no parameter", () => {
    const build = () => Middleware.schemaErrorsLayer({ allowedQueryParameters: [""] });
    expect(build).toThrow("An empty entry names no parameter; remove it.");
    expect(build).not.toThrow("needs no entry");
  });

  it("accepts base names made only of a-z", () => {
    expect(() =>
      Middleware.schemaErrorsLayer({ allowedQueryParameters: ["lang", "ref", "pages"] }),
    ).not.toThrow();
    expect(() => Middleware.layerWith({ allowedQueryParameters: [] })).not.toThrow();
  });

  // Owner decision on #261: the allow-list admits only implementation-
  // specific names, so a family the specification defines is never silently
  // ignored. An endpoint supports one by declaring it.
  const families = ["include", "fields", "sort", "page", "filter"];

  it.each(families)(
    "refuses the specification's family %j when schemaErrorsLayer is built",
    (entry) => {
      const build = () => Middleware.schemaErrorsLayer({ allowedQueryParameters: ["lang", entry] });
      expect(build).toThrow(Middleware.InvalidAllowedQueryParameter);
      expect(build).toThrow(
        expect.objectContaining({
          _tag: "InvalidAllowedQueryParameter",
          parameter: entry,
          message: expect.stringContaining(
            `"${entry}" names a query parameter family JSON:API defines`,
          ),
        }),
      );
    },
  );

  it.each(families)("refuses the specification's family %j when layerWith is built", (entry) => {
    expect(() => Middleware.layerWith({ allowedQueryParameters: [entry] })).toThrow(
      Middleware.InvalidAllowedQueryParameter,
    );
  });

  it.each(families)(
    "refuses the specification's family %j in a checkQueryParameters call",
    (entry) => {
      expect(() =>
        Middleware.checkQueryParameters([entry], { allowedQueryParameters: [entry] }),
      ).toThrow(Middleware.InvalidAllowedQueryParameter);
    },
  );
});

describe("Middleware.checkQueryParameters", () => {
  const check = Middleware.checkQueryParameters;

  it("returns undefined when every name is acceptable", () => {
    expect(check([])).toBeUndefined();
    expect(check(["fooBar", "x-trace", "foo_bar", "ext:name", "x1", "[odd]"])).toBeUndefined();
    expect(
      check(["fields[articles]", "page[limit]", "page[offset]", "filter[age][gt]", "filter"], {
        declared: ["fields[articles]", "page[limit]", "filter["],
      }),
    ).toBeUndefined();
  });

  it("rejects `fields`, `page` and `filter` unless declared (#261)", () => {
    expect(check(["fields[articles]", "page[limit]", "filter[age][gt]", "filter"])).toEqual({
      errors: [
        expect.objectContaining({
          detail: expect.stringContaining('does not support the "fields[articles]" parameter'),
          source: { parameter: "fields[articles]" },
        }),
        expect.objectContaining({
          detail: expect.stringContaining('does not support the "page" parameter family'),
          source: { parameter: "page[limit]" },
        }),
        expect.objectContaining({
          detail: expect.stringContaining('does not support the "filter" parameter family'),
          source: { parameter: "filter[age][gt]" },
        }),
        expect.objectContaining({
          detail: expect.stringContaining('does not support the "filter" parameter family'),
          source: { parameter: "filter" },
        }),
      ],
    });
  });

  // `fields` is per resource type: each `fields[TYPE]` is its own parameter,
  // so a declared one admits only itself, where a declared `page[limit]`
  // admits the whole `page` family.
  it("admits a `fields[TYPE]` only by its own name or a declared `fields[` prefix (#261)", () => {
    const declared = ["fields[articles]"];
    expect(check(["fields[articles]"], { declared })).toBeUndefined();
    expect(
      check(["fields[people]", "fields", "fields[articles][x]", "fields[]"], { declared })?.errors,
    ).toEqual(
      ["fields[people]", "fields", "fields[articles][x]", "fields[]"].map((parameter) =>
        expect.objectContaining({ source: { parameter } }),
      ),
    );
    expect(check(["fields[people]"], { declared: ["fields["] })).toBeUndefined();
    expect(check(["fields"], { declared: ["fields["] })?.errors).toEqual([
      expect.objectContaining({ source: { parameter: "fields" } }),
    ]);
  });

  it("rejects `include` and `sort` unless declared (#261)", () => {
    expect(check(["include", "sort[x]"])).toEqual({
      errors: [
        expect.objectContaining({
          detail: expect.stringContaining('does not support the "include" parameter'),
          source: { parameter: "include" },
        }),
        expect.objectContaining({
          detail: expect.stringContaining('does not support the "sort" parameter'),
          source: { parameter: "sort[x]" },
        }),
      ],
    });
    expect(check(["include", "sort"], { declared: ["include", "sort"] })).toBeUndefined();
    expect(check(["sort"], { declared: ["include"] })?.errors).toHaveLength(1);
  });

  it("rejects an all-lowercase base name nothing declares, naming the whole parameter", () => {
    expect(check(["unknown", "foo[bar]", "fooBar"])).toEqual({
      errors: [rejection("unknown"), rejection("foo[bar]")],
    });
  });

  it("admits a declared name's whole family, and an allowed base name", () => {
    expect(check(["q", "search[term]"], { declared: ["q", "search[term]"] })).toBeUndefined();
    expect(check(["search[other]"], { declared: ["search[term]"] })).toBeUndefined();
    expect(check(["lang", "lang[x]"], { allowedQueryParameters: ["lang"] })).toBeUndefined();
    expect(check(["lang"], { declared: ["q"] })?.errors).toHaveLength(1);
  });

  it("accepts any iterable of names, such as URLSearchParams#keys", () => {
    const names = new URLSearchParams("q=hello&unknown=1&unknown=2").keys();
    expect(check(names, { declared: ["q"] })).toEqual({ errors: [rejection("unknown")] });
  });

  // `URLSearchParams#keys` yields a repeated key once per occurrence, so this
  // is where the check's own deduplication shows: over HTTP the middleware
  // reads the parsed search params' record keys, already one per name.
  it("answers a repeated unsupported `include` or `sort` once (#261)", () => {
    const names = new URLSearchParams("include=a&sort=x&include=a&sort=y").keys();
    expect(check(names)?.errors.map((error) => error.source)).toEqual([
      { parameter: "include" },
      { parameter: "sort" },
    ]);
  });
});

describe("what an endpoint's query schema declares", () => {
  // Endpoints whose query schemas the declared-name walk must read: a union
  // of structs, a suspended struct, and a record that admits any name.
  const QueryVariantsApi = HttpApi.make("variants").add(
    HttpApiGroup.make("variants")
      .add(
        HttpApiEndpoint.get("union", "/union", {
          query: Schema.Union([
            Schema.Struct({ a: Schema.String }),
            Schema.Struct({ b: Schema.String }),
          ]),
          success: Schema.String,
        }).middleware(Middleware.SchemaErrors),
      )
      .add(
        HttpApiEndpoint.get("suspended", "/suspended", {
          query: Schema.suspend(() => Schema.Struct({ a: Schema.optionalKey(Schema.String) })),
          success: Schema.String,
        }).middleware(Middleware.SchemaErrors),
      )
      .add(
        HttpApiEndpoint.get("open", "/open", {
          query: Schema.Record(Schema.String, Schema.String),
          success: Schema.String,
        }).middleware(Middleware.SchemaErrors),
      ),
  );
  const QueryVariantsLive = HttpApiBuilder.group(QueryVariantsApi, "variants", (handlers) =>
    handlers
      .handle("union", () => Effect.succeed("ok"))
      .handle("suspended", () => Effect.succeed("ok"))
      .handle("open", () => Effect.succeed("ok")),
  );
  const serve = async (url: string) => {
    const appLayer = HttpApiBuilder.layer(QueryVariantsApi).pipe(
      Layer.provide(QueryVariantsLive),
      Layer.provide(Middleware.SchemaErrorsLive),
      Layer.provide(platformLayer),
    );
    const { dispose, handler } = HttpRouter.toWebHandler(appLayer);
    const response = await handler(new Request(`http://localhost${url}`)).finally(dispose);
    return { status: response.status, body: decodeJson(await response.text()) };
  };

  it("reads every member of a union", async () => {
    expect((await serve("/union?a=1")).status).toBe(200);
    expect((await serve("/union?b=1")).status).toBe(200);
    const rejected = await serve("/union?a=1&unknown=1");
    expect(rejected.status).toBe(400);
    expect(rejected.body).toEqual({ errors: [rejection("unknown")] });
  });

  it("reads through a suspended schema", async () => {
    expect((await serve("/suspended?a=1")).status).toBe(200);
    const rejected = await serve("/suspended?a=1&unknown=1");
    expect(rejected.status).toBe(400);
    expect(rejected.body).toEqual({ errors: [rejection("unknown")] });
  });

  it("stands aside for a schema that admits any name", async () => {
    expect((await serve("/open?unknown=1")).status).toBe(200);
  });
});

describe("spec families an endpoint does not support (#261)", () => {
  // JSON:API 1.1 §Inclusion of Related Resources: "If an endpoint does not
  // support the `include` parameter, it MUST respond with `400 Bad Request`
  // to any requests that include it." §Sorting, on an endpoint that responds
  // with a resource collection: "If the server does not support sorting as
  // specified in the query parameter `sort`, it MUST return `400 Bad
  // Request`." On any other endpoint, `sort` falls under the general
  // §Implementation-Specific Query Parameters rule: "If a server encounters a
  // query parameter that does not follow the naming conventions above, or the
  // server does not know how to process it as a query parameter from this
  // specification, it MUST return `400 Bad Request`." An endpoint supports
  // either by declaring it in its `query` schema.
  const Person = Resource.make("people", {
    attributes: { name: Schema.NonEmptyString },
  });
  const Post = Resource.make("posts", {
    attributes: { title: Schema.NonEmptyString },
    relationships: { author: Relationship.one(() => Person) },
  });
  // A resource with no attributes, so `sort: true` legalises no field, and
  // no relationships, so `include: true` and an include allow-list can only
  // be empty.
  const Tag = Resource.make("tags", { attributes: {} });

  const FamiliesApi = HttpApi.make("families")
    .add(
      Group.make(
        Post,
        Endpoint.get(Post, { include: true }),
        Endpoint.list(Post, { sort: true }),
        Endpoint.delete(Post),
      ),
    )
    .add(Group.make(Person, Endpoint.get(Person), Endpoint.list(Person, { sort: [] })))
    .add(
      Group.make(
        Tag,
        Endpoint.get(Tag, { include: { paths: [] } }),
        Endpoint.list(Tag, { include: true, sort: true }),
      ),
    );

  // The decoded `query` each handler call received.
  const queries: Array<unknown> = [];
  const FamiliesLive = Layer.mergeAll(
    HttpApiBuilder.group(FamiliesApi, "posts", (handlers) =>
      handlers
        .handle("get", ({ params, query }) => {
          queries.push(query);
          return Effect.succeed({
            data: Post.make({ id: params.id, attributes: { title: "Hello" } }),
          });
        })
        .handle("list", ({ query }) => {
          queries.push(query);
          return Effect.succeed({ data: [] });
        })
        .handle("delete", () => Effect.void),
    ),
    HttpApiBuilder.group(FamiliesApi, "people", (handlers) =>
      handlers
        .handle("get", ({ params }) =>
          Effect.succeed({ data: Person.make({ id: params.id, attributes: { name: "Ada" } }) }),
        )
        .handle("list", () => Effect.succeed({ data: [] })),
    ),
    HttpApiBuilder.group(FamiliesApi, "tags", (handlers) =>
      handlers
        .handle("get", ({ params, query }) => {
          queries.push(query);
          return Effect.succeed({ data: Tag.make({ id: params.id, attributes: {} }) });
        })
        .handle("list", ({ query }) => {
          queries.push(query);
          return Effect.succeed({ data: [] });
        }),
    ),
  );

  const serve = async (
    url: string,
    middlewareLayer: Layer.Layer<ContentNegotiation | SchemaErrors> = Middleware.layer,
    init: RequestInit = {},
  ) => {
    const appLayer = HttpApiBuilder.layer(FamiliesApi).pipe(
      Layer.provide(FamiliesLive),
      Layer.provide(middlewareLayer),
      Layer.provide(platformLayer),
    );
    const { dispose, handler } = HttpRouter.toWebHandler(appLayer);
    const response = await handler(new Request(`http://localhost${url}`, init)).finally(dispose);
    const text = await response.text();
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: text === "" ? undefined : decodeJson(text),
    };
  };

  const unsupported = (parameter: string, family: "include" | "sort") => ({
    status: "400",
    code: "bad_request",
    title: "Bad Request",
    detail: expect.stringContaining(
      family === "include"
        ? `does not support the "include" parameter`
        : `does not support the "sort" parameter`,
    ),
    source: { parameter },
  });

  it.each([
    ["the single-resource fetch of a resource with no relationships", "/people/1?include=author"],
    ["a collection fetch that declares sort but not include", "/posts?include=author"],
    ["an empty value", "/people/1?include="],
  ])("rejects `include` on %s, naming it", async (_, url) => {
    const response = await serve(url);
    expect(response.status).toBe(400);
    expect(response.contentType).toContain("application/vnd.api+json");
    expect(response.body).toEqual({ errors: [unsupported("include", "include")] });
  });

  it.each([
    ["a single-resource fetch", "/posts/1?sort=title"],
    ["a collection fetch declared with no sortable field", "/people?sort=name"],
    ["an empty value", "/posts/1?sort="],
  ])("rejects `sort` on %s, naming it", async (_, url) => {
    const response = await serve(url);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ errors: [unsupported("sort", "sort")] });
  });

  it("rejects a bracketed member of an unsupported family, naming the whole parameter", async () => {
    const response = await serve("/people/1?include[x]=author");
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ errors: [unsupported("include[x]", "include")] });
  });

  it("rejects both families on an endpoint that declares no query schema at all", async () => {
    const response = await serve("/posts/1?include=author&sort=title", Middleware.layer, {
      method: "DELETE",
    });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      errors: [unsupported("include", "include"), unsupported("sort", "sort")],
    });
  });

  it("answers one error object per offending parameter, beside a reserved unknown one", async () => {
    const response = await serve("/people/1?sort=name&unknown=1&include=author&fooBar=1");
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      errors: [
        unsupported("sort", "sort"),
        rejection("unknown"),
        unsupported("include", "include"),
      ],
    });
  });

  it("leaves a family the endpoint declares to its query schema", async () => {
    queries.length = 0;
    expect((await serve("/posts/1?include=author")).status).toBe(200);
    expect((await serve("/posts?sort=-title")).status).toBe(200);
    expect(queries).toEqual([
      { include: ["author"] },
      { sort: [{ field: "title", direction: "desc" }] },
    ]);
    // the family's codec still answers a value it cannot process
    const path = await serve("/posts/1?include=nope");
    expect(path.status).toBe(400);
    expect(path.body.errors[0].source).toEqual({ parameter: "include" });
    expect(path.body.errors[0].meta).toEqual({ includablePaths: ["author"] });
    const field = await serve("/posts?sort=nope");
    expect(field.status).toBe(400);
    expect(field.body.errors[0].source).toEqual({ parameter: "sort" });
  });

  // Owner decision on #282: an empty vocabulary means unsupported. A family
  // declared with no legal value, as `[]` or derived empty from `true`, is
  // answered exactly like an undeclared one: the same 400 naming it, whatever
  // its value (an empty one too), before the endpoint decodes anything.
  it.each([
    ["`include: { paths: [] }`", "/tags/1?include=author", "include", "include"],
    ["`include: { paths: [] }`, several paths", "/tags/1?include=a,b", "include", "include"],
    ["`include: { paths: [] }`, an empty value", "/tags/1?include=", "include", "include"],
    [
      "`include: { paths: [] }`, a bracketed member",
      "/tags/1?include[x]=a",
      "include[x]",
      "include",
    ],
    ["`include: true` over no relationships", "/tags?include=author", "include", "include"],
    [
      "`include: true` over no relationships, an empty value",
      "/tags?include=",
      "include",
      "include",
    ],
    ["`sort: true` over no attributes", "/tags?sort=name", "sort", "sort"],
    ["`sort: true` over no attributes, an empty value", "/tags?sort=", "sort", "sort"],
  ] as const)(
    "rejects a family declared with an empty vocabulary as unsupported: %s",
    async (_, url, parameter, family) => {
      queries.length = 0;
      const response = await serve(url);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ errors: [unsupported(parameter, family)] });
      expect(queries).toEqual([]);
    },
  );

  it("answers each empty-vocabulary family with its own error object", async () => {
    const response = await serve("/tags?sort=name&include=author");
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      errors: [unsupported("sort", "sort"), unsupported("include", "include")],
    });
  });

  // The same precedence as #148's: `SchemaErrors` is the outer middleware,
  // so the 400 wins over a 406 or 415 the same request would otherwise get.
  describe("is decided before content negotiation", () => {
    // `schemaErrorsLayer` wired directly, beside the live negotiation, as
    // well as through `Middleware.layer`.
    const direct = Layer.mergeAll(
      Middleware.ContentNegotiationLive,
      Middleware.schemaErrorsLayer(),
    );
    const layers = [
      ["Middleware.layer", Middleware.layer],
      ["schemaErrorsLayer beside ContentNegotiationLive", direct],
    ] as const;
    const parameterised = "application/vnd.api+json; charset=utf-8";

    it.each(layers)("over an unacceptable Accept (406), under %s", async (_, middleware) => {
      const accept = { headers: { accept: parameterised } };
      const response = await serve("/posts/1?sort=title", middleware, accept);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ errors: [unsupported("sort", "sort")] });
      // without the unsupported parameter, the same request is the 406
      expect((await serve("/posts/1", middleware, accept)).status).toBe(406);
    });

    it.each(layers)("over an unsupported Content-Type (415), under %s", async (_, middleware) => {
      const contentType = { headers: { "content-type": parameterised } };
      const response = await serve("/people/1?include=author", middleware, contentType);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ errors: [unsupported("include", "include")] });
      // without the unsupported parameter, the same request is the 415
      expect((await serve("/people/1", middleware, contentType)).status).toBe(415);
    });

    // A family declared with an empty vocabulary is unsupported (#282), so
    // its 400 takes the same precedence; before #282 the request reached the
    // negotiation, which answered 406 / 415 first.
    it.each(layers)(
      "for a family declared with an empty vocabulary, over a 406 and a 415, under %s",
      async (_, middleware) => {
        const accept = { headers: { accept: parameterised } };
        const path = await serve("/tags/1?include=author", middleware, accept);
        expect(path.status).toBe(400);
        expect(path.body).toEqual({ errors: [unsupported("include", "include")] });
        expect((await serve("/tags/1", middleware, accept)).status).toBe(406);
        const contentType = { headers: { "content-type": parameterised } };
        const field = await serve("/tags?sort=", middleware, contentType);
        expect(field.status).toBe(400);
        expect(field.body).toEqual({ errors: [unsupported("sort", "sort")] });
        expect((await serve("/tags", middleware, contentType)).status).toBe(415);
      },
    );
  });

  it("applies under the host-negotiated layer too", async () => {
    const response = await serve("/people/1?include=author", Middleware.layerHostNegotiated);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ errors: [unsupported("include", "include")] });
  });
});

describe("which declared `include` / `sort` an endpoint supports (#282)", () => {
  // The support check reads the vocabulary the `include` / `sort` codecs
  // publish, only on the property the family's wire parameter decodes into
  // (the one of that name, or one the encoding renames to it). A family
  // counts as unsupported when every value its property could decode is
  // drawn from an empty vocabulary; one that publishes no vocabulary
  // (`Query.IncludeList`, a custom codec) or a non-empty one somewhere is
  // supported.
  const Person = Resource.make("people", { attributes: { name: Schema.NonEmptyString } });
  const Post = Resource.make("posts", {
    attributes: { title: Schema.NonEmptyString },
    relationships: { author: Relationship.one(() => Person) },
  });
  const Tag = Resource.make("tags", { attributes: {} });

  // A recursive codec with no vocabulary, so the walk must not loop on it.
  // Its recursive member comes first, so a walk that reads union members in
  // order reaches the recursion before the string that settles the answer.
  type Nested = { readonly next?: Nested } | string;
  const Nested: Schema.Codec<Nested> = Schema.Union([
    Schema.Struct({
      next: Schema.optionalKey(Schema.suspend((): Schema.Codec<Nested> => Nested)),
    }),
    Schema.String,
  ]);

  const endpoints = {
    "include-list": Schema.Struct({ include: Schema.optionalKey(Query.IncludeList) }),
    "custom-sort": Schema.Struct({ sort: Schema.optionalKey(Schema.String) }),
    "recursive-include": Schema.Struct({ include: Schema.optionalKey(Nested) }),
    "union-of-queries": Schema.Union([
      Query.schema(Tag, { include: { paths: [] } }),
      Query.schema(Post, { include: true }),
    ]),
    // The second member's wire has no `include`, so it reads no property.
    "union-with-query-without-include": Schema.Union([
      Query.schema(Tag, { include: { paths: [] } }),
      Query.schema(Post, { fields: true }),
    ]),
    "union-of-sorts": Schema.Struct({
      sort: Schema.optionalKey(Schema.Union([Query.Sort([]), Query.Sort(["title"])])),
    }),
    "union-with-open-include": Schema.Struct({
      include: Schema.optionalKey(Schema.Union([Query.Include(Tag), Query.IncludeList])),
    }),
    "open-include-beside-empty": Schema.Struct({
      include: Schema.optionalKey(Query.IncludeList),
      Other: Schema.optionalKey(Query.Include(Tag)),
    }),
    "empty-include-beside-other": Schema.Struct({
      include: Schema.optionalKey(Query.Include(Tag)),
      other: Schema.optionalKey(Query.Include(Post)),
    }),
    "empty-sort-beside-other": Schema.Struct({
      sort: Schema.optionalKey(Query.Sort([])),
      order: Schema.optionalKey(Query.Sort(["title"])),
    }),
    "suspended-query": Schema.suspend(() => Query.schema(Tag, { include: { paths: [] } })),
    "suspended-include": Schema.Struct({
      include: Schema.optionalKey(Schema.suspend(() => Query.Include(Tag))),
    }),
    // `Schema.optional` decodes `undefined` too, which carries no value.
    "optional-include": Schema.Struct({ include: Schema.optional(Query.Include(Tag)) }),
    // Only the family's own vocabulary counts.
    "sort-codec-as-include": Schema.Struct({ include: Schema.optionalKey(Query.Sort([])) }),
    // A record of empty vocabularies: every value it decodes draws on one.
    "include-record": Schema.Struct({
      include: Schema.optionalKey(Schema.Record(Schema.String, Query.Include(Tag))),
    }),
    // The wire's `include` decodes into a property of another name.
    "renamed-include": Schema.Struct({ paths: Schema.optionalKey(Query.Include(Tag)) }).pipe(
      Schema.encodeKeys({ paths: "include" }),
    ),
    "renamed-include-beside-other": Schema.Struct({
      paths: Schema.optionalKey(Query.Include(Tag)),
      other: Schema.optionalKey(Query.Include(Post)),
    }).pipe(Schema.encodeKeys({ paths: "include" })),
    "renamed-open-include": Schema.Struct({
      paths: Schema.optionalKey(Query.IncludeList),
      other: Schema.optionalKey(Query.Include(Tag)),
    }).pipe(Schema.encodeKeys({ paths: "include" })),
    // A query decoded whole by a custom codec has no property to read.
    "query-as-string": Schema.Struct({ include: Schema.optionalKey(Schema.String) }).pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transform<string, { readonly include?: string }>({
          decode: (query) => query.include ?? "",
          encode: (include) => ({ include }),
        }),
      ),
    ),
  } as const;
  type Name = keyof typeof endpoints;
  const endpoint = <const N extends Name>(name: N) =>
    HttpApiEndpoint.get(name, `/${name}`, {
      query: endpoints[name],
      success: Schema.Unknown,
    }).middleware(Middleware.SchemaErrors);
  const VocabulariesApi = HttpApi.make("vocabularies").add(
    HttpApiGroup.make("vocabularies").add(
      endpoint("include-list"),
      endpoint("custom-sort"),
      endpoint("recursive-include"),
      endpoint("union-of-queries"),
      endpoint("union-with-query-without-include"),
      endpoint("union-of-sorts"),
      endpoint("union-with-open-include"),
      endpoint("open-include-beside-empty"),
      endpoint("empty-include-beside-other"),
      endpoint("empty-sort-beside-other"),
      endpoint("suspended-query"),
      endpoint("suspended-include"),
      endpoint("optional-include"),
      endpoint("sort-codec-as-include"),
      endpoint("include-record"),
      endpoint("renamed-include"),
      endpoint("renamed-include-beside-other"),
      endpoint("renamed-open-include"),
      endpoint("query-as-string"),
    ),
  );
  // Each handler answers the decoded `query` it received.
  const echo = ({ query }: { readonly query: unknown }) => Effect.succeed(query);
  const VocabulariesLive = HttpApiBuilder.group(VocabulariesApi, "vocabularies", (handlers) =>
    handlers.handleAll({
      "include-list": echo,
      "custom-sort": echo,
      "recursive-include": echo,
      "union-of-queries": echo,
      "union-with-query-without-include": echo,
      "union-of-sorts": echo,
      "union-with-open-include": echo,
      "open-include-beside-empty": echo,
      "empty-include-beside-other": echo,
      "empty-sort-beside-other": echo,
      "suspended-query": echo,
      "suspended-include": echo,
      "optional-include": echo,
      "sort-codec-as-include": echo,
      "include-record": echo,
      "renamed-include": echo,
      "renamed-include-beside-other": echo,
      "renamed-open-include": echo,
      "query-as-string": echo,
    }),
  );

  const serve = async (url: string) => {
    const appLayer = HttpApiBuilder.layer(VocabulariesApi).pipe(
      Layer.provide(VocabulariesLive),
      Layer.provide(Middleware.SchemaErrorsLive),
      Layer.provide(platformLayer),
    );
    const { dispose, handler } = HttpRouter.toWebHandler(appLayer);
    const response = await handler(new Request(`http://localhost${url}`)).finally(dispose);
    return { status: response.status, body: decodeJson(await response.text()) };
  };

  const unsupported = (family: "include" | "sort") => ({
    errors: [
      {
        status: "400",
        code: "bad_request",
        title: "Bad Request",
        detail: expect.stringContaining(`does not support the "${family}" parameter`),
        source: { parameter: family },
      },
    ],
  });

  it.each([
    [
      "`Query.IncludeList`, which publishes no vocabulary",
      "/include-list?include=author",
      {
        include: ["author"],
      },
    ],
    ["`Query.IncludeList`, an empty value", "/include-list?include=", { include: [] }],
    ["a custom `sort` codec", "/custom-sort?sort=-anything", { sort: "-anything" }],
    [
      "a recursive `include` codec with no vocabulary",
      "/recursive-include?include=a",
      {
        include: "a",
      },
    ],
    [
      "a union of an empty and a non-empty query",
      "/union-of-queries?include=author",
      {
        include: ["author"],
      },
    ],
    [
      "a union of an empty and a non-empty `sort`",
      "/union-of-sorts?sort=title",
      {
        sort: [{ field: "title", direction: "asc" }],
      },
    ],
    [
      "a union of an empty `include` and `Query.IncludeList`",
      "/union-with-open-include?include=author",
      {
        include: ["author"],
      },
    ],
    [
      "`Query.IncludeList` beside an empty vocabulary under another name",
      "/open-include-beside-empty?include=author",
      {
        include: ["author"],
      },
    ],
    ["another family's empty vocabulary", "/sort-codec-as-include?include=", { include: [] }],
    // The wire's `include` feeds the renamed `paths`, an open list; the
    // empty vocabulary under `other` is another parameter's.
    [
      "a renamed `Query.IncludeList` beside an empty vocabulary under another name",
      "/renamed-open-include?include=author",
      { paths: ["author"] },
    ],
    ["a query its own codec decodes whole", "/query-as-string?include=author", "author"],
  ] as const)("supports %s", async (_, url, query) => {
    const response = await serve(url);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(query);
  });

  it.each([
    [
      "an empty `include` beside a non-empty one under another name",
      "/empty-include-beside-other?include=author",
      "include",
    ],
    [
      "an empty `sort` beside a non-empty one under another name",
      "/empty-sort-beside-other?sort=title",
      "sort",
    ],
    ["a suspended query", "/suspended-query?include=author", "include"],
    ["a suspended query, an empty value", "/suspended-query?include=", "include"],
    ["a suspended `include` codec", "/suspended-include?include=author", "include"],
    ["an optional `include`", "/optional-include?include=", "include"],
    ["a record of empty `include` codecs", "/include-record?include=", "include"],
    // Owner decision on #282: the wire name decides, not the decoded one.
    ["an `include` renamed on the wire", "/renamed-include?include=author", "include"],
    ["an `include` renamed on the wire, an empty value", "/renamed-include?include=", "include"],
    [
      "an `include` renamed on the wire beside a non-empty one under another name",
      "/renamed-include-beside-other?include=author",
      "include",
    ],
    [
      "a union with a query that declares no `include`",
      "/union-with-query-without-include?include=author",
      "include",
    ],
  ] as const)("rejects an empty vocabulary as unsupported: %s", async (_, url, family) => {
    const response = await serve(url);
    expect(response.status).toBe(400);
    expect(response.body).toEqual(unsupported(family));
  });
});

describe("which property a renamed wire parameter decodes into (#305, #306 follow-up)", () => {
  // `Schema.encodeKeys` renames a struct's properties on the wire inside an
  // opaque transformation, so the support check and the 400's
  // `source.parameter` both need to know which decoded property each wire
  // parameter feeds. The answer must come from the encoding, never from the
  // decoded names: a decoded `sort` may be sent as `include`, and a decoded
  // `include` as `inc`.
  const Person = Resource.make("people", { attributes: { name: Schema.NonEmptyString } });
  const Post = Resource.make("posts", {
    attributes: { title: Schema.NonEmptyString },
    relationships: { author: Relationship.one(() => Person) },
  });
  // No relationship and no attribute: every vocabulary derived from it is empty.
  const Tag = Resource.make("tags", { attributes: {} });

  const twoRenames = Schema.Struct({
    paths: Schema.optionalKey(Query.Include(Tag)),
    order: Schema.optionalKey(Query.Sort([])),
  }).pipe(Schema.encodeKeys({ paths: "include", order: "sort" }));

  const endpoints = {
    // The wire `include` decodes into the decoded `sort`, a non-empty
    // vocabulary; the wire `sort` into `x`, an `include` codec.
    "include-into-sort": Schema.Struct({
      sort: Schema.optionalKey(Query.Include(Post)),
      x: Schema.optionalKey(Query.Include(Tag)),
    }).pipe(Schema.encodeKeys({ sort: "include", x: "sort" })),
    "two-renames": twoRenames,
    // As above, with both properties required, as the review spelled it.
    "two-renames-required": Schema.Struct({
      paths: Query.Include(Tag),
      order: Query.Sort([]),
    }).pipe(Schema.encodeKeys({ paths: "include", order: "sort" })),
    // A decoded `include` sent as `inc`, and another property sent as `include`.
    "include-sent-elsewhere": Schema.Struct({
      include: Schema.optionalKey(Query.Include(Post)),
      paths: Schema.optionalKey(Query.Include(Tag)),
    }).pipe(Schema.encodeKeys({ include: "inc", paths: "include" })),
    swap: Schema.Struct({
      include: Schema.optionalKey(Query.Include(Post)),
      inc: Schema.optionalKey(Query.Include(Tag)),
    }).pipe(Schema.encodeKeys({ include: "inc", inc: "include" })),
    // The second member declares no `include`, so it reads no property.
    "union-of-renamed": Schema.Union([
      Schema.Struct({
        paths: Schema.optionalKey(Query.Include(Tag)),
        other: Schema.optionalKey(Query.Include(Post)),
      }).pipe(Schema.encodeKeys({ paths: "include", other: "inc" })),
      Schema.Struct({ q: Schema.optionalKey(Schema.String) }),
    ]),
    "suspended-renames": Schema.suspend(() => twoRenames),
    "renamed-record": Schema.Struct({
      paths: Schema.optionalKey(Schema.Record(Schema.String, Query.Include(Tag))),
      other: Schema.optionalKey(Query.Include(Post)),
    }).pipe(Schema.encodeKeys({ paths: "include", other: "inc" })),
    // A rename to an array-index name reorders the wire struct: the wire
    // `include` is still the decoded `paths`, never the decoded `include`,
    // which is sent as `0`.
    "index-rename": Schema.Struct({
      include: Schema.optionalKey(Query.Include(Post)),
      paths: Query.Include(Tag),
      order: Query.Sort(["title"]),
    }).pipe(Schema.encodeKeys({ include: "0", paths: "include" })),
    // Two renamed fieldsets, one of them empty (#313's type-aware path).
    "renamed-fieldsets": Schema.Struct({
      tagFields: Schema.optionalKey(Query.Fieldset(Tag)),
      personFields: Schema.optionalKey(Query.Fieldset(Person)),
    }).pipe(Schema.encodeKeys({ tagFields: "fields[tags]", personFields: "fields[people]" })),
    // #305's reproduction, with a non-empty vocabulary.
    "renamed-include": Schema.Struct({ paths: Schema.optionalKey(Query.Include(Post)) }).pipe(
      Schema.encodeKeys({ paths: "include" }),
    ),
    "required-renamed-include": Schema.Struct({ paths: Query.Include(Post) }).pipe(
      Schema.encodeKeys({ paths: "include" }),
    ),
    "two-nonempty-renames": Schema.Struct({
      paths: Schema.optionalKey(Query.Include(Post)),
      order: Schema.optionalKey(Query.Sort(["title"])),
    }).pipe(Schema.encodeKeys({ paths: "include", order: "sort" })),
    // `NonEmptyString` keeps its check on the encoded side, so an empty value
    // fails on the wire, under the wire name; `FiniteFromString` fails after
    // the rename, under the decoded one.
    "swapped-scalars": Schema.Struct({
      a: Schema.NonEmptyString,
      b: Schema.FiniteFromString,
    }).pipe(Schema.encodeKeys({ a: "b", b: "a" })),
    "suspended-renamed-include": Schema.suspend(() =>
      Schema.Struct({ paths: Schema.optionalKey(Query.Include(Post)) }).pipe(
        Schema.encodeKeys({ paths: "include" }),
      ),
    ),
    "renamed-fieldset": Schema.Struct({
      personFields: Schema.optionalKey(Query.Fieldset(Person)),
    }).pipe(Schema.encodeKeys({ personFields: "fields[people]" })),
    "bracketed-page": Query.bracketPageKeys(
      Schema.Struct({ ...Query.Page.offset({ maxLimit: 100 }) }),
    ),
    // `Query.flatList` brackets `page[…]` and the listed `filter[…]` keys in
    // one rename.
    "flat-list": Query.flatList(
      Schema.Struct({
        ...Query.Page.offset({ maxLimit: 100 }),
        status: Schema.optionalKey(Schema.Literals(["open", "closed"])),
      }),
      { filters: ["status"] },
    ),
    // A passthrough between two structs that list the same names in another
    // order, every wire property carrying the AST a decoded one encodes to:
    // nothing is renamed, so each wire name is its own decoded name.
    "passthrough-reordered": Schema.Struct({
      sort: Schema.toEncoded(Query.Include(Post)),
      include: Schema.toEncoded(Query.Include(Post)),
    }).pipe(
      Schema.decodeTo(
        Schema.Struct({ include: Query.Include(Post), sort: Query.Sort(["title"]) }),
        SchemaTransformation.passthrough(),
      ),
    ),
    "passthrough-reordered-empty": Schema.Struct({
      sort: Schema.toEncoded(Query.Include(Tag)),
      include: Schema.toEncoded(Query.Include(Tag)),
    }).pipe(
      Schema.decodeTo(
        Schema.Struct({ include: Query.Include(Tag), sort: Query.Sort(["title"]) }),
        SchemaTransformation.passthrough(),
      ),
    ),
    // A check on the renamed struct that reports a property by its decoded
    // name: the issue tree is the struct's composite, the check, then a
    // pointer, or a composite of pointers when the check reports several.
    "checked-rename": Schema.Struct({ count: Schema.optionalKey(Schema.FiniteFromString) })
      .pipe(Schema.encodeKeys({ count: "page[size]" }))
      .check(
        Schema.makeFilter(
          ({ count }) =>
            Match.value(count).pipe(
              Match.when(undefined, () => undefined),
              Match.when(7, () => false),
              Match.when(
                (n) => n > 100,
                () => [
                  { path: ["count"], issue: "too big" },
                  { path: ["count"], issue: "far too big" },
                ],
              ),
              Match.when(
                (n) => n > 10,
                () => ({ path: ["count"], issue: "too big" }),
              ),
              Match.orElse(() => undefined),
            ),
          {
            identifier: "pageSizeCap",
            title: "page size cap",
            description: "rejects a page size above 10, and the size 7 whole",
          },
        ),
        // A check with a message of its own is reported whole, under it.
        Schema.makeFilter(
          ({ count }) => (count === 9 ? { path: ["count"], issue: "nine" } : undefined),
          {
            identifier: "notNine",
            title: "not nine",
            description: "rejects a page size of 9",
            message: "not nine",
          },
        ),
      ),
    // `include` and `inc` each fill `paths` when sent alone, so a value
    // rejected there may have come from either: neither is its wire name.
    "include-or-inc": Schema.Struct({
      include: Schema.optionalKey(Schema.toEncoded(Query.Include(Post))),
      inc: Schema.optionalKey(Schema.toEncoded(Query.Include(Post))),
    }).pipe(
      Schema.decodeTo(
        Schema.Struct({ paths: Schema.optionalKey(Query.Include(Post)) }),
        SchemaTransformation.transform({
          decode: ({ include, inc }) => {
            const paths = include ?? inc;
            return paths === undefined ? {} : { paths };
          },
          encode: ({ paths }) => (paths === undefined ? {} : { include: paths }),
        }),
      ),
    ),
    // Both members decode a `paths`; only the first renames it on the wire.
    "union-of-branches": Schema.Union([
      Schema.Struct({ paths: Query.Include(Post) }).pipe(Schema.encodeKeys({ paths: "include" })),
      Schema.Struct({ paths: Query.Include(Post) }),
    ]),
  } as const;
  type Name = keyof typeof endpoints;
  const endpoint = <const N extends Name>(name: N) =>
    HttpApiEndpoint.get(name, `/${name}`, {
      query: endpoints[name],
      success: Schema.Unknown,
    }).middleware(Middleware.SchemaErrors);
  const RenamedApi = HttpApi.make("renamed").add(
    HttpApiGroup.make("renamed").add(
      endpoint("include-into-sort"),
      endpoint("two-renames"),
      endpoint("two-renames-required"),
      endpoint("include-sent-elsewhere"),
      endpoint("swap"),
      endpoint("union-of-renamed"),
      endpoint("suspended-renames"),
      endpoint("renamed-record"),
      endpoint("index-rename"),
      endpoint("renamed-fieldsets"),
      endpoint("renamed-include"),
      endpoint("required-renamed-include"),
      endpoint("two-nonempty-renames"),
      endpoint("swapped-scalars"),
      endpoint("suspended-renamed-include"),
      endpoint("renamed-fieldset"),
      endpoint("bracketed-page"),
      endpoint("flat-list"),
      endpoint("union-of-branches"),
      endpoint("passthrough-reordered"),
      endpoint("passthrough-reordered-empty"),
      endpoint("checked-rename"),
      endpoint("include-or-inc"),
    ),
  );
  const echo = ({ query }: { readonly query: unknown }) => Effect.succeed(query);
  const RenamedLive = HttpApiBuilder.group(RenamedApi, "renamed", (handlers) =>
    handlers.handleAll({
      "include-into-sort": echo,
      "two-renames": echo,
      "two-renames-required": echo,
      "include-sent-elsewhere": echo,
      swap: echo,
      "union-of-renamed": echo,
      "suspended-renames": echo,
      "renamed-record": echo,
      "index-rename": echo,
      "renamed-fieldsets": echo,
      "renamed-include": echo,
      "required-renamed-include": echo,
      "two-nonempty-renames": echo,
      "swapped-scalars": echo,
      "suspended-renamed-include": echo,
      "renamed-fieldset": echo,
      "bracketed-page": echo,
      "flat-list": echo,
      "union-of-branches": echo,
      "passthrough-reordered": echo,
      "passthrough-reordered-empty": echo,
      "checked-rename": echo,
      "include-or-inc": echo,
    }),
  );

  const serve = async (url: string) => {
    const appLayer = HttpApiBuilder.layer(RenamedApi).pipe(
      Layer.provide(RenamedLive),
      Layer.provide(Middleware.SchemaErrorsLive),
      Layer.provide(platformLayer),
    );
    const { dispose, handler } = HttpRouter.toWebHandler(appLayer);
    const response = await handler(new Request(`http://localhost${url}`)).finally(dispose);
    return { status: response.status, body: decodeJson(await response.text()) };
  };

  const unsupported = (parameter: string) => ({
    errors: [
      {
        status: "400",
        code: "bad_request",
        title: "Bad Request",
        detail: expect.stringContaining(`does not support the "${parameter}" parameter`),
        source: { parameter },
      },
    ],
  });

  describe("the support check reads the property the wire parameter decodes into", () => {
    it.each([
      // The review's should-fix: #306 dropped every property whose decoded
      // name is on the wire, so the decoded `sort` was never read.
      [
        "a wire `include` decoded into `sort`",
        "/include-into-sort?include=author",
        { sort: ["author"] },
      ],
      [
        "a wire `include` decoded into `sort`, an empty value",
        "/include-into-sort?include=",
        { sort: [] },
      ],
      ["the non-empty side of a swap", "/swap?inc=author", { include: ["author"] }],
      [
        "a decoded `include` sent under another name",
        "/include-sent-elsewhere?inc=author",
        { include: ["author"] },
      ],
      [
        "the non-empty one of two renamed fieldsets",
        "/renamed-fieldsets?fields[people]=name",
        { personFields: ["name"] },
      ],
    ] as const)("supports %s", async (_, url, query) => {
      const response = await serve(url);
      expect(response.status).toBe(200);
      expect(response.body).toEqual(query);
    });

    it.each([
      ["`include`, one of two renames", "/two-renames?include=", "include"],
      ["`sort`, one of two renames", "/two-renames?sort=", "sort"],
      ["`include`, one of two required renames", "/two-renames-required?include=", "include"],
      ["`sort`, one of two required renames", "/two-renames-required?sort=title", "sort"],
      // #306's known limit: the decoded `include` is not the wire `include`.
      [
        "an `include` beside a decoded `include` sent elsewhere",
        "/include-sent-elsewhere?include=author",
        "include",
      ],
      ["the empty side of a swap", "/swap?include=author", "include"],
      ["a renamed `include` in a union", "/union-of-renamed?include=author", "include"],
      ["a renamed `sort` in a suspended query", "/suspended-renames?sort=", "sort"],
      ["a renamed record of empty `include` codecs", "/renamed-record?include=", "include"],
      [
        "an `include` beside a decoded `include` renamed to an array index",
        "/index-rename?include=&order=title",
        "include",
      ],
      [
        "the empty one of two renamed fieldsets",
        "/renamed-fieldsets?fields[tags]=",
        "fields[tags]",
      ],
      // Read by place, the wire `include` was the decoded `sort`.
      [
        "an `include` a passthrough lists in another order",
        "/passthrough-reordered-empty?include=&sort=title",
        "include",
      ],
    ] as const)("rejects an empty vocabulary as unsupported: %s", async (_, url, parameter) => {
      const response = await serve(url);
      expect(response.status).toBe(400);
      expect(response.body).toEqual(unsupported(parameter));
    });
  });

  describe("`source.parameter` names the wire parameter (#305)", () => {
    const rejected = (parameter: string, detail: string) => ({
      status: "400",
      code: "bad_request",
      title: "Bad Request",
      detail,
      source: { parameter },
    });
    // A rejection the renderer cannot place on a parameter.
    const whole = {
      status: "400",
      code: "bad_request",
      title: "Bad Request",
      detail: "Request query failed validation",
      meta: { detail: "Request query failed validation" },
    };
    // A rejected `include` path, with the vocabulary it renders as `meta`.
    const includable = (parameter: string) => ({
      ...rejected(parameter, 'Expected "author"'),
      meta: { includablePaths: ["author"] },
    });

    it.each([
      [
        "an `include` renamed from `paths`",
        "/renamed-include?include=nope",
        [includable("include")],
      ],
      [
        "a renamed `include` in a suspended query",
        "/suspended-renamed-include?include=nope",
        [includable("include")],
      ],
      [
        "a required renamed `include`, missing",
        "/required-renamed-include",
        [rejected("include", "Missing key")],
      ],
      [
        "`include`, one of two renames",
        "/two-nonempty-renames?include=nope",
        [includable("include")],
      ],
      [
        "`sort`, one of two renames",
        "/two-nonempty-renames?sort=nope",
        [{ ...rejected("sort", 'Expected "title"'), meta: { sortableFields: ["title"] } }],
      ],
      // The decoded `include` is sent as `inc`: the name the client used wins.
      ["a swap", "/swap?inc=nope", [includable("inc")]],
      // Decoded `b` is the wire `a`.
      [
        "a value rejected after the rename",
        "/swapped-scalars?a=x&b=y",
        [rejected("a", "Expected a finite number")],
      ],
      // Rejected on the wire, before the rename: already the wire name.
      [
        "a value rejected before the rename",
        "/swapped-scalars?a=1&b=",
        [rejected("b", "Expected a value with a length of at least 1")],
      ],
      [
        "a renamed fieldset",
        "/renamed-fieldset?fields[people]=nope",
        [rejected("fields[people]", 'Expected "name"')],
      ],
      // Each member's failure is named by that member's own wire name.
      [
        "a union whose members send the same property under different names",
        "/union-of-branches?include=nope&paths=nope",
        [includable("include"), includable("paths")],
      ],
      [
        "a page member bracketed by `Query.bracketPageKeys`",
        "/bracketed-page?page[limit]=abc",
        [rejected("page[limit]", "Expected a finite number")],
      ],
      [
        "a page member bracketed by `Query.flatList`",
        "/flat-list?page[limit]=abc&filter[status]=open",
        [rejected("page[limit]", "Expected a finite number")],
      ],
      // Read by place, the wire `include` was named `sort`, and the other way
      // round.
      [
        "an `include` a passthrough lists in another order",
        "/passthrough-reordered?include=nope&sort=title",
        [includable("include")],
      ],
      [
        "a `sort` a passthrough lists in another order",
        "/passthrough-reordered?include=author&sort=nope",
        [{ ...rejected("sort", 'Expected "title"'), meta: { sortableFields: ["title"] } }],
      ],
      // A check on the struct that points at a renamed property.
      [
        "a renamed property a struct check rejects",
        "/checked-rename?page[size]=50",
        [rejected("page[size]", "too big")],
      ],
      [
        "a renamed property a struct check rejects twice",
        "/checked-rename?page[size]=500",
        [rejected("page[size]", "too big"), rejected("page[size]", "far too big")],
      ],
      // Read off one probe of both names, `paths` was paired with `include`,
      // a parameter this request never sent. Neither name is shown to be
      // `paths`'s, so it keeps its decoded name, as on trunk.
      [
        "a property either of two wire parameters fills",
        "/include-or-inc?inc=nope",
        [includable("paths")],
      ],
      // Neither names a property, so each is the generic rejection, as
      // before: the formatter reports a check with a message of its own
      // whole, at the struct, never at the property it points to.
      ["a struct check that rejects the whole query", "/checked-rename?page[size]=7", [whole]],
      ["a struct check with a message of its own", "/checked-rename?page[size]=9", [whole]],
    ] as const)("%s", async (_, url, errors) => {
      const response = await serve(url);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ errors });
    });

    // A host that decodes the query itself renders the same document.
    it("on a direct decode, through `schemaErrorDocument`", () => {
      const result = Schema.decodeUnknownResult(endpoints.swap)({ inc: "nope" });
      expect(
        Result.isFailure(result) && Middleware.schemaErrorDocument("Query", result.failure),
      ).toEqual({ errors: [includable("inc")] });
    });

    // A struct check's pointer below a renamed property: only its first key
    // is the property, renamed; the rest is inside the property's value.
    it("a struct check that points below a renamed property", () => {
      const fieldsets = Schema.Struct({
        fieldsets: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      })
        .pipe(Schema.encodeKeys({ fieldsets: "fields" }))
        .check(
          Schema.makeFilter(
            ({ fieldsets: sets }) =>
              sets?.["people"] === "secret"
                ? { path: ["fieldsets", "people"], issue: "not public" }
                : undefined,
            {
              identifier: "publicFieldsets",
              title: "public fieldsets",
              description: "rejects the secret fieldset of people",
            },
          ),
        );
      const result = Schema.decodeUnknownResult(fieldsets)({ fields: { people: "secret" } });
      expect(
        Result.isFailure(result) && Middleware.schemaErrorDocument("Query", result.failure),
      ).toEqual({ errors: [rejected("fields[people]", "not public")] });
    });

    // The renamed struct is the source of another transformation: its
    // decoded side's issue sits under the outer schema's `Encoding`.
    it("a renamed struct's issue under another schema's encoding", () => {
      const renamed = Schema.Struct({ paths: Query.Include(Post) }).pipe(
        Schema.encodeKeys({ paths: "include" }),
      );
      const outer = renamed.pipe(
        Schema.decodeTo(Schema.toType(renamed), SchemaTransformation.passthrough()),
      );
      const result = Schema.decodeUnknownResult(outer)({ include: "nope" });
      expect(
        Result.isFailure(result) && Middleware.schemaErrorDocument("Query", result.failure),
      ).toEqual({ errors: [includable("include")] });
    });

    // HttpApi builds an endpoint's codecs once, so the renamed struct's AST
    // is the same on every request it rejects: the query's own decode runs
    // on one set of probes, not on a set per rejected request.
    it("probes a renamed query once, however many requests it rejects", async () => {
      const decoded: Array<{ readonly include?: string }> = [];
      const Wire = Schema.Struct({ include: Schema.optionalKey(Schema.String) });
      const Paths = Schema.Struct({ paths: Schema.optionalKey(Query.Include(Post)) });
      const counted = Wire.pipe(
        Schema.decodeTo(
          Paths,
          SchemaTransformation.transform<typeof Paths.Encoded, typeof Wire.Type>({
            decode: (wire) => {
              decoded.push(wire);
              return wire.include === undefined ? {} : { paths: wire.include };
            },
            // `Query.Include` encodes a list as one comma-separated value.
            encode: ({ paths }) => (paths === undefined ? {} : { include: String(paths) }),
          }),
        ),
      );
      const CountedApi = HttpApi.make("counted").add(
        HttpApiGroup.make("counted").add(
          HttpApiEndpoint.get("counted", "/counted", {
            query: counted,
            success: Schema.Unknown,
          }).middleware(Middleware.SchemaErrors),
        ),
      );
      const CountedLive = HttpApiBuilder.group(CountedApi, "counted", (handlers) =>
        handlers.handle("counted", echo),
      );
      const { dispose, handler } = HttpRouter.toWebHandler(
        HttpApiBuilder.layer(CountedApi).pipe(
          Layer.provide(CountedLive),
          Layer.provide(Middleware.SchemaErrorsLive),
          Layer.provide(platformLayer),
        ),
      );
      const reject = async () => {
        const response = await handler(new Request("http://localhost/counted?include=nope"));
        return { status: response.status, body: decodeJson(await response.text()) };
      };
      // Every decode but of the requests' own `nope` is a probe.
      const probes = () => decoded.filter(({ include }) => include !== "nope").length;
      const rejectFive = async () => {
        expect(await reject()).toEqual({ status: 400, body: { errors: [includable("include")] } });
        // One set: the full probe, and the one wire name's own.
        expect(probes()).toBe(2);
        const more = await Promise.all([reject(), reject(), reject(), reject()]);
        expect(more.map(({ status }) => status)).toEqual([400, 400, 400, 400]);
        expect(probes()).toBe(2);
      };
      await rejectFive().finally(dispose);
    });
  });
});

describe("`fields`, `page` and `filter` an endpoint does not support (#261)", () => {
  // Owner decision on #261: an undeclared `fields[…]`, `page[…]` or
  // `filter[…]` is a 400, exactly as an unsupported `include` / `sort` is,
  // and so is one declared with an empty vocabulary. JSON:API 1.1
  // §Implementation-Specific Query Parameters: "If a server encounters a
  // query parameter that does not follow the naming conventions above, or the
  // server does not know how to process it as a query parameter from this
  // specification, it MUST return `400 Bad Request`." For `fields`, ignoring
  // it would also break §Sparse Fieldsets: "If a client requests a restricted
  // set of [fields] for a given resource type, an endpoint MUST NOT include
  // additional [fields] in resource objects of that type in its response."
  // `fields` is per resource type: each `fields[TYPE]` is its own parameter.
  const Person = Resource.make("people", { attributes: { name: Schema.NonEmptyString } });
  // No attributes, so its sparse fieldset has no field to select.
  const Tag = Resource.make("tags", { attributes: {} });
  const Post = Resource.make("posts", {
    attributes: { title: Resource.attribute(Schema.NonEmptyString, { filter: true }) },
    relationships: { author: Relationship.one(() => Person), tags: Relationship.many(() => Tag) },
  });

  const FamiliesApi = HttpApi.make("fieldsPageFilter")
    .add(
      Group.make(
        Post,
        Endpoint.get(Post),
        // `fields[posts]`, `fields[people]` and the empty `fields[tags]`.
        Endpoint.list(Post, { fields: true, page: Query.Page.Offset, filter: true }),
        Endpoint.delete(Post),
      ),
    )
    .add(
      Group.make(
        Person,
        Endpoint.get(Person, { fields: true }),
        // No filterable attribute, and a page strategy with no member.
        Endpoint.list(Person, { filter: true, page: {} }),
      ),
    )
    // `fields[tags]` only, which is empty, and a filter map with no key.
    .add(Group.make(Tag, Endpoint.list(Tag, { fields: true, filter: {} })));

  // The decoded `query` each handler call received.
  const queries: Array<unknown> = [];
  const FamiliesLive = Layer.mergeAll(
    HttpApiBuilder.group(FamiliesApi, "posts", (handlers) =>
      handlers
        .handle("get", ({ params, query }) => {
          queries.push(query);
          return Effect.succeed({
            data: Post.make({ id: params.id, attributes: { title: "Hello" } }),
          });
        })
        .handle("list", ({ query }) => {
          queries.push(query);
          return Effect.succeed({ data: [] });
        })
        .handle("delete", () => {
          // `delete` declares no query: record that it ran.
          queries.push("delete");
          return Effect.void;
        }),
    ),
    HttpApiBuilder.group(FamiliesApi, "people", (handlers) =>
      handlers
        .handle("get", ({ params, query }) => {
          queries.push(query);
          return Effect.succeed({
            data: Person.make({ id: params.id, attributes: { name: "Ada" } }),
          });
        })
        .handle("list", ({ query }) => {
          queries.push(query);
          return Effect.succeed({ data: [] });
        }),
    ),
    HttpApiBuilder.group(FamiliesApi, "tags", (handlers) =>
      handlers.handle("list", ({ query }) => {
        queries.push(query);
        return Effect.succeed({ data: [] });
      }),
    ),
  );

  const serve = async (
    url: string,
    middlewareLayer: Layer.Layer<ContentNegotiation | SchemaErrors> = Middleware.layer,
    init: RequestInit = {},
  ) => {
    const appLayer = HttpApiBuilder.layer(FamiliesApi).pipe(
      Layer.provide(FamiliesLive),
      Layer.provide(middlewareLayer),
      Layer.provide(platformLayer),
    );
    const { dispose, handler } = HttpRouter.toWebHandler(appLayer);
    const response = await handler(new Request(`http://localhost${url}`, init)).finally(dispose);
    const text = await response.text();
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: text === "" ? undefined : decodeJson(text),
    };
  };

  // A `fields[TYPE]` rejection names its own parameter; `page` and `filter`
  // are rejected as a family.
  const unsupported = (parameter: string) => ({
    status: "400",
    code: "bad_request",
    title: "Bad Request",
    detail: expect.stringContaining(
      parameter.startsWith("fields")
        ? `does not support the "${parameter}" parameter`
        : `does not support the "${parameter.startsWith("page") ? "page" : "filter"}" parameter family`,
    ),
    source: { parameter },
  });

  // Every way the middleware is provided: the default layer, `layerWith`
  // (with an allow-list, which admits none of these), and `schemaErrorsLayer`
  // wired directly beside the live negotiation.
  const layers = [
    ["Middleware.layer", Middleware.layer],
    ["Middleware.layerWith", Middleware.layerWith({ allowedQueryParameters: ["lang"] })],
    [
      "schemaErrorsLayer",
      Layer.mergeAll(
        Middleware.ContentNegotiationLive,
        Middleware.schemaErrorsLayer({ allowedQueryParameters: ["lang"] }),
      ),
    ],
  ] as const;

  const rejected: ReadonlyArray<
    readonly [what: string, url: string, parameters: ReadonlyArray<string>]
  > = [
    // Undeclared: the endpoint's `query` has no member of the family.
    [
      "`fields[TYPE]` on a fetch with no fieldset",
      "/posts/1?fields[posts]=title",
      ["fields[posts]"],
    ],
    [
      "an empty `fields[TYPE]` on a fetch with no fieldset",
      "/posts/1?fields[posts]=",
      ["fields[posts]"],
    ],
    ["a bare `fields`", "/posts/1?fields=title", ["fields"]],
    ["`page[…]` on a fetch that does not paginate", "/posts/1?page[limit]=1", ["page[limit]"]],
    ["an empty `page[…]`", "/posts/1?page[offset]=", ["page[offset]"]],
    ["a bare `page`", "/posts/1?page=2", ["page"]],
    [
      "`filter[…]` on a fetch that does not filter",
      "/posts/1?filter[title]=Hello",
      ["filter[title]"],
    ],
    ["a nested `filter[…]`", "/posts/1?filter[title][eq]=Hello", ["filter[title][eq]"]],
    ["a bare `filter`", "/posts/1?filter=x", ["filter"]],
    ["an empty bare `filter`", "/posts/1?filter=", ["filter"]],
    [
      "all three families at once",
      "/posts/1?fields[posts]=title&page[limit]=1&filter[title]=x",
      ["fields[posts]", "page[limit]", "filter[title]"],
    ],
    // Declared with an empty vocabulary: unsupported (owner decision, #261).
    ["`filter: true` over no filterable attribute", "/people?filter[name]=Ada", ["filter[name]"]],
    ["`filter: true` over no filterable attribute, a bare value", "/people?filter=", ["filter"]],
    ["`filter: {}`", "/tags?filter[name]=x", ["filter[name]"]],
    ["`page: {}`", "/people?page[limit]=1", ["page[limit]"]],
    ["`fields[TYPE]` for a type with no attribute", "/tags?fields[tags]=name", ["fields[tags]"]],
    [
      "`fields[TYPE]` for a type with no attribute, an empty value",
      "/tags?fields[tags]=",
      ["fields[tags]"],
    ],
    // Per type: only the offending `fields[TYPE]` is rejected.
    [
      "`fields[TYPE]` for a type the endpoint has no fieldset for",
      "/posts?fields[comments]=body",
      ["fields[comments]"],
    ],
    [
      "an empty-vocabulary `fields[TYPE]` beside a supported one",
      "/posts?fields[posts]=title&fields[tags]=",
      ["fields[tags]"],
    ],
    ["a bare `fields` beside declared fieldsets", "/posts?fields=title", ["fields"]],
    ["a deeper `fields[TYPE][…]`", "/posts?fields[posts][x]=title", ["fields[posts][x]"]],
    [
      "`fields[TYPE]` for another type than the fetch declares",
      "/people/1?fields[posts]=title",
      ["fields[posts]"],
    ],
  ];

  describe.each(layers)("under %s", (_, middleware) => {
    it.each(rejected)("rejects %s, naming it", async (_, url, parameters) => {
      queries.length = 0;
      const response = await serve(url, middleware);
      expect(response.status).toBe(400);
      expect(response.contentType).toContain("application/vnd.api+json");
      expect(response.body).toEqual({ errors: parameters.map(unsupported) });
      expect(queries).toEqual([]);
    });
  });

  it("rejects all three on an endpoint that declares no query schema at all", async () => {
    queries.length = 0;
    const response = await serve(
      "/posts/1?fields[posts]=&page[limit]=1&filter=x",
      Middleware.layer,
      {
        method: "DELETE",
      },
    );
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      errors: ["fields[posts]", "page[limit]", "filter"].map(unsupported),
    });
    expect(queries).toEqual([]);
  });

  it("answers one error object per offending parameter, in request order, beside the other rejections", async () => {
    const response = await serve(
      "/posts/1?sort=x&fields[posts]=a&unknown=1&page[limit]=1&fooBar=1",
    );
    expect(response.status).toBe(400);
    expect(response.body.errors.map((error: { source: unknown }) => error.source)).toEqual([
      { parameter: "sort" },
      { parameter: "fields[posts]" },
      { parameter: "unknown" },
      { parameter: "page[limit]" },
    ]);
  });

  it("leaves a family the endpoint supports to its query schema", async () => {
    queries.length = 0;
    expect((await serve("/posts?fields[posts]=title&fields[people]=name")).status).toBe(200);
    expect((await serve("/posts?page[limit]=1&filter[title]=Hello")).status).toBe(200);
    expect((await serve("/people/1?fields[people]=")).status).toBe(200);
    expect(queries).toEqual([
      { fields: { posts: ["title"], people: ["name"] } },
      {
        page: { limit: 1 },
        filter: { _tag: "Compare", op: "eq", field: "title", value: "Hello" },
      },
      { fields: { people: [] } },
    ]);
    // the family's codec still answers a value it cannot process
    const field = await serve("/posts?fields[posts]=nope");
    expect(field.status).toBe(400);
    expect(field.body.errors[0].source).toEqual({ parameter: "fields[posts]" });
    expect(field.body.errors[0].meta).toBeUndefined();
    const limit = await serve("/posts?page[limit]=nope");
    expect(limit.status).toBe(400);
    expect(limit.body.errors[0].source).toEqual({ parameter: "page[limit]" });
  });

  // The decision covers a family the endpoint does not support. An
  // undeclared member of a `page` family the endpoint declares is still left
  // to the query schema, which drops it, as an `include[x]` beside a
  // declared `include` is.
  it("still leaves an undeclared member of a declared `page` family to the query schema", async () => {
    queries.length = 0;
    expect((await serve("/posts?page[size]=1")).status).toBe(200);
    expect(queries).toEqual([{}]);
  });

  // The check reads the decoded parameter names, so a percent-encoded
  // bracket is the same parameter as a literal one.
  it("rejects a percent-encoded `page%5Bsize%5D` under its decoded name", async () => {
    const response = await serve("/posts/1?page%5Bsize%5D=10");
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ errors: [unsupported("page[size]")] });
  });

  // Family names are case-sensitive: `Page[size]` is an implementation-
  // specific parameter, which the endpoint ignores.
  it("ignores a mixed-case `Page[size]`, an implementation-specific name", async () => {
    queries.length = 0;
    expect((await serve("/posts/1?Page[size]=10&FILTER[title]=x")).status).toBe(200);
    expect(queries).toEqual([{}]);
  });

  // The same precedence as `include` / `sort`: `SchemaErrors` is the outer
  // middleware, so the 400 wins over a 406 or 415.
  describe("is decided before content negotiation", () => {
    const parameterised = "application/vnd.api+json; charset=utf-8";
    const negotiating = [layers[0], layers[2]] as const;

    it.each(negotiating)("over an unacceptable Accept (406), under %s", async (_, middleware) => {
      const accept = { headers: { accept: parameterised } };
      const page = await serve("/posts/1?page[limit]=1", middleware, accept);
      expect(page.status).toBe(400);
      expect(page.body).toEqual({ errors: [unsupported("page[limit]")] });
      const filter = await serve("/people?filter[name]=Ada", middleware, accept);
      expect(filter.status).toBe(400);
      expect(filter.body).toEqual({ errors: [unsupported("filter[name]")] });
      // without the unsupported parameter, the same request is the 406
      expect((await serve("/posts/1", middleware, accept)).status).toBe(406);
    });

    it.each(negotiating)(
      "over an unsupported Content-Type (415), under %s",
      async (_, middleware) => {
        const contentType = { headers: { "content-type": parameterised } };
        const response = await serve("/tags?fields[tags]=", middleware, contentType);
        expect(response.status).toBe(400);
        expect(response.body).toEqual({ errors: [unsupported("fields[tags]")] });
        const undeclared = await serve("/posts/1?fields[posts]=title", middleware, contentType);
        expect(undeclared.status).toBe(400);
        expect(undeclared.body).toEqual({ errors: [unsupported("fields[posts]")] });
        // without the unsupported parameter, the same request is the 415
        expect((await serve("/tags", middleware, contentType)).status).toBe(415);
      },
    );
  });

  it("applies under the host-negotiated layer too", async () => {
    const response = await serve("/posts/1?fields[posts]=title", Middleware.layerHostNegotiated);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ errors: [unsupported("fields[posts]")] });
  });

  // Hand-built query schemas: a union, a suspended schema, a fieldset under
  // its own wire name or renamed to it, an open `fields[` record, and a
  // record that admits any name, before which the whole check stands aside.
  describe("on a hand-built query schema", () => {
    // Another resource of type `tags`, whose fieldset has a field.
    const NamedTag = Resource.make("tags", { attributes: { name: Schema.String } });
    const endpoints = {
      "union-of-fieldsets": Schema.Union([
        Query.schema(Tag, { fields: true }),
        Query.schema(NamedTag, { fields: true }),
      ]),
      // The `page` member first: a union decodes through its first member
      // that accepts the input, and the fieldset member drops `page[…]`.
      "union-with-empty-fieldset": Schema.Union([
        Query.schema(Person, { page: Query.Page.Offset }),
        Query.schema(Tag, { fields: true }),
      ]),
      suspended: Schema.suspend(() =>
        Query.schema(Post, { fields: true, page: Query.Page.Offset }),
      ),
      "flat-fieldsets": Schema.Struct({
        "fields[tags]": Schema.optionalKey(Query.Fieldset(Tag)),
        "fields[people]": Schema.optionalKey(Query.Fieldset(Person)),
      }),
      "renamed-empty-fieldset": Schema.Struct({
        tagFields: Schema.optionalKey(Query.Fieldset(Tag)),
      }).pipe(Schema.encodeKeys({ tagFields: "fields[tags]" })),
      "renamed-fieldset": Schema.Struct({
        personFields: Schema.optionalKey(Query.Fieldset(Person)),
      }).pipe(Schema.encodeKeys({ personFields: "fields[people]" })),
      "open-fieldsets": Schema.Record(
        Schema.TemplateLiteral(["fields[", Schema.String]),
        Schema.String,
      ),
      record: Schema.Record(Schema.String, Schema.String),
    } as const;
    type Name = keyof typeof endpoints;
    const endpoint = <const N extends Name>(name: N) =>
      HttpApiEndpoint.get(name, `/${name}`, {
        query: endpoints[name],
        success: Schema.Unknown,
      }).middleware(Middleware.SchemaErrors);
    const HandBuiltApi = HttpApi.make("handBuilt").add(
      HttpApiGroup.make("handBuilt").add(
        endpoint("union-of-fieldsets"),
        endpoint("union-with-empty-fieldset"),
        endpoint("suspended"),
        endpoint("flat-fieldsets"),
        endpoint("renamed-empty-fieldset"),
        endpoint("renamed-fieldset"),
        endpoint("open-fieldsets"),
        endpoint("record"),
      ),
    );
    const echo = ({ query }: { readonly query: unknown }) => Effect.succeed(query);
    const HandBuiltLive = HttpApiBuilder.group(HandBuiltApi, "handBuilt", (handlers) =>
      handlers.handleAll({
        "union-of-fieldsets": echo,
        "union-with-empty-fieldset": echo,
        suspended: echo,
        "flat-fieldsets": echo,
        "renamed-empty-fieldset": echo,
        "renamed-fieldset": echo,
        "open-fieldsets": echo,
        record: echo,
      }),
    );
    const serveHandBuilt = async (url: string) => {
      const appLayer = HttpApiBuilder.layer(HandBuiltApi).pipe(
        Layer.provide(HandBuiltLive),
        Layer.provide(Middleware.SchemaErrorsLive),
        Layer.provide(platformLayer),
      );
      const { dispose, handler } = HttpRouter.toWebHandler(appLayer);
      const response = await handler(new Request(`http://localhost${url}`)).finally(dispose);
      return { status: response.status, body: decodeJson(await response.text()) };
    };

    it.each([
      [
        "a union in which one member's fieldset for the type has a field",
        "/union-of-fieldsets?fields[tags]=name",
        { fields: { tags: ["name"] } },
      ],
      [
        "a declared `page` in one member of a union",
        "/union-with-empty-fieldset?page[limit]=1",
        { page: { limit: 1 } },
      ],
      [
        "a suspended query's fieldset",
        "/suspended?fields[posts]=title",
        { fields: { posts: ["title"] } },
      ],
      ["a suspended query's `page`", "/suspended?page[limit]=1", { page: { limit: 1 } }],
      [
        "a fieldset under its own wire name",
        "/flat-fieldsets?fields[people]=name",
        { "fields[people]": ["name"] },
      ],
      [
        "a fieldset renamed to its wire name",
        "/renamed-fieldset?fields[people]=name",
        { personFields: ["name"] },
      ],
      [
        "any `fields[…]` of an open `fields[` record",
        "/open-fieldsets?fields[anything]=x",
        { "fields[anything]": "x" },
      ],
      [
        "any family on a record that admits any name",
        "/record?fields[x]=a&page[y]=b&filter[z]=c",
        { "fields[x]": "a", "page[y]": "b", "filter[z]": "c" },
      ],
    ] as const)("supports %s", async (_, url, query) => {
      const response = await serveHandBuilt(url);
      expect(response.status).toBe(200);
      expect(response.body).toEqual(query);
    });

    it.each([
      [
        "a union whose every fieldset for the type is empty",
        "/union-with-empty-fieldset?fields[tags]=",
        ["fields[tags]"],
      ],
      [
        "`filter` on a union that declares none",
        "/union-with-empty-fieldset?filter[x]=1",
        ["filter[x]"],
      ],
      ["an empty fieldset in a suspended query", "/suspended?fields[tags]=", ["fields[tags]"]],
      ["`filter` on a suspended query that declares none", "/suspended?filter[x]=1", ["filter[x]"]],
      [
        "an empty fieldset under its own wire name",
        "/flat-fieldsets?fields[tags]=",
        ["fields[tags]"],
      ],
      [
        "an empty fieldset renamed to its wire name",
        "/renamed-empty-fieldset?fields[tags]=",
        ["fields[tags]"],
      ],
      ["`page` beside an open `fields[` record", "/open-fieldsets?page[limit]=1", ["page[limit]"]],
      ["a bare `fields` beside an open `fields[` record", "/open-fieldsets?fields=x", ["fields"]],
    ] as const)("rejects %s", async (_, url, parameters) => {
      const response = await serveHandBuilt(url);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ errors: parameters.map(unsupported) });
    });
  });
});
