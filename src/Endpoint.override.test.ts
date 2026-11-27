/**
 * Overrides that extend an endpoint's derived contract: `query`, `success`
 * and `payload` given as a function of the default, with `Query.extend` and
 * `Document.extend`. The type-level half is `test/override-extend.types.ts`.
 */
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import * as Document from "./Document.js";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import * as Middleware from "./Middleware.js";
import * as Query from "./Query.js";
import * as Relationship from "./Relationship.js";
import { make as Resource } from "./Resource.js";
import { platformLayer } from "./Registry.js";
import { MEDIA_TYPE } from "./internal/media.js";

const Person = Resource("people", { attributes: { name: Schema.String } });
const Article = Resource("articles", {
  attributes: { title: Schema.String },
  relationships: { author: Relationship.one(() => Person) },
});

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const IncludeDeleted = Schema.optionalKey(Schema.Literals(["true", "false"]));

const Api = HttpApi.make("blog").add(
  Group.make(
    Article,
    Endpoint.list(Article, {
      sort: true,
      include: true,
      query: (derived) => Query.extend(derived, { includeDeleted: IncludeDeleted }),
      success: (derived) =>
        Document.extend(derived, { meta: Schema.Struct({ total: Schema.Int }) }),
    }),
    Endpoint.create(Article, { payload: (derived) => derived }),
  ),
);

const article = Article.make({
  id: Article.Id.make("1"),
  attributes: { title: "Hello" },
  relationships: { author: { data: { type: "people", id: Person.Id.make("9") } } },
});

const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
  handlers
    .handle("list", ({ query }) =>
      Effect.succeed({
        data: [article],
        meta: {
          total: query.includeDeleted === "true" ? 2 : 1,
        },
      }),
    )
    .handle("create", ({ payload }) =>
      Effect.succeed({
        data: Article.make({
          id: Article.Id.make("2"),
          attributes: payload.data.attributes,
          relationships: payload.data.relationships,
        }),
      }),
    ),
);

const request = async (url: string, init: RequestInit = {}) => {
  const appLayer = HttpApiBuilder.layer(Api).pipe(
    Layer.provide(ArticlesLive),
    Layer.provide(Middleware.layer),
    Layer.provide(platformLayer),
  );
  const { dispose, handler } = HttpRouter.toWebHandler(appLayer);
  onTestFinished(() => dispose());
  const response = await handler(new Request(url, init));
  return { status: response.status, body: await response.json() };
};

describe("query: (derived) => Query.extend(derived, …)", () => {
  it("adds the parameter and keeps the derived families", async () => {
    const response = await request(
      "http://localhost/articles?includeDeleted=true&sort=-title&include=author",
    );
    expect(response.status).toBe(200);
    expect(response.body.meta).toEqual({ total: 2 });
  });

  it("still rejects an undeclared reserved parameter", async () => {
    expect((await request("http://localhost/articles?deleted=true")).status).toBe(400);
  });

  it("answers a bad value of the added parameter with a 400 naming it", async () => {
    const response = await request("http://localhost/articles?includeDeleted=maybe");
    expect(response.status).toBe(400);
    expect(response.body.errors[0].source).toEqual({ parameter: "includeDeleted" });
  });
});

describe("payload: (derived) => …", () => {
  it("serves the derived payload", async () => {
    const response = await request("http://localhost/articles", {
      method: "POST",
      headers: { "content-type": MEDIA_TYPE },
      body: toJson({
        data: {
          type: "articles",
          attributes: { title: "New" },
          relationships: { author: { data: { type: "people", id: "9" } } },
        },
      }),
    });
    expect(response.status).toBe(201);
    expect(response.body.data.attributes).toEqual({ title: "New" });
  });
});

describe("Query.extend", () => {
  it("round-trips the added parameter beside the derived ones", () => {
    const query = Query.extend(Query.schema(Article, { sort: true }), {
      includeDeleted: IncludeDeleted,
    });
    const decoded = Schema.decodeSync(query)({ sort: "title", includeDeleted: "false" });
    expect(decoded).toEqual({
      sort: [{ field: "title", direction: "asc" }],
      includeDeleted: "false",
    });
    expect(Schema.encodeSync(query)(decoded)).toEqual({ sort: "title", includeDeleted: "false" });
  });

  it("extends a schema built with the filter grammar", () => {
    const Product = Resource("products", {
      attributes: { price: Schema.Int },
    });
    const query = Query.extend(Query.schema(Product, { filter: { q: Schema.String } }), {
      dryRun: Schema.optionalKey(Schema.String),
    });
    expect(Schema.decodeSync(query)({ "filter[q]": "x", dryRun: "1" })).toEqual({
      filter: { q: "x" },
      dryRun: "1",
    });
  });

  it("throws for a schema Query.schema did not build", () => {
    // SAFETY: the point is a schema of the wrong provenance.
    expect(() => Query.extend(Schema.Struct({}) as never, {})).toThrow(/Query.schema/);
  });

  it("refuses a bracketed or family name", () => {
    expect(() =>
      Query.schema(Article, { parameters: { "x[y]": Schema.optionalKey(Schema.String) } }),
    ).toThrow(/bare name/);
    expect(() =>
      Query.schema(Article, { parameters: { page: Schema.optionalKey(Schema.String) } }),
    ).toThrow(/bare name/);
  });
});

describe("Document.extend", () => {
  it("sets meta and keeps the derived members", () => {
    const base = Article.document();
    const document = Document.extend(base, {
      meta: Schema.Struct({ total: Schema.Int }),
    });
    expect(document.fields.data).toBe(base.fields.data);
    expect(document.fields.included).toBe(base.fields.included);
    const decoded = Schema.decodeSync(document)({
      data: { type: "articles", id: "1", attributes: { title: "x" } },
    });
    expect(Option.fromUndefinedOr(decoded.meta)).toEqual(Option.none());
    expect(() =>
      Schema.decodeUnknownSync(document)({
        data: { type: "articles", id: "1", attributes: { title: "x" } },
        meta: { total: "nope" },
      }),
    ).toThrow();
  });
});
