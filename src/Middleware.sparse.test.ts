/**
 * JSON:API 1.1 §Sparse Fieldsets: an endpoint MUST NOT include fields the
 * request's `fields[TYPE]` excludes. The middleware applies them to the
 * encoded document, whatever the handler returned.
 */
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import * as Handlers from "./Handlers.js";
import * as JsonApiConfig from "./JsonApiConfig.js";
import * as Middleware from "./Middleware.js";
import { platformLayer } from "./Registry.js";
import * as Relationship from "./Relationship.js";
import * as Resource from "./Resource.js";
import { MEDIA_TYPE } from "./internal/media.js";

const Person = Resource.make("people", {
  attributes: { name: Schema.String, email: Schema.String },
});

const Article = Resource.make("articles", {
  attributes: { title: Schema.String, body: Schema.String },
  relationships: { author: Relationship.one(() => Person) },
});

const Api = HttpApi.make("sparse").add(
  Group.make(Article, Endpoint.get(Article, { include: true, fields: true })),
);

const ada = Person.make({
  id: Person.Id.make("9"),
  attributes: { name: "Ada", email: "ada@example.com" },
});

const article = Article.make({
  id: Article.Id.make("1"),
  attributes: { title: "t", body: "b" },
  relationships: { author: { data: { type: "people", id: Person.Id.make("9") } } },
});

// A handler that ignores `fields`: it always answers with whole resources.
const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
  handlers.handle("get", ({ query }) =>
    Effect.succeed(Handlers.data(article, { included: query.include === undefined ? [] : [ada] })),
  ),
);

const send = async (
  query: string,
  options?: Middleware.NegotiationOptions & Middleware.SchemaErrorsOptions,
) => {
  const { dispose, handler } = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(Api).pipe(
      Layer.provide(ArticlesLive),
      Layer.provide(options === undefined ? Middleware.layer : Middleware.layerWith(options)),
      Layer.provide(platformLayer),
    ),
  );
  const response = await handler(
    new Request(`http://localhost/articles/1?${query}`, { headers: { accept: MEDIA_TYPE } }),
  ).finally(dispose);
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.json(),
  };
};

describe("sparse fieldsets on the encoded document", () => {
  it("removes the attributes and relationships a fieldset excludes", async () => {
    const { status, body } = await send("fields[articles]=title");
    expect(status).toBe(200);
    expect(body.data).toEqual({
      type: "articles",
      id: "1",
      attributes: { title: "t" },
    });
  });

  it("projects included resources by their own type's fieldset", async () => {
    const { body } = await send("include=author&fields[articles]=author&fields[people]=name");
    expect(body.data.attributes).toEqual({});
    expect(body.data.relationships).toEqual({
      author: { data: { type: "people", id: "9" } },
    });
    expect(body.included).toEqual([{ type: "people", id: "9", attributes: { name: "Ada" } }]);
  });

  it("keeps the media type and leaves an unrequested type whole", async () => {
    const { contentType, body } = await send("include=author&fields[people]=name");
    expect(contentType).toBe(MEDIA_TYPE);
    expect(body.data.attributes).toEqual({ title: "t", body: "b" });
  });

  it("answers a violation with a 500 under verify", async () => {
    const { status, body } = await send("fields[articles]=title", { sparseFieldsets: "verify" });
    expect(status).toBe(500);
    expect(body.errors).toHaveLength(1);
  });

  it("passes a document that honours the fieldsets under verify", async () => {
    expect((await send("include=author", { sparseFieldsets: "verify" })).status).toBe(200);
  });

  it("reads the policy from JsonApiConfig", async () => {
    const { dispose, handler } = HttpRouter.toWebHandler(
      HttpApiBuilder.layer(Api).pipe(
        Layer.provide(ArticlesLive),
        Layer.provide(Middleware.layer),
        Layer.provide(JsonApiConfig.layer({ sparseFieldsets: "handler" })),
        Layer.provide(platformLayer),
      ),
    );
    const response = await handler(
      new Request("http://localhost/articles/1?fields[articles]=title", {
        headers: { accept: MEDIA_TYPE },
      }),
    ).finally(dispose);
    expect((await response.json()).data.attributes).toEqual({ title: "t", body: "b" });
  });

  it("leaves the document to the handler under handler", async () => {
    const { body } = await send("fields[articles]=title", { sparseFieldsets: "handler" });
    expect(body.data.attributes).toEqual({ title: "t", body: "b" });
  });
});
