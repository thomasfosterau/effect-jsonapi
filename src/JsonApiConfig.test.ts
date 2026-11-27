import { describe, expect, it, onTestFinished } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import * as JsonApiConfig from "./JsonApiConfig.js";
import * as Middleware from "./Middleware.js";
import { make as Resource } from "./Resource.js";
import { platformLayer } from "./Registry.js";
import { MEDIA_TYPE } from "./internal/media.js";

const Article = Resource("articles", { attributes: { title: Schema.NonEmptyString } });

const Api = HttpApi.make("blog").add(Group.make(Article, Endpoint.get(Article)));

const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
  handlers.handle("get", ({ params }) =>
    Effect.succeed({ data: Article.make({ id: params.id, attributes: { title: "Hello" } }) }),
  ),
);

// Builds the api over a middleware layer and an optional config, and answers
// one request through it.
const status = async (
  middleware: Layer.Layer<Middleware.ContentNegotiation | Middleware.SchemaErrors>,
  config: Layer.Layer<never>,
  url: string,
  headers: Record<string, string> = {},
) => {
  const appLayer = HttpApiBuilder.layer(Api).pipe(
    Layer.provide(ArticlesLive),
    Layer.provide(middleware),
    Layer.provide(platformLayer),
    Layer.provide(config),
  );
  const { dispose, handler } = HttpRouter.toWebHandler(appLayer);
  onTestFinished(() => dispose());
  return (await handler(new Request(url, { headers }))).status;
};

const url = "http://localhost/articles/1";

describe("JsonApiConfig", () => {
  it("defaults to today's policy", () => {
    expect(JsonApiConfig.make()).toEqual(JsonApiConfig.defaults);
    expect(JsonApiConfig.make({ checkLinkage: false })).toEqual({
      ...JsonApiConfig.defaults,
      checkLinkage: false,
    });
  });

  it("answers Accept without a JSON:API media type 406 by default", async () => {
    expect(await status(Middleware.layer, Layer.empty, url, { accept: "application/json" })).toBe(
      406,
    );
  });

  it("serves Accept without a JSON:API media type under acceptWithoutJsonApi: serve", async () => {
    const config = JsonApiConfig.layer({ acceptWithoutJsonApi: "serve" });
    expect(await status(Middleware.layer, config, url, { accept: "application/json" })).toBe(200);
    expect(await status(Middleware.layer, config, url, { accept: "text/html" })).toBe(200);
    // A JSON:API instance in Accept is still judged by §5.
    expect(
      await status(Middleware.layer, config, url, {
        accept: `application/json, ${MEDIA_TYPE}; charset=utf-8`,
      }),
    ).toBe(406);
  });

  it("lets a layerWith option override the config", async () => {
    const config = JsonApiConfig.layer({ acceptWithoutJsonApi: "serve" });
    const strict = Middleware.layerWith({ acceptWithoutJsonApi: "notAcceptable" });
    expect(await status(strict, config, url, { accept: "application/json" })).toBe(406);
  });

  it("reads the extensions from the config", async () => {
    const ext = `${MEDIA_TYPE}; ext="https://jsonapi.org/ext/atomic"`;
    expect(await status(Middleware.layer, Layer.empty, url, { accept: ext })).toBe(406);
    const config = JsonApiConfig.layer({ extensions: ["https://jsonapi.org/ext/atomic"] });
    expect(await status(Middleware.layer, config, url, { accept: ext })).toBe(200);
  });

  it("reads the allowed query parameters from the config", async () => {
    const withLang = `${url}?lang=en`;
    expect(await status(Middleware.layer, Layer.empty, withLang)).toBe(400);
    const config = JsonApiConfig.layer({ allowedQueryParameters: ["lang"] });
    expect(await status(Middleware.layer, config, withLang)).toBe(200);
    // The config's list replaces the default `_`.
    expect(await status(Middleware.layer, config, `${url}?_=1`)).toBe(400);
  });

  it("refuses an invalid allowed query parameter from the config when the layer is built", async () => {
    const config = JsonApiConfig.layer({ allowedQueryParameters: ["page"] });
    await expect(status(Middleware.layer, config, url)).rejects.toThrow(
      /allowedQueryParameters entry "page"/,
    );
  });
});

describe("Middleware.acceptIsAcceptable with acceptWithoutJsonApi", () => {
  const serve = { acceptWithoutJsonApi: "serve" } as const;

  it("admits an Accept naming no JSON:API instance", () => {
    expect(Middleware.acceptIsAcceptable("application/json", serve)).toBe(true);
    expect(Middleware.acceptIsAcceptable("application/json")).toBe(false);
  });

  it("still refuses when every JSON:API instance is unacceptable", () => {
    expect(Middleware.acceptIsAcceptable(`${MEDIA_TYPE};q=0`, serve)).toBe(false);
    expect(Middleware.acceptIsAcceptable(`text/html, ${MEDIA_TYPE}; charset=utf-8`, serve)).toBe(
      false,
    );
  });
});

describe("the presets", () => {
  const jsonApi = { accept: MEDIA_TYPE };

  it("strict is today's policy", async () => {
    expect(JsonApiConfig.strict).toEqual(JsonApiConfig.defaults);
    const config = JsonApiConfig.layer(JsonApiConfig.strict);
    expect(await status(Middleware.layer, config, `${url}?lang=en`, jsonApi)).toBe(400);
    expect(await status(Middleware.layer, config, url, { accept: "application/json" })).toBe(406);
  });

  it("lenient serves plain JSON clients and passes over unknown parameters", async () => {
    const config = JsonApiConfig.layer(JsonApiConfig.lenient);
    expect(await status(Middleware.layer, config, url, { accept: "application/json" })).toBe(200);
    expect(await status(Middleware.layer, config, `${url}?lang=en`, jsonApi)).toBe(200);
    expect(await status(Middleware.layer, config, `${url}?ext:param=1`, jsonApi)).toBe(200);
    // an undeclared family of the specification's is never dropped
    expect(await status(Middleware.layer, config, `${url}?sort=title`, jsonApi)).toBe(400);
    expect(await status(Middleware.layer, config, `${url}?page[size]=1`, jsonApi)).toBe(400);
  });

  it("lets a layerWith option override unknownQueryParameters", async () => {
    const config = JsonApiConfig.layer(JsonApiConfig.lenient);
    const strict = Middleware.layerWith({ unknownQueryParameters: "reject" });
    expect(await status(strict, config, `${url}?lang=en`, jsonApi)).toBe(400);
  });
});
