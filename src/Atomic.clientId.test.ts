/**
 * #464: an atomic `add` operation carrying a client-generated id, through a
 * request document that does not support one, answers JSON:API's 403
 * Forbidden naming `/atomic:operations/N/data/id`, and the handler never runs
 * — no operation is performed — rather than the id being dropped and the
 * resource created under one of the server's own.
 *
 * The extension answers a failed operation "as described in the base
 * specification" (§Processing Errors), whose §Client-Generated IDs says: "A
 * server MUST return 403 Forbidden in response to an unsupported request to
 * create a resource with a client-generated ID." It is #450's refusal of a
 * `data.id` on `Endpoint.create`, applied to the operation.
 *
 * A request document of the endpoint's own whose `add` declares `data.id`
 * supports client ids: the id reaches the handler.
 */
import { beforeEach, describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import * as Atomic from "./Atomic.js";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import * as Idempotency from "./Idempotency.js";
import { MEDIA_TYPE } from "./internal/media.js";
import * as Middleware from "./Middleware.js";
import { platformLayer } from "./Registry.js";
import * as Resource from "./Resource.js";

const Article = Resource.make("articles", { attributes: { title: Schema.NonEmptyString } });

const Note = Resource.make("notes", { attributes: { text: Schema.String } });

// A request document whose `add` supports client-generated ids: the default
// `add`'s fields, with a `data` that declares an `id`, ahead of the default
// operations so an `add` carrying one decodes through it.
const AddNote = Atomic.AddOperation(Note);
const AddNoteWithId = Schema.Struct({
  ...AddNote.fields,
  data: Schema.Struct({ ...AddNote.fields.data.fields, id: Schema.optionalKey(Schema.String) }),
});
const NotesWithClientIds = Schema.Struct({
  "atomic:operations": Schema.Array(
    Schema.Union([AddNoteWithId, ...Atomic.Operations([Note]).members]),
  ).check(Schema.isMinLength(1)),
});

const Api = HttpApi.make("atomic-client-id")
  .add(Group.make("operations", Endpoint.operations([Article], { idempotency: true })))
  .add(
    Group.make(
      "notes",
      Endpoint.operations([Note], { path: "/notes/operations", payload: NotesWithClientIds }),
    ),
  );

// Every request a handler ran, by the ids of the resources it created.
let created: Array<ReadonlyArray<string>> = [];

const Live = Layer.mergeAll(
  HttpApiBuilder.group(Api, "operations", (handlers) =>
    handlers.handle("operations", ({ payload }) =>
      Effect.sync(() => {
        const ids = payload["atomic:operations"].map((_, index) => String(index + 1));
        created.push(ids);
        return {
          "atomic:results": ids.map((id) => ({
            data: Article.make({ id: Article.Id.make(id), attributes: { title: "Hello" } }),
          })),
        };
      }),
    ),
  ),
  HttpApiBuilder.group(Api, "notes", (handlers) =>
    handlers.handle("operations", ({ payload }) =>
      Effect.sync(() => {
        const ids = payload["atomic:operations"].map((operation, index) =>
          operation.op === "add" && "id" in operation.data && operation.data.id !== undefined
            ? operation.data.id
            : `server-${index + 1}`,
        );
        created.push(ids);
        return {
          "atomic:results": ids.map((id) => ({
            data: Note.make({ id: Note.Id.make(id), attributes: { text: "Hi" } }),
          })),
        };
      }),
    ),
  ),
);

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Any));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Any));

// An atomic request body, any operation's `data.id` included whatever its
// value.
interface OperationsBody {
  readonly "atomic:operations": ReadonlyArray<{
    readonly op: string;
    readonly ref?: { readonly type: string; readonly id?: string; readonly lid?: string };
    readonly data?: {
      readonly type: string;
      readonly id?: string | number;
      readonly lid?: string;
      readonly attributes?: { readonly title?: string; readonly text?: string };
    };
  }>;
}

