/**
 * #428: a create or update whose resource object names a `type` the endpoint
 * does not serve answers JSON:API's 409 Conflict, naming `/data/type`, rather
 * than the generic 400 its payload decode failure would otherwise be.
 *
 * - §Creating Resources → 409 Conflict: "A server MUST return 409 Conflict
 *   when processing a POST request in which the resource object's type is not
 *   among the type(s) that constitute the collection represented by the
 *   endpoint."
 * - §Updating Resources → 409 Conflict: "A server MUST return 409 Conflict
 *   when processing a PATCH request in which the resource object's type or id
 *   do not match the server's endpoint."
 *
 * A malformed document — a `type` missing or not a string, a body that is not
 * JSON, a bad attribute beside the right `type` — stays a 400.
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
import * as Idempotency from "./Idempotency.js";
import { MEDIA_TYPE } from "./internal/media.js";
import * as Middleware from "./Middleware.js";
import { platformLayer } from "./Registry.js";
import * as Relationship from "./Relationship.js";
import * as Resource from "./Resource.js";

const Person = Resource.make("people", { attributes: { name: Schema.String } });

const Article = Resource.make("articles", {
  attributes: { title: Schema.NonEmptyString },
  relationships: { author: Relationship.optional(() => Person) },
});

const article = Article.make({ id: Article.Id.make("1"), attributes: { title: "Hello" } });

const Api = HttpApi.make("conflict")
  .add(
    Group.make(
      Article,
      Endpoint.create(Article),
      Endpoint.update(Article),
      Endpoint.updateRelationship(Article, "author"),
    ),
  )
  .add(
    Group.make(
      Person,
      Endpoint.create(Person, { idempotency: true }),
      // A flat command input: no resource object, so no `data.type` to conflict.
      Endpoint.update(Person, { payload: Person.updateInput }),
    ),
  );

const Live = Layer.mergeAll(
  HttpApiBuilder.group(Api, "articles", (handlers) =>
    handlers
      .handle("create", () => Effect.succeed(Handlers.data(article)))
      .handle("update", () => Effect.succeed(Handlers.data(article)))
      .handle("updateAuthorRelationship", () => Effect.succeed({ data: null })),
  ),
  HttpApiBuilder.group(Api, "people", (handlers) =>
    handlers
      .handle("create", () =>
        Effect.succeed(
          Handlers.data(Person.make({ id: Person.Id.make("9"), attributes: { name: "Ann" } })),
        ),
      )
      .handle("update", () =>
        Effect.succeed(
          Handlers.data(Person.make({ id: Person.Id.make("9"), attributes: { name: "Ann" } })),
        ),
      ),
  ),
);

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Any));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Any));

// A JSON request body: a document, or a flat command input.
type RequestBody = Readonly<Record<string, unknown>>;

const send = async (
  method: "POST" | "PATCH",
  path: string,
  body: RequestBody,
  headers: Record<string, string> = {},
) => {
  const appLayer = HttpApiBuilder.layer(Api).pipe(
    Layer.provide(Live),
    Layer.provide(Middleware.layer),
    Layer.provide(Idempotency.layer(Idempotency.memoryStore())),
    Layer.provide(platformLayer),
  );
  const { dispose, handler } = HttpRouter.toWebHandler(appLayer);
  const response = await handler(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "content-type": MEDIA_TYPE, ...headers },
      body: encodeJson(body),
    }),
  ).finally(dispose);
  const text = await response.text();
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: text === "" ? undefined : decodeJson(text),
  };
};

const conflict = (type: string, served: string) => ({
  errors: [
    {
      status: "409",
      code: "conflict",
      title: "Conflict",
      detail: `Resource object type "${type}" is not served by this endpoint (expected "${served}")`,
      source: { pointer: "/data/type" },
    },
  ],
});

describe("a resource object of another type (#428)", () => {
  it("POST /<type> answers 409 naming /data/type", async () => {
    const response = await send("POST", "/articles", {
      data: { type: "people", attributes: { title: "Hello" } },
    });
    expect(response.status).toBe(409);
    expect(response.contentType).toBe(MEDIA_TYPE);
    expect(response.body).toEqual(conflict("people", "articles"));
  });

  it("answers 409 even when the rest of the resource object is malformed too", async () => {
    const response = await send("POST", "/articles", {
      data: { type: "nope", attributes: { title: 1 } },
    });
    expect(response.status).toBe(409);
    expect(response.body).toEqual(conflict("nope", "articles"));
  });

  it("PATCH /<type>/:id answers 409 naming /data/type", async () => {
    const response = await send("PATCH", "/articles/1", {
      data: { type: "people", id: "1", attributes: { title: "Hello" } },
    });
    expect(response.status).toBe(409);
    expect(response.body).toEqual(conflict("people", "articles"));
  });

  it("answers 409 through Idempotency.Middleware, which reads the body first", async () => {
    const response = await send(
      "POST",
      "/people",
      { data: { type: "articles", attributes: { name: "Ann" } } },
      { "idempotency-key": "k-1" },
    );
    expect(response.status).toBe(409);
    expect(response.body).toEqual(conflict("articles", "people"));
  });

  it("still creates and updates a resource object of the endpoint's own type", async () => {
    const created = await send("POST", "/articles", {
      data: { type: "articles", attributes: { title: "Hello" } },
    });
    expect(created.status).toBe(201);
    const updated = await send("PATCH", "/articles/1", {
      data: { type: "articles", id: "1", attributes: { title: "Hello" } },
    });
    expect(updated.status).toBe(200);
  });
});

describe("a malformed resource object stays a 400 (#428)", () => {
  const badRequest = (pointer: string) =>
    expect.objectContaining({
      errors: [expect.objectContaining({ status: "400", source: { pointer } })],
    });

  it.each([
    ["a type that is not a string", { data: { type: 1, attributes: { title: "Hello" } } }],
    ["a null type", { data: { type: null, attributes: { title: "Hello" } } }],
    ["no type", { data: { attributes: { title: "Hello" } } }],
  ])("%s", async (_, body) => {
    const response = await send("POST", "/articles", body);
    expect(response.status).toBe(400);
    expect(response.body).toEqual(badRequest("/data/type"));
  });

  it("a bad attribute beside the endpoint's own type", async () => {
    const response = await send("POST", "/articles", {
      data: { type: "articles", attributes: { title: "" } },
    });
    expect(response.status).toBe(400);
    expect(response.body).toEqual(badRequest("/data/attributes/title"));
  });

  it("a body that is not a document", async () => {
    const response = await send("POST", "/articles", { data: [] });
    expect(response.status).toBe(400);
  });

  it("a relationship endpoint's linkage of another type", async () => {
    // §Updating Relationships sets no 409 for linkage: the 400 stands.
    const response = await send("PATCH", "/articles/1/relationships/author", {
      data: { type: "articles", id: "1" },
    });
    expect(response.status).toBe(400);
    expect(response.body).toEqual(badRequest("/data"));
  });

  it("a flat command-input payload, which has no resource object", async () => {
    const response = await send("PATCH", "/people/9", { id: "9", name: 1 });
    expect(response.status).toBe(400);
  });
});
