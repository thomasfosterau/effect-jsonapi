/**
 * A resource whose `memberNames` renames its members, served end to end: its
 * routes, documents, query parameters, error pointers and links use the wire
 * names, and its handlers see the keys.
 */
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as R from "effect/Record";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder, OpenApi } from "effect/http-api";
import * as Client from "./Client.js";
import * as Conformance from "./Conformance.js";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import * as Handlers from "./Handlers.js";
import * as Middleware from "./Middleware.js";
import { platformLayer } from "./Registry.js";
import * as Relationship from "./Relationship.js";
import * as Resource from "./Resource.js";
import { MEDIA_TYPE } from "./internal/media.js";

const Person = Resource.make("people", {
  attributes: { fullName: Schema.String },
  memberNames: "kebab",
});
const Article = Resource.make("articles", {
  attributes: {
    title: Schema.String,
    createdAt: Resource.attribute(Schema.String, { sort: true, filter: true }),
  },
  relationships: { blogAuthor: Relationship.one(() => Person) },
  memberNames: "kebab",
});

const Api = HttpApi.make("names").add(
  Group.make(
    Article,
    Endpoint.get(Article, { include: true, fields: true }),
    Endpoint.list(Article, { sort: true, filter: true }),
    Endpoint.create(Article),
    Endpoint.getRelationship(Article, "blogAuthor"),
    Endpoint.related(Article, "blogAuthor"),
  ),
);

const ada = Person.make({ id: Person.Id.make("9"), attributes: { fullName: "Ada" } });
const article = Article.make({
  id: Article.Id.make("1"),
  attributes: { title: "Hi", createdAt: "2026-11-27" },
  relationships: { blogAuthor: { data: Person.ref("9") } },
});

// What each handler saw, so a test can check it was given keys.
const seen: Array<unknown> = [];

const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
  handlers
    .handle("get", ({ query }) => {
      seen.push(query);
      return Effect.succeed(
        Handlers.data(article, { included: [ada], onResource: Handlers.links(Api) }),
      );
    })
    .handle("list", ({ query }) => {
      seen.push(query);
      return Effect.succeed(Handlers.collection([article]));
    })
    .handle("create", ({ payload }) => {
      seen.push(payload.data.attributes);
      return Effect.succeed(Handlers.data(article));
    })
    .handle("blogAuthorRelationship", () => Effect.succeed(Handlers.linkage(Person.ref("9"))))
    .handle("blogAuthor", () => Effect.succeed(Handlers.data(ada))),
);

const fetchApp = (request: Request): Promise<Response> => {
  const { dispose, handler } = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(Api).pipe(
      Layer.provide(ArticlesLive),
      Layer.provide(Middleware.layer),
      Layer.provide(platformLayer),
    ),
  );
  // Read the body before the handler is disposed.
  return handler(request)
    .then(async (response) => new Response(await response.text(), response))
    .finally(dispose);
};

const request = async (path: string, init?: RequestInit) => {
  const response = await fetchApp(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: { accept: MEDIA_TYPE, "content-type": MEDIA_TYPE },
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : Schema.decodeSync(Json)(text) };
};

const Json = Schema.fromJsonString(Schema.Any);

// An `HttpClient` that sends every request to the in-memory api.
const inMemory = HttpClient.make((sent) =>
  Effect.gen(function* () {
    const web = yield* HttpClientRequest.toWeb(sent);
    const response = yield* Effect.tryPromise({
      try: () => fetchApp(web),
      catch: (cause) => new Cause.UnknownError(cause),
    });
    return HttpClientResponse.fromWeb(sent, response);
  }).pipe(Effect.orDie),
);

