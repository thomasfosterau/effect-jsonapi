/**
 * #450: a create under a client-generated id, through a payload that does not
 * support one, answers JSON:API's 403 Forbidden naming `/data/id`, and the
 * handler never runs — rather than the id being dropped and the resource
 * created under one of the server's own.
 *
 * §Client-Generated IDs: "A server MUST return 403 Forbidden in response to an
 * unsupported request to create a resource with a client-generated ID."
 *
 * A payload of the endpoint's own that declares `data.id` supports client ids:
 * the id reaches the handler.
 */
import { beforeEach, describe, expect, it } from "vite-plus/test";
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
import * as Resource from "./Resource.js";

const Article = Resource.make("articles", { attributes: { title: Schema.NonEmptyString } });

const Note = Resource.make("notes", { attributes: { text: Schema.String } });

// A create payload that supports client-generated ids: `createPayload`'s
// resource object with an `id` of its own.
const CreateNoteWithId = Schema.Struct({
  data: Schema.Struct({
    ...Note.createPayload.fields.data.fields,
    id: Schema.optionalKey(Schema.String),
  }),
});

const Api = HttpApi.make("client-id")
  .add(Group.make(Article, Endpoint.create(Article, { idempotency: true })))
  .add(Group.make(Note, Endpoint.create(Note, { payload: CreateNoteWithId })));

// Every create a handler ran, by the id it created under.
let created: Array<string> = [];

const Live = Layer.mergeAll(
  HttpApiBuilder.group(Api, "articles", (handlers) =>
    handlers.handle("create", ({ payload }) =>
      Effect.sync(() => {
        created.push("1");
        return Handlers.data(
          Article.make({ id: Article.Id.make("1"), attributes: payload.data.attributes }),
        );
      }),
    ),
  ),
  HttpApiBuilder.group(Api, "notes", (handlers) =>
    handlers.handle("create", ({ payload }) =>
      Effect.sync(() => {
        const id = payload.data.id ?? "server-1";
        created.push(id);
        return Handlers.data(
          Note.make({ id: Note.Id.make(id), attributes: payload.data.attributes }),
        );
      }),
    ),
  ),
);

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Any));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Any));

// A create request body, `data.id` included whatever its value.
interface CreateBody {
  readonly data: {
    readonly type: string;
    readonly id?: string | number;
    readonly lid?: string;
    readonly attributes: { readonly title?: string; readonly text?: string };
  };
}

const post = async (path: string, body: CreateBody, headers: Record<string, string> = {}) => {
  const appLayer = HttpApiBuilder.layer(Api).pipe(
    Layer.provide(Live),
    Layer.provide(Middleware.layer),
    Layer.provide(Idempotency.layer(Idempotency.memoryStore())),
    Layer.provide(platformLayer),
  );
  const { dispose, handler } = HttpRouter.toWebHandler(appLayer);
  const response = await handler(
    new Request(`http://localhost${path}`, {
      method: "POST",
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

const forbidden = {
  errors: [
    {
      status: "403",
      code: "forbidden",
      title: "Forbidden",
      detail: "Client-generated ids are not supported by this endpoint",
      source: { pointer: "/data/id" },
    },
  ],
};

beforeEach(() => {
  created = [];
});

describe("a client-generated id on a create that does not support one (#450)", () => {
  it("answers 403 naming /data/id, and creates nothing", async () => {
    const response = await post("/articles", {
      data: { type: "articles", id: "client-1", attributes: { title: "Hello" } },
    });
    expect(response.status).toBe(403);
    expect(response.contentType).toBe(MEDIA_TYPE);
    expect(response.body).toEqual(forbidden);
    expect(created).toEqual([]);
  });

  it.each([
    ["an empty id", ""],
    ["an id that is not a string", 1],
  ])("answers 403 for %s too", async (_, id) => {
    const response = await post("/articles", {
      data: { type: "articles", id, attributes: { title: "Hello" } },
    });
    expect(response.status).toBe(403);
    expect(response.body).toEqual(forbidden);
    expect(created).toEqual([]);
  });

  it("answers 403 beside a `lid`", async () => {
    const response = await post("/articles", {
      data: { type: "articles", id: "client-1", lid: "a", attributes: { title: "Hello" } },
    });
    expect(response.status).toBe(403);
    expect(response.body).toEqual(forbidden);
  });

  it("answers 403 through Idempotency.Middleware, which reads the body first", async () => {
    const response = await post(
      "/articles",
      { data: { type: "articles", id: "client-1", attributes: { title: "Hello" } } },
      { "idempotency-key": "k-1" },
    );
    expect(response.status).toBe(403);
    expect(response.body).toEqual(forbidden);
    expect(created).toEqual([]);
  });

  it("answers a resource object of another type with the 409, not the 403", async () => {
    const response = await post("/articles", {
      data: { type: "notes", id: "client-1", attributes: { title: "Hello" } },
    });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      errors: [expect.objectContaining({ status: "409", source: { pointer: "/data/type" } })],
    });
  });

  it("answers an otherwise malformed resource object with the 400 at the member that fails", async () => {
    const response = await post("/articles", {
      data: { type: "articles", id: "client-1", attributes: { title: "" } },
    });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      errors: [
        expect.objectContaining({ status: "400", source: { pointer: "/data/attributes/title" } }),
      ],
    });
    expect(created).toEqual([]);
  });

  it("still creates without one", async () => {
    const response = await post("/articles", {
      data: { type: "articles", attributes: { title: "Hello" } },
    });
    expect(response.status).toBe(201);
    expect(created).toEqual(["1"]);
  });
});

describe("a create payload that declares `data.id` supports client-generated ids", () => {
  it("hands the id to the handler, which creates under it", async () => {
    const response = await post("/notes", {
      data: { type: "notes", id: "client-1", attributes: { text: "Hi" } },
    });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ data: { type: "notes", id: "client-1" } });
    expect(created).toEqual(["client-1"]);
  });

  it("still creates without one", async () => {
    const response = await post("/notes", { data: { type: "notes", attributes: { text: "Hi" } } });
    expect(response.status).toBe(201);
    expect(created).toEqual(["server-1"]);
  });
});
