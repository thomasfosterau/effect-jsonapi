/**
 * The response options of the relationship writes and `operations`, and a
 * `success` list of several responses on the resource writes: each of the
 * spec's alternative answers can be declared and served.
 */
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder, HttpApiSchema } from "effect/http-api";
import * as Atomic from "./Atomic.js";
import * as Document from "./Document.js";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import * as Idempotency from "./Idempotency.js";
import { asJsonApi } from "./MediaType.js";
import * as Middleware from "./Middleware.js";
import * as Relationship from "./Relationship.js";
import { make as Resource } from "./Resource.js";
import { platformLayer } from "./Registry.js";
import { ATOMIC_MEDIA_TYPE, MEDIA_TYPE } from "./internal/media.js";

const Person = Resource("people", { attributes: { name: Schema.String } });
const Tag = Resource("tags", { attributes: { name: Schema.String } });
const Article = Resource("articles", {
  attributes: { title: Schema.String },
  relationships: {
    author: Relationship.optional(() => Person),
    tags: Relationship.many(() => Tag),
  },
});

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fromJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

const Api = HttpApi.make("blog")
  .add(
    Group.make(
      Article,
      Endpoint.create(Article, {
        success: [asJsonApi(Article.document(), 201), HttpApiSchema.NoContent],
      }),
      Endpoint.update(Article, {
        success: [asJsonApi(Article.document(), 200), HttpApiSchema.NoContent],
      }),
      Endpoint.updateRelationship(Article, "author", {
        success: HttpApiSchema.NoContent,
        idempotency: true,
      }),
      Endpoint.addRelationship(Article, "tags", {
        success: Document.MetaDocument(Schema.Struct({ count: Schema.Int })),
      }),
      Endpoint.removeRelationship(Article, "tags", {
        success: Document.MetaDocument(Schema.Struct({ job: Schema.String })),
        status: 202,
      }),
    ),
  )
  .add(
    Group.make("operations", Endpoint.operations([Article], { success: HttpApiSchema.NoContent })),
  );

const article = Article.make({
  id: Article.Id.make("1"),
  attributes: { title: "Hello" },
  relationships: { author: { data: null }, tags: { data: [] } },
});

const request = async (url: string, init: RequestInit = {}) => {
  let authorWrites = 0;
  const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
    handlers
      // An unchanged client-supplied title stands in for "nothing to return".
      .handle("create", ({ payload }) =>
        Effect.succeed(
          payload.data.attributes.title === "unchanged" ? undefined : { data: article },
        ),
      )
      .handle("update", ({ payload }) =>
        Effect.succeed(
          payload.data.attributes?.title === undefined ? undefined : { data: article },
        ),
      )
      .handle("updateAuthorRelationship", () =>
        Effect.sync(() => {
          authorWrites += 1;
        }),
      )
      .handle("addTagsRelationship", ({ payload }) =>
        Effect.succeed({ meta: { count: payload.data.length } }),
      )
      .handle("removeTagsRelationship", () => Effect.succeed({ meta: { job: "queued" } })),
  );
  const OperationsLive = HttpApiBuilder.group(Api, "operations", (handlers) =>
    handlers.handle("operations", () => Effect.void),
  );
  const appLayer = HttpApiBuilder.layer(Api).pipe(
    Layer.provide([ArticlesLive, OperationsLive]),
    Layer.provide(Middleware.layerWith({ extensions: [Atomic.EXTENSION_URI] })),
    Layer.provide(Idempotency.layer(Idempotency.memoryStore())),
    Layer.provide(platformLayer),
  );
  const { dispose, handler } = HttpRouter.toWebHandler(appLayer);
  onTestFinished(() => dispose());
  const send = async (init2: RequestInit) => {
    const response = await handler(new Request(url, init2));
    const text = await response.text();
    return { status: response.status, body: text === "" ? undefined : fromJson(text) };
  };
  const first = await send(init);
  return { ...first, again: () => send(init), authorWrites: () => authorWrites };
};

const write = (method: string, body: Schema.Json) => ({
  method,
  headers: { "content-type": MEDIA_TYPE, accept: MEDIA_TYPE },
  body: toJson(body),
});

const tags = {
  data: [
    { type: "tags", id: "1" },
    { type: "tags", id: "2" },
  ],
};

describe("a success list on the resource writes", () => {
  it("lets a create answer 201 with the document or 204", async () => {
    const create = (title: string) =>
      request(
        "http://localhost/articles",
        write("POST", { data: { type: "articles", attributes: { title } } }),
      );
    const created = await create("New");
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ data: { id: "1" } });
    expect(await create("unchanged")).toMatchObject({ status: 204, body: undefined });
  });

  it("lets an update answer 200 with the document or 204", async () => {
    const update = (attributes: { readonly title?: string }) =>
      request(
        "http://localhost/articles/1",
        write("PATCH", { data: { type: "articles", id: "1", attributes } }),
      );
    expect((await update({ title: "x" })).status).toBe(200);
    expect(await update({})).toMatchObject({ status: 204, body: undefined });
  });
});

describe("the relationship writes' success and status", () => {
  it("answers a PATCH with 204", async () => {
    const response = await request(
      "http://localhost/articles/1/relationships/author",
      write("PATCH", { data: null }),
    );
    expect(response).toMatchObject({ status: 204, body: undefined });
  });

  it("answers a POST with a meta-only document, never the linkage", async () => {
    const response = await request(
      "http://localhost/articles/1/relationships/tags",
      write("POST", tags),
    );
    expect(response).toMatchObject({ status: 200, body: { meta: { count: 2 } } });
  });

  it("answers a DELETE with 202 and a body", async () => {
    const response = await request(
      "http://localhost/articles/1/relationships/tags",
      write("DELETE", tags),
    );
    expect(response).toMatchObject({ status: 202, body: { meta: { job: "queued" } } });
  });
});

describe("idempotency on a relationship write", () => {
  it("replays the recorded response without running the handler again", async () => {
    const init = write("PATCH", { data: null });
    const response = await request("http://localhost/articles/1/relationships/author", {
      ...init,
      headers: { ...init.headers, "idempotency-key": "k1" },
    });
    expect(response.status).toBe(204);
    expect((await response.again()).status).toBe(204);
    expect(response.authorWrites()).toBe(1);
  });
});

describe("operations' success", () => {
  it("answers 204 with no document", async () => {
    const response = await request("http://localhost/operations", {
      method: "POST",
      headers: { "content-type": ATOMIC_MEDIA_TYPE, accept: ATOMIC_MEDIA_TYPE },
      body: toJson({ "atomic:operations": [{ op: "remove", ref: { type: "articles", id: "1" } }] }),
    });
    expect(response).toMatchObject({ status: 204, body: undefined });
  });
});
