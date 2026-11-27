/**
 * The relationship link helpers percent-encode each segment, so a link built
 * for an id carrying reserved characters reaches the route that serves it,
 * with `:id` decoded back to the id.
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
import * as Middleware from "./Middleware.js";
import { platformLayer } from "./Registry.js";
import * as Relationship from "./Relationship.js";
import * as Resource from "./Resource.js";
import { MEDIA_TYPE } from "./internal/media.js";

const Person = Resource.make("people", { attributes: { name: Schema.String } });
const Article = Resource.make("articles", {
  attributes: { title: Schema.String },
  relationships: { author: Relationship.one(() => Person) },
});

const Api = HttpApi.make("links").add(
  Group.make(
    Article,
    Endpoint.getRelationship(Article, "author"),
    Endpoint.related(Article, "author"),
  ),
);

// Each handler answers with the id the router decoded, as the author's id.
const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
  handlers
    .handle("authorRelationship", ({ params }) =>
      Effect.succeed(Handlers.linkage(Person.ref(Person.Id.make(params.id)))),
    )
    .handle("author", ({ params }) =>
      Effect.succeed(
        Handlers.data(Person.make({ id: Person.Id.make(params.id), attributes: { name: "n" } })),
      ),
    ),
);

const get = async (path: string) => {
  const { dispose, handler } = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(Api).pipe(
      Layer.provide(ArticlesLive),
      Layer.provide(Middleware.layer),
      Layer.provide(platformLayer),
    ),
  );
  const response = await handler(
    new Request(`http://localhost${path}`, { headers: { accept: MEDIA_TYPE } }),
  ).finally(dispose);
  return { status: response.status, body: (await response.json()) as { data: { id: string } } };
};

const ids = ["a/b", "a?b", "a#b", "100%", "with space", "e@x.com"];

describe("relationship links survive a round trip for an id with reserved characters", () => {
  it.each(ids)("%j through relationshipLink", async (id) => {
    const response = await get(Handlers.relationshipLink("articles", id, "author"));
    expect(response.status).toBe(200);
    expect(response.body.data.id).toBe(id);
  });

  it.each(ids)("%j through relatedLink", async (id) => {
    const response = await get(Handlers.relatedLink("articles", id, "author"));
    expect(response.status).toBe(200);
    expect(response.body.data.id).toBe(id);
  });
});

describe("relationship links under a prefix", () => {
  it("writes both default links under base, and takes related verbatim", () => {
    expect(
      Handlers.paginatedRelationship("people", "a/b", "articles", { base: "/api/v1/" }),
    ).toEqual({
      links: {
        self: "/api/v1/people/a%2Fb/relationships/articles",
        related: "/api/v1/people/a%2Fb/articles",
      },
    });
    expect(
      Handlers.paginatedRelationship("people", "9", "articles", {
        self: false,
        related: "/v2/people/9/articles",
      }),
    ).toEqual({ links: { related: "/v2/people/9/articles" } });
  });
});
