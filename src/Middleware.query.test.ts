import { describe, expect, it } from "vite-plus/test";
import { Effect, Layer, Schema, Tracer } from "effect";
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

  it("accepts base names made only of a-z, the specification's families included", () => {
    expect(() =>
      Middleware.schemaErrorsLayer({ allowedQueryParameters: ["lang", "ref", "page"] }),
    ).not.toThrow();
    expect(() => Middleware.layerWith({ allowedQueryParameters: [] })).not.toThrow();
  });
});

describe("Middleware.checkQueryParameters", () => {
  const check = Middleware.checkQueryParameters;

  it("returns undefined when every name is acceptable", () => {
    expect(check([])).toBeUndefined();
    expect(
      check([
        "fields[articles]",
        "page[limit]",
        "filter[age][gt]",
        "filter",
        "fooBar",
        "x-trace",
        "foo_bar",
        "ext:name",
        "x1",
        "[odd]",
      ]),
    ).toBeUndefined();
  });

  it("rejects `include` and `sort` unless declared or allowed (#261)", () => {
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
    expect(check(["include"], { allowedQueryParameters: ["include"] })).toBeUndefined();
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
  // to any requests that include it." §Sorting: "If the server does not
  // support sorting as specified in the query parameter `sort`, it MUST
  // return `400 Bad Request`." An endpoint supports either by declaring it
  // in its `query` schema.
  const Person = Resource.make("people", {
    attributes: { name: Schema.NonEmptyString },
  });
  const Post = Resource.make("posts", {
    attributes: { title: Schema.NonEmptyString },
    relationships: { author: Relationship.one(() => Person) },
  });
  // A resource with no attributes, so `sort: true` legalises no field, and
  // no relationships, so an include allow-list can only be empty.
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
        Endpoint.list(Tag, { sort: true }),
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
    ["the repeated-key spelling", "/people/1?include=author&include=author"],
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

  // An endpoint that declares the family with an empty vocabulary
  // (`include: { paths: [] }`, or `sort: true` over no attributes) does
  // declare the parameter: its codec answers every value naming something,
  // and an empty value requests nothing.
  it("leaves a declared family with an empty vocabulary to its codec", async () => {
    const path = await serve("/tags/1?include=author");
    expect(path.status).toBe(400);
    expect(path.body.errors[0].source).toEqual({ parameter: "include" });
    expect(path.body.errors[0].meta).toEqual({ includablePaths: [] });
    const field = await serve("/tags?sort=name");
    expect(field.status).toBe(400);
    expect(field.body.errors[0].source).toEqual({ parameter: "sort" });
    expect(field.body.errors[0].meta).toEqual({ sortableFields: [] });
    queries.length = 0;
    expect((await serve("/tags/1?include=")).status).toBe(200);
    expect((await serve("/tags?sort=")).status).toBe(200);
    expect(queries).toEqual([{ include: [] }, { sort: [] }]);
  });

  // Whether `fields[TYPE]`, `page[…]` and `filter[…]` on an endpoint that
  // declares none of that family are rejected too is the owner's decision
  // (#261); until it is taken they stay ignored, as before.
  it.each(["fields[people]=name", "page[limit]=1", "filter[name]=Ada", "filter=x"])(
    "still ignores the undeclared `?%s`",
    async (query) => {
      expect((await serve(`/people/1?${query}`)).status).toBe(200);
    },
  );

  it("applies under the host-negotiated layer too", async () => {
    const response = await serve("/people/1?include=author", Middleware.layerHostNegotiated);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ errors: [unsupported("include", "include")] });
  });

  it("admits a family listed in allowedQueryParameters, which the endpoint then ignores", async () => {
    queries.length = 0;
    const allowing = Middleware.layerWith({ allowedQueryParameters: ["sort"] });
    expect((await serve("/posts/1?sort=title", allowing)).status).toBe(200);
    expect(queries).toEqual([{}]);
    expect((await serve("/posts?include=author", allowing)).status).toBe(400);
  });
});
