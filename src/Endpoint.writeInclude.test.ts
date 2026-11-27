/**
 * `include` and `fields` on `create` and `update`: a write answers with a
 * compound, sparse document when it declares them, and with a 400 for
 * either parameter when it doesn't.
 */
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import * as Handlers from "./Handlers.js";
import * as Middleware from "./Middleware.js";
import * as Relationship from "./Relationship.js";
import { make as Resource } from "./Resource.js";
import { platformLayer } from "./Registry.js";
import { MEDIA_TYPE } from "./internal/media.js";

const Person = Resource("people", { attributes: { name: Schema.String, email: Schema.String } });
const Article = Resource("articles", {
  attributes: { title: Schema.String },
  relationships: { author: Relationship.one(() => Person) },
});
const Note = Resource("notes", { attributes: { body: Schema.String } });

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fromJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

const Api = HttpApi.make("blog")
  .add(
    Group.make(
      Article,
      Endpoint.create(Article, { include: true, fields: true }),
      Endpoint.update(Article, { include: true }),
    ),
  )
  .add(Group.make(Note, Endpoint.create(Note)));

const author = Person.make({
  id: Person.Id.make("9"),
  attributes: { name: "Ada", email: "ada@example.com" },
});
const article = (title: string) =>
  Article.make({
    id: Article.Id.make("1"),
    attributes: { title },
    relationships: { author: { data: Person.ref("9") } },
  });

const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
  handlers
    .handle("create", ({ payload, query }) =>
      Effect.succeed(
        Handlers.data(article(payload.data.attributes.title), {
          included: query.include === undefined ? [] : [author],
          onResource: Handlers.project(query.fields),
        }),
      ),
    )
    .handle("update", ({ query }) =>
      Effect.succeed(
        Handlers.data(article("updated"), {
          included: query.include === undefined ? [] : [author],
        }),
      ),
    ),
);
const NotesLive = HttpApiBuilder.group(Api, "notes", (handlers) =>
  handlers.handle("create", ({ payload }) =>
    Effect.succeed({
      data: Note.make({ id: Note.Id.make("1"), attributes: payload.data.attributes }),
    }),
  ),
);

const request = async (url: string, method: string, body: Schema.Json) => {
  const appLayer = HttpApiBuilder.layer(Api).pipe(
    Layer.provide([ArticlesLive, NotesLive]),
    Layer.provide(Middleware.layer),
    Layer.provide(platformLayer),
  );
  const { dispose, handler } = HttpRouter.toWebHandler(appLayer);
  onTestFinished(() => dispose());
  const response = await handler(
    new Request(url, {
      method,
      headers: { "content-type": MEDIA_TYPE, accept: MEDIA_TYPE },
      body: toJson(body),
    }),
  );
  return { status: response.status, body: fromJson(await response.text()) };
};

const newArticle = {
  data: {
    type: "articles",
    attributes: { title: "New" },
    relationships: { author: { data: { type: "people", id: "9" } } },
  },
};

describe("include and fields on create", () => {
  it("answers with the created resource and its included author", async () => {
    const response = await request("http://localhost/articles?include=author", "POST", newArticle);
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      data: { type: "articles", id: "1" },
      included: [{ type: "people", id: "9", attributes: { name: "Ada" } }],
    });
  });

  it("applies a sparse fieldset to the included resource", async () => {
    const response = await request(
      "http://localhost/articles?include=author&fields[people]=name",
      "POST",
      newArticle,
    );
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      included: [{ type: "people", id: "9", attributes: { name: "Ada" } }],
    });
    expect(response.body).not.toMatchObject({
      included: [{ attributes: { email: "ada@example.com" } }],
    });
  });

  it("rejects an include path the resource doesn't have", async () => {
    const response = await request("http://localhost/articles?include=editor", "POST", newArticle);
    expect(response.status).toBe(400);
  });

  it("still answers include with 400 on a create that doesn't declare it", async () => {
    const response = await request("http://localhost/notes?include=author", "POST", {
      data: { type: "notes", attributes: { body: "b" } },
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ errors: [{ source: { parameter: "include" } }] });
  });
});

describe("include on update", () => {
  it("answers with the updated resource and its included author", async () => {
    const response = await request("http://localhost/articles/1?include=author", "PATCH", {
      data: { type: "articles", id: "1", attributes: { title: "updated" } },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ included: [{ type: "people", id: "9" }] });
  });
});

describe("Endpoint.resource's per-write include", () => {
  it("declares the query on the configured write alone", () => {
    const endpoints = Endpoint.resource(Article, { endpoints: { create: { include: true } } });
    const queryOf = (identifier: string) =>
      endpoints.find((endpoint) => endpoint.identifier === identifier)?.query;
    expect(queryOf("create")).toBeDefined();
    expect(queryOf("update")).toBeUndefined();
  });
});
