/**
 * JSON:API 1.1 §6.3: a server that supports `ext` or `profile` SHOULD send
 * `Vary: Accept` on every response, with or without an extension or profile
 * applied. The content negotiation middleware adds it to each response it
 * handles, merged with a `Vary` the handler set.
 */
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import * as ApiError from "./ApiError.js";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import * as JsonApiConfig from "./JsonApiConfig.js";
import * as Middleware from "./Middleware.js";
import { platformLayer } from "./Registry.js";
import * as Resource from "./Resource.js";
import { MEDIA_TYPE } from "./internal/media.js";

class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
  status: 404,
  title: "Article not found",
  fields: { id: Schema.String },
}) {}

const Article = Resource.make("articles", { attributes: { title: Schema.String } });

const Api = HttpApi.make("vary").add(
  Group.make(
    Article,
    Endpoint.get(Article, { errors: [ArticleNotFound] }),
    Endpoint.list(Article),
    Endpoint.create(Article),
    Endpoint.delete(Article),
  ),
);

const article = (id: string) =>
  Article.make({ id: Article.Id.make(id), attributes: { title: "t" } });

const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
  handlers
    .handle("get", ({ params }) =>
      params.id === "1"
        ? Effect.succeed({ data: article("1") })
        : Effect.fail(new ArticleNotFound({ id: params.id })),
    )
    // A handler that sets a `Vary` of its own.
    .handle("list", () =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { data: [] },
          { contentType: MEDIA_TYPE, headers: { vary: "Origin" } },
        ),
      ),
    )
    .handle("create", () => Effect.succeed({ data: article("2") }))
    .handle("delete", () => Effect.void),
);

const send = async (
  middleware: Layer.Layer<
    Middleware.ContentNegotiation | Middleware.SchemaErrors | Middleware.CreatedLocation
  >,
  method: string,
  path: string,
  headers: Record<string, string> = {},
) => {
  const { dispose, handler } = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(Api).pipe(
      Layer.provide(ArticlesLive),
      Layer.provide(middleware),
      Layer.provide(platformLayer),
    ),
  );
  const response = await handler(
    new Request(`http://localhost${path}`, {
      method,
      headers: { accept: MEDIA_TYPE, ...headers },
      body: method === "POST" ? '{"data":{"type":"articles","attributes":{"title":"t"}}}' : null,
    }),
  ).finally(dispose);
  return { status: response.status, vary: response.headers.get("vary") };
};

const json = { "content-type": MEDIA_TYPE };

describe("Vary: Accept", () => {
  it.each([
    ["a 200", "GET", "/articles/1", {}, 200],
    ["a 201", "POST", "/articles", json, 201],
    ["a 204", "DELETE", "/articles/1", {}, 204],
    ["a handler's 404", "GET", "/articles/9", {}, 404],
    ["a 406", "GET", "/articles/1", { accept: `${MEDIA_TYPE}; charset=utf-8` }, 406],
    ["a 415", "POST", "/articles", { "content-type": `${MEDIA_TYPE}; charset=utf-8` }, 415],
    ["a 400", "GET", "/articles/1?unknown=1", {}, 400],
  ] as const)("is on %s", async (_, method, path, headers, status) => {
    expect(await send(Middleware.layer, method, path, headers)).toEqual({ status, vary: "Accept" });
  });

  it("keeps a Vary the handler set", async () => {
    expect(await send(Middleware.layer, "GET", "/articles")).toEqual({
      status: 200,
      vary: "Origin, Accept",
    });
  });

  it("is left to the api by JsonApiConfig's varyAccept: false", async () => {
    const off = Middleware.layer.pipe(Layer.provide(JsonApiConfig.layer({ varyAccept: false })));
    expect(await send(off, "GET", "/articles/1")).toEqual({ status: 200, vary: null });
  });

  it("is left to the api with varyAccept: false", async () => {
    const off = Middleware.layerWith({ varyAccept: false });
    expect(await send(off, "GET", "/articles/1")).toEqual({ status: 200, vary: null });
    expect(await send(off, "GET", "/articles")).toEqual({ status: 200, vary: "Origin" });
  });
});