const post = async (path: string, body: OperationsBody, headers: Record<string, string> = {}) => {
  const appLayer = HttpApiBuilder.layer(Api).pipe(
    Layer.provide(Live),
    Layer.provide(Middleware.layerWith({ extensions: [Atomic.EXTENSION_URI] })),
    Layer.provide(Idempotency.layer(Idempotency.memoryStore())),
    Layer.provide(platformLayer),
  );
  const { dispose, handler } = HttpRouter.toWebHandler(appLayer);
  const response = await handler(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": Atomic.MEDIA_TYPE,
        accept: Atomic.MEDIA_TYPE,
        ...headers,
      },
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

const refusal = (index: number) => ({
  status: "403",
  code: "forbidden",
  title: "Forbidden",
  detail: "Client-generated ids are not supported by this endpoint",
  source: { pointer: `/atomic:operations/${index}/data/id` },
});

const addArticle = (data: { readonly id?: string | number; readonly lid?: string } = {}) => ({
  op: "add",
  data: { type: "articles", ...data, attributes: { title: "Hello" } },
});

beforeEach(() => {
  created = [];
});

describe("a client-generated id on an atomic add that does not support one (#464)", () => {
  it("answers 403 naming /atomic:operations/N/data/id, and performs no operation", async () => {
    const response = await post("/operations", {
      "atomic:operations": [addArticle(), addArticle({ id: "client-1" })],
    });
    expect(response.status).toBe(403);
    expect(response.contentType).toBe(MEDIA_TYPE);
    expect(response.body).toEqual({ errors: [refusal(1)] });
    expect(created).toEqual([]);
  });

  it("answers for the first operation that fails, as operations are processed in order", async () => {
    const response = await post("/operations", {
      "atomic:operations": [
        { op: "remove", ref: { type: "articles", id: "9" } },
        addArticle({ id: "client-1" }),
        addArticle({ id: "client-2" }),
      ],
    });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ errors: [refusal(1)] });
    expect(created).toEqual([]);
  });

  it.each([
    ["an empty id", ""],
    ["an id that is not a string", 1],
  ])("answers 403 for %s too", async (_, id) => {
    const response = await post("/operations", { "atomic:operations": [addArticle({ id })] });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ errors: [refusal(0)] });
    expect(created).toEqual([]);
  });

  it("answers 403 beside a `lid`", async () => {
    const response = await post("/operations", {
      "atomic:operations": [addArticle({ id: "client-1", lid: "a1" })],
    });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ errors: [refusal(0)] });
  });

  it("answers 403 through Idempotency.Middleware, which reads the body first", async () => {
    const response = await post(
      "/operations",
      { "atomic:operations": [addArticle({ id: "client-1" })] },
      { "idempotency-key": "k-1" },
    );
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ errors: [refusal(0)] });
    expect(created).toEqual([]);
  });

  it("answers an earlier malformed operation with its 400, and a later one after the 403", async () => {
    const malformed = { op: "add", data: { type: "articles", attributes: { title: "" } } };
    const first = await post("/operations", {
      "atomic:operations": [malformed, addArticle({ id: "client-1" })],
    });
    expect(first.status).toBe(400);
    expect(first.body).toEqual({
      errors: [
        expect.objectContaining({
          status: "400",
          source: { pointer: "/atomic:operations/0/data/attributes/title" },
        }),
      ],
    });
    const second = await post("/operations", {
      "atomic:operations": [addArticle({ id: "client-1" }), malformed],
    });
    expect(second.status).toBe(403);
    expect(second.body).toEqual({ errors: [refusal(0)] });
    expect(created).toEqual([]);
  });

  it("answers an otherwise malformed add with the 400 at the member that fails", async () => {
    const response = await post("/operations", {
      "atomic:operations": [
        { op: "add", data: { type: "articles", id: "client-1", attributes: { title: "" } } },
      ],
    });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      errors: [
        expect.objectContaining({
          status: "400",
          source: { pointer: "/atomic:operations/0/data/attributes/title" },
        }),
      ],
    });
    expect(created).toEqual([]);
  });

  it("leaves an update's `data.id`, which names its target, alone", async () => {
    const response = await post("/operations", {
      "atomic:operations": [
        { op: "update", data: { type: "articles", id: "9", attributes: { title: "Hi" } } },
      ],
    });
    expect(response.status).toBe(200);
    expect(created).toEqual([["1"]]);
  });

  it("still performs an add without one", async () => {
    const response = await post("/operations", {
      "atomic:operations": [addArticle({ lid: "a1" })],
    });
    expect(response.status).toBe(200);
    expect(created).toEqual([["1"]]);
  });

  it("refuses an `add` value carrying an id when encoding, as a client writing one", () => {
    const encode = Schema.encodeUnknownExit(Atomic.RequestDocument([Article]));
    expect(encode({ "atomic:operations": [addArticle({ id: "client-1" })] })._tag).toBe("Failure");
    expect(encode({ "atomic:operations": [addArticle()] })._tag).toBe("Success");
  });
});

describe("a request document whose add declares `data.id` supports client-generated ids", () => {
  it("hands the id to the handler, which creates under it", async () => {
    const response = await post("/notes/operations", {
      "atomic:operations": [
        { op: "add", data: { type: "notes", id: "client-1", attributes: { text: "Hi" } } },
        { op: "add", data: { type: "notes", attributes: { text: "Hi" } } },
      ],
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      "atomic:results": [
        { data: { type: "notes", id: "client-1" } },
        { data: { type: "notes", id: "server-2" } },
      ],
    });
    expect(created).toEqual([["client-1", "server-2"]]);
  });
});
