import { layer } from "@effect/vitest";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpApi, HttpApiBuilder, HttpApiSchema, HttpApiTest } from "effect/http-api";
import * as ApiError from "./ApiError.js";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import * as Handlers from "./Handlers.js";
import * as Middleware from "./Middleware.js";
import { platformLayer } from "./Registry.js";
import { make as Resource } from "./Resource.js";

const Article = Resource("articles", {
  attributes: { title: Schema.String, published: Schema.Boolean },
});

class AlreadyPublished extends ApiError.make<AlreadyPublished>()("AlreadyPublished", {
  status: 409,
  code: "already_published",
  title: "Already published",
  fields: { id: Schema.String },
  detail: (e) => `Article ${e.id} is already published`,
}) {}

const ImportPayload = Schema.Struct({ urls: Schema.Array(Schema.String) });

const publish = Endpoint.action(Article, "publish", { errors: [AlreadyPublished] });

const Api = HttpApi.make("blog").add(
  Group.make(
    Article,
    publish,
    Endpoint.action(Article, "rename", {
      method: "PUT",
      path: "/articles/:id/title",
      payload: Schema.Struct({ title: Schema.String }),
    }),
    Endpoint.collectionAction(Article, "import", {
      payload: ImportPayload,
      success: HttpApiSchema.NoContent,
    }),
  ),
);

const imported: Array<string> = [];

const article = (id: string, title: string, published: boolean) =>
  Article.make({ id: Article.Id.make(id), attributes: { title, published } });

const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
  handlers
    .handle("publish", ({ params }) =>
      params.id === "2"
        ? Effect.fail(new AlreadyPublished({ id: params.id }))
        : Effect.succeed(Handlers.data(article(params.id, "Hi", true))),
    )
    .handle("rename", ({ params, payload }) =>
      Effect.succeed(Handlers.data(article(params.id, payload.title, false))),
    )
    .handle("import", ({ payload }) =>
      Effect.sync(() => {
        imported.push(...payload.urls);
      }),
    ),
);

const buildClient = HttpApiTest.groups(Api, ["articles"]);

describe("Endpoint.action paths", () => {
  it("defaults a member action to POST /<type>/:id/<name>, a collection action to POST /<type>/<name>", () => {
    expect([publish.method, publish.path]).toEqual(["POST", "/articles/:id/publish"]);
    const importAction = Api.groups.articles.endpoints.import;
    expect([importAction.method, importAction.path]).toEqual(["POST", "/articles/import"]);
  });
});

layer(Layer.provideMerge(ArticlesLive, Layer.merge(Middleware.layer, platformLayer)), {
  buildPerTest: true,
})("Endpoint.action / Endpoint.collectionAction", (it) => {
  it.effect("answers a bodyless member action with the resource's document", () =>
    Effect.gen(function* () {
      const client = yield* buildClient;
      const document = yield* client.articles.publish({ params: { id: Article.Id.make("1") } });
      expect(document.data).toMatchObject({ type: "articles", id: "1" });
      expect(document.data.attributes.published).toBe(true);
    }),
  );

  it.effect("fails a member action with its declared error", () =>
    Effect.gen(function* () {
      const client = yield* buildClient;
      const error = yield* Effect.flip(
        client.articles.publish({ params: { id: Article.Id.make("2") } }),
      );
      expect(error).toBeInstanceOf(AlreadyPublished);
    }),
  );

  it.effect("serves a custom method and path, decoding the payload", () =>
    Effect.gen(function* () {
      const client = yield* buildClient;
      const document = yield* client.articles.rename({
        params: { id: Article.Id.make("3") },
        payload: { title: "Renamed" },
      });
      expect(document.data.attributes.title).toBe("Renamed");
    }),
  );

  it.effect("answers a collection action declared with NoContent with 204", () =>
    Effect.gen(function* () {
      const client = yield* buildClient;
      const result = yield* client.articles.import({ payload: { urls: ["https://a.test"] } });
      expectTypeOf(result).toEqualTypeOf<void>();
      expect(imported).toContain("https://a.test");
    }),
  );
});
