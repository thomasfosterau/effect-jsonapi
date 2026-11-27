/**
 * JSON:API 1.1 §6.1: a server MUST name the profiles it applied to a document
 * in the `profile` parameter of its `Content-Type`. An endpoint's `profiles`
 * option, and `idempotency`, put that parameter on its success media type.
 */
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder, OpenApi } from "effect/http-api";
import * as ApiError from "./ApiError.js";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import * as Idempotency from "./Idempotency.js";
import * as Middleware from "./Middleware.js";
import { platformLayer } from "./Registry.js";
import * as Resource from "./Resource.js";
import { MEDIA_TYPE } from "./internal/media.js";

class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
  status: 404,
  title: "Article not found",
  fields: { id: Schema.String },
}) {}

const PROFILE = "https://example.com/profiles/timestamps";

const Article = Resource.make("articles", { attributes: { title: Schema.String } });

const Api = HttpApi.make("profiles").add(
  Group.make(
    Article,
    Endpoint.get(Article, { profiles: [PROFILE], errors: [ArticleNotFound] }),
    Endpoint.list(Article),
    Endpoint.create(Article, { profiles: [PROFILE], idempotency: true }),
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
    .handle("list", () => Effect.succeed({ data: [] }))
    .handle("create", () => Effect.succeed({ data: article("2") })),
);

const send = async (method: string, path: string) => {
  const { dispose, handler } = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(Api).pipe(
      Layer.provide(ArticlesLive),
      Layer.provide(Middleware.layer),
      Layer.provide(Idempotency.layer(Idempotency.memoryStore())),
      Layer.provide(platformLayer),
    ),
  );
  const response = await handler(
    new Request(`http://localhost${path}`, {
      method,
      headers: { accept: MEDIA_TYPE, "content-type": MEDIA_TYPE },
      body: method === "POST" ? '{"data":{"type":"articles","attributes":{"title":"t"}}}' : null,
    }),
  ).finally(dispose);
  return { status: response.status, contentType: response.headers.get("content-type") };
};

const profiled = (...profiles: ReadonlyArray<string>) =>
  `${MEDIA_TYPE};profile="${profiles.join(" ")}"`;

describe("an endpoint's applied profiles", () => {
  it("are named on the media type of its success responses", async () => {
    expect(await send("GET", "/articles/1")).toEqual({
      status: 200,
      contentType: profiled(PROFILE),
    });
  });

  it("include the Idempotency-Key profile when the endpoint opts in", async () => {
    expect(await send("POST", "/articles")).toEqual({
      status: 201,
      contentType: profiled(PROFILE, Idempotency.PROFILE_URI),
    });
  });

  it("leave an endpoint without any on the bare media type", async () => {
    expect(await send("GET", "/articles")).toEqual({ status: 200, contentType: MEDIA_TYPE });
  });

  it("are not claimed for an error document", async () => {
    expect(await send("GET", "/articles/9")).toEqual({ status: 404, contentType: MEDIA_TYPE });
  });

  it("are the media type the OpenAPI document gives the success response", () => {
    const spec = OpenApi.fromApi(Api);
    const content = (path: string, method: "get" | "post", status: number) =>
      R.keys(spec.paths[path]?.[method]?.responses?.[status]?.content ?? {});
    expect(content("/articles/{id}", "get", 200)).toEqual([profiled(PROFILE)]);
    expect(content("/articles", "get", 200)).toEqual([MEDIA_TYPE]);
  });
});
