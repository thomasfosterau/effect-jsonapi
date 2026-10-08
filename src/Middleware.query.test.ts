import { describe, expect, it } from "vite-plus/test";
import { Effect, Layer, Schema, Tracer } from "effect";
import { HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import type { ContentNegotiation, SchemaErrors } from "./Middleware.js";
import * as Middleware from "./Middleware.js";
import * as Query from "./Query.js";
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

const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
  handlers
    .handle("get", ({ params }) =>
      Effect.succeed({ data: Article.make({ id: params.id, attributes: { title: "Hello" } }) }),
    )
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

describe("Middleware.checkQueryParameters", () => {
  const check = Middleware.checkQueryParameters;

  it("returns undefined when every name is acceptable", () => {
    expect(check([])).toBeUndefined();
    expect(
      check([
        "include",
        "fields[articles]",
        "sort",
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
  // of structs, and a record that admits any name.
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
        HttpApiEndpoint.get("open", "/open", {
          query: Schema.Record(Schema.String, Schema.String),
          success: Schema.String,
        }).middleware(Middleware.SchemaErrors),
      ),
  );
  const QueryVariantsLive = HttpApiBuilder.group(QueryVariantsApi, "variants", (handlers) =>
    handlers.handle("union", () => Effect.succeed("ok")).handle("open", () => Effect.succeed("ok")),
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

  it("stands aside for a schema that admits any name", async () => {
    expect((await serve("/open?unknown=1")).status).toBe(200);
  });
});