describe("memberNames over HTTP", () => {
  it("serves the document, its links and its include under the wire names", async () => {
    seen.length = 0;
    const response = await request("/articles/1?include=blog-author&fields[people]=full-name");
    expect(response.status).toBe(200);
    expect(response.body.data.attributes).toEqual({ title: "Hi", "created-at": "2026-11-27" });
    expect(response.body.data.relationships["blog-author"]).toEqual({
      data: { type: "people", id: "9" },
      links: {
        self: "/articles/1/relationships/blog-author",
        related: "/articles/1/blog-author",
      },
    });
    expect(response.body.included).toEqual([
      { type: "people", id: "9", attributes: { "full-name": "Ada" } },
    ]);
    expect(seen).toEqual([{ include: ["blogAuthor"], fields: { people: ["fullName"] } }]);
  });

  it("applies a sparse fieldset given in wire names", async () => {
    const response = await request("/articles/1?fields[articles]=created-at");
    expect(response.status).toBe(200);
    expect(response.body.data.attributes).toEqual({ "created-at": "2026-11-27" });
    expect(response.body.data.relationships).toBeUndefined();
  });

  it("decodes sort and filter given in wire names to keys", async () => {
    seen.length = 0;
    const response = await request("/articles?sort=-created-at&filter[created-at]=x");
    expect(response.status).toBe(200);
    expect(seen).toEqual([
      {
        sort: [{ field: "createdAt", direction: "desc" }],
        filter: { _tag: "Compare", op: "eq", field: "createdAt", value: "x" },
      },
    ]);
  });

  it("rejects a sort on a key, naming the wire vocabulary", async () => {
    const response = await request("/articles?sort=createdAt");
    expect(response.status).toBe(400);
    expect(response.body.errors[0].source).toEqual({ parameter: "sort" });
    expect(response.body.errors[0].meta.sortableFields).toEqual(["title", "created-at"]);
  });

  it("serves the relationship routes under the wire name", async () => {
    expect((await request("/articles/1/relationships/blog-author")).body.data).toEqual({
      type: "people",
      id: "9",
    });
    expect((await request("/articles/1/blog-author")).body.data.attributes).toEqual({
      "full-name": "Ada",
    });
    expect((await request("/articles/1/relationships/blogAuthor")).status).toBe(404);
  });

  it("hands the handler a create payload under keys, and points at wire names", async () => {
    seen.length = 0;
    const body = (attributes: R.ReadonlyRecord<string, unknown>) =>
      Schema.encodeSync(Json)({
        data: {
          type: "articles",
          attributes,
          relationships: { "blog-author": { data: { type: "people", id: "9" } } },
        },
      });
    const ok = await request("/articles", {
      method: "POST",
      body: body({ title: "Hi", "created-at": "now" }),
    });
    expect(ok.status).toBe(201);
    expect(seen).toEqual([{ title: "Hi", createdAt: "now" }]);
    const bad = await request("/articles", {
      method: "POST",
      body: body({ title: "Hi", "created-at": 1 }),
    });
    expect(bad.status).toBe(400);
    expect(bad.body.errors[0].source).toEqual({ pointer: "/data/attributes/created-at" });
  });

  it("describes the wire names in OpenAPI", () => {
    const spec = Schema.encodeSync(Json)(OpenApi.fromApi(Api));
    expect(spec).toContain('"created-at"');
    expect(spec).toContain("/articles/{id}/relationships/blog-author");
    expect(spec).not.toContain('"createdAt"');
  });

  it.effect("round-trips through the typed client under keys", () =>
    Effect.gen(function* () {
      seen.length = 0;
      const client = yield* Client.make(Api, { baseUrl: "http://localhost" });
      const listed = yield* client.articles.list({
        query: { sort: [{ field: "createdAt", direction: "asc" }] },
      });
      expect(listed.data[0]?.attributes.createdAt).toBe("2026-11-27");
      expect(seen).toEqual([{ sort: [{ field: "createdAt", direction: "asc" }] }]);
      const created = yield* client.articles.create({
        payload: {
          data: {
            type: "articles",
            attributes: { title: "Hi", createdAt: "then" },
            relationships: { blogAuthor: { data: Person.ref("9") } },
          },
        },
      });
      expect(created.data.relationships?.blogAuthor.data.id).toBe("9");
      expect(seen[1]).toEqual({ title: "Hi", createdAt: "then" });
    }).pipe(Effect.provideService(HttpClient.HttpClient, inMemory)),
  );

  it.effect("passes the conformance rules that read member names off the wire", () =>
    Effect.gen(function* () {
      const only = [
        "spec/document/full-linkage",
        "spec/document/included-on-include",
        "spec/document/relationship-data-identifiers",
        "spec/query/sparse-fieldsets-primary",
        "spec/query/unsupported-include-path",
        "spec/query/unsupported-sort-field",
        "spec/links/related-dereferences",
        "spec/links/related-matches-linkage",
        "spec/links/relationship-self-dereferences",
        "spec/links/relationship-self-matches-linkage",
        "profile/filter/rejections",
      ];
      const report = yield* Conformance.verify(Api, { ids: { articles: "1" }, only });
      expect(report.outcomes.map((outcome) => [outcome.rule.id, outcome._tag])).toEqual(
        only.map((id) => [id, "Passed"]),
      );
    }).pipe(
      Effect.provide(
        ArticlesLive.pipe(Layer.provideMerge(Middleware.layer), Layer.provideMerge(platformLayer)),
      ),
      Effect.scoped,
    ),
  );
});
