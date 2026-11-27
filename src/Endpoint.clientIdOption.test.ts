/**
 * `Endpoint.create(R, { clientId })`: the declarative opt-in for
 * client-generated ids (JSON:API 1.1 §Client-Generated IDs), over
 * `Resource.clientIdPayload`, with `ApiError.DuplicateId` for a taken id.
 */
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import * as ApiError from "./ApiError.js";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import * as Handlers from "./Handlers.js";
import { MEDIA_TYPE } from "./internal/media.js";
import * as Middleware from "./Middleware.js";
import { platformLayer } from "./Registry.js";
import * as Resource from "./Resource.js";

const Note = Resource.make("notes", { attributes: { text: Schema.String } });
const Memo = Resource.make("memos", { attributes: { text: Schema.String } });

const Api = HttpApi.make("client-id-option")
  .add(
    Group.make(
      Note,
      Endpoint.create(Note, { clientId: "optional", errors: [ApiError.DuplicateId] }),
    ),
  )
  .add(Group.make(Memo, Endpoint.create(Memo, { clientId: "required" })));

const Live = Layer.mergeAll(
  HttpApiBuilder.group(Api, "notes", (handlers) =>
    handlers.handle("create", ({ payload }) => {
      const id = payload.data.id ?? Note.Id.make("server-1");
      return id === "taken"
        ? Effect.fail(new ApiError.DuplicateId({ id }))
        : Effect.succeed(Handlers.data(Note.make({ id, attributes: payload.data.attributes })));
    }),
  ),
  HttpApiBuilder.group(Api, "memos", (handlers) =>
    handlers.handle("create", ({ payload }) =>
      Effect.succeed(
        Handlers.data(Memo.make({ id: payload.data.id, attributes: payload.data.attributes })),
      ),
    ),
  ),
);

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Any));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Any));

// A create request's resource object, `id` included whatever its value.
interface CreateData {
  readonly type: string;
  readonly id?: string;
  readonly attributes: { readonly text: string; readonly extra?: number };
}

const post = async (path: string, data: CreateData) => {
  const appLayer = HttpApiBuilder.layer(Api).pipe(
    Layer.provide(Live),
    Layer.provide(Middleware.layer),
    Layer.provide(platformLayer),
  );
  const { dispose, handler } = HttpRouter.toWebHandler(appLayer);
  const response = await handler(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": MEDIA_TYPE },
      body: encodeJson({ data }),
    }),
  ).finally(dispose);
  return { status: response.status, body: decodeJson(await response.text()) };
};

describe("Endpoint.create clientId: optional", () => {
  it("creates under the client's id", async () => {
    const response = await post("/notes", { type: "notes", id: "n1", attributes: { text: "x" } });
    expect(response.status).toBe(201);
    expect(response.body.data.id).toBe("n1");
  });

  it("lets the server assign one when absent", async () => {
    const response = await post("/notes", { type: "notes", attributes: { text: "x" } });
    expect(response.status).toBe(201);
    expect(response.body.data.id).toBe("server-1");
  });

  it("still rejects an undeclared attribute", async () => {
    const response = await post("/notes", {
      type: "notes",
      id: "n1",
      attributes: { text: "x", extra: 1 },
    });
    expect(response.status).toBe(400);
    expect(response.body.errors[0].source).toEqual({ pointer: "/data/attributes/extra" });
  });

  it("answers a taken id with the 409 naming /data/id", async () => {
    const response = await post("/notes", {
      type: "notes",
      id: "taken",
      attributes: { text: "x" },
    });
    expect(response.status).toBe(409);
    expect(response.body.errors[0]).toMatchObject({
      code: "duplicate_id",
      source: { pointer: "/data/id" },
    });
  });
});

describe("Endpoint.create clientId: required", () => {
  it("requires the id", async () => {
    expect((await post("/memos", { type: "memos", attributes: { text: "x" } })).status).toBe(400);
    expect(
      (await post("/memos", { type: "memos", id: "m1", attributes: { text: "x" } })).status,
    ).toBe(201);
  });
});

describe("Resource.clientIdPayload", () => {
  it("decodes the id with the schema given", () => {
    const payload = Resource.clientIdPayload(Note, {
      id: Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/)),
    });
    expect(() =>
      Schema.decodeSync(payload)({
        data: { type: "notes", id: "not-a-uuid", attributes: { text: "x" } },
      }),
    ).toThrow();
  });
});
