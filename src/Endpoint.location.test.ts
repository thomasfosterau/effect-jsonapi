/**
 * The `Location` header of a 201 create (#236), observed on the wire.
 *
 * JSON:API v1.1 §Creating Resources → 201 Created: the response SHOULD carry
 * a `Location` header identifying the created resource, and when the resource
 * object carries `links.self` the two MUST match. `Endpoint.create` attaches
 * `Middleware.CreatedLocation`, which copies that link into the header.
 */
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter } from "effect/http";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import * as Idempotency from "./Idempotency.js";
import * as Middleware from "./Middleware.js";
import { make as Resource } from "./Resource.js";
import { MEDIA_TYPE } from "./internal/media.js";

const Article = Resource("articles", {
  attributes: { title: Schema.NonEmptyString, body: Schema.String },
});

const created = {
  type: "articles" as const,
  id: "1",
  attributes: { title: "Hello", body: "World" },
};

const Json = Schema.fromJsonString(Schema.Unknown);
const toJson = Schema.encodeSync(Json);
const fromJson = Schema.decodeSync(Json);

const createBody = toJson({
  data: { type: "articles", attributes: { title: "Hello", body: "World" } },
});

/** The endpoint options a test varies: the status, and whether it is idempotent. */
type CreateOptions = { readonly status?: number; readonly idempotency?: Idempotency.Option };

const createApi = (options: CreateOptions = {}) =>
  HttpApi.make("blog").add(Group.make(Article, Endpoint.create(Article, options)));

// One server per test, over the package's own middleware set, so the header is
// observed on the wire exactly as a client receives it. Disposed when the test
// finishes.
const server = (options: {
  readonly api: unknown;
  readonly handle: () => Effect.Effect<unknown>;
  readonly store?: Idempotency.Store;
}) => {
  // SAFETY: the handlers deliberately answer outside the endpoint's declared
  // success type (raw responses, malformed bodies) — this harness asserts the
  // wire, not the types — so the group is built untyped.
  const live = HttpApiBuilder.group(options.api as never, "articles", (handlers: any) =>
    handlers.handle("create", options.handle),
  );
  // SAFETY: every middleware the api's endpoints require is provided here; the
  // platform services `HttpApiBuilder.layer` lists are unused by these routes.
  const appLayer = HttpApiBuilder.layer(options.api as never).pipe(
    Layer.provide(live),
    Layer.provide(Middleware.layer),
    Layer.provide(Idempotency.layer(options.store ?? Idempotency.memoryStore())),
  ) as Layer.Layer<never, never, HttpRouter.HttpRouter>;
  const { dispose, handler } = HttpRouter.toWebHandler(appLayer);
  onTestFinished(() => dispose());
  return async (key?: string) => {
    const headers = new Headers({ accept: MEDIA_TYPE, "content-type": MEDIA_TYPE });
    if (key !== undefined) headers.set("idempotency-key", key);
    const response = await handler(
      new Request("http://localhost/articles", { method: "POST", headers, body: createBody }),
    );
    return {
      status: response.status,
      location: response.headers.get("location"),
      replayed: response.headers.get(Idempotency.REPLAY_HEADER),
      body: await response.text(),
    };
  };
};

// One POST against a create answering with `handle`'s value.
const postOnce = (handle: () => Effect.Effect<unknown>, options?: CreateOptions) =>
  server({ api: createApi(options), handle })();

describe("Endpoint.create: the 201's Location header", () => {
  it("copies the created resource's data.links.self", async () => {
    const response = await postOnce(() =>
      Effect.succeed({ data: { ...created, links: { self: "/articles/1" } } }),
    );
    expect(response.status).toBe(201);
    expect(response.location).toBe("/articles/1");
  });

  it("copies an absolute self link, and a link object's href, verbatim", async () => {
    const absolute = await postOnce(() =>
      Effect.succeed({
        data: { ...created, links: { self: new URL("https://api.example.com/articles/1") } },
      }),
    );
    expect(absolute.location).toBe("https://api.example.com/articles/1");

    const object = await postOnce(() =>
      Effect.succeed({
        data: { ...created, links: { self: { href: "/articles/1", title: "Hello" } } },
      }),
    );
    expect(object.location).toBe("/articles/1");
  });

  it("falls back to the document's top-level links.self", async () => {
    const response = await postOnce(() =>
      Effect.succeed({ data: created, links: { self: "/articles/1" } }),
    );
    expect(response.status).toBe(201);
    expect(response.location).toBe("/articles/1");
  });

  it("prefers data.links.self when both are present, so Location matches it", async () => {
    const response = await postOnce(() =>
      Effect.succeed({
        data: { ...created, links: { self: "https://api.example.com/articles/1" } },
        links: { self: "/articles/1?include=author" },
      }),
    );
    expect(response.location).toBe("https://api.example.com/articles/1");
    expect(fromJson(response.body)).toMatchObject({ data: { links: { self: response.location } } });
  });

  it("omits the header when neither self link exists", async () => {
    const response = await postOnce(() => Effect.succeed({ data: created }));
    expect(response.status).toBe(201);
    expect(response.location).toBeNull();
    expect(fromJson(response.body)).toEqual({ data: created });
  });

  it("leaves a create answering with another status untouched", async () => {
    const response = await postOnce(
      () =>
        Effect.succeed({
          data: { ...created, links: { self: "/articles/1" } },
          links: { self: "/articles/1" },
        }),
      { status: 200 },
    );
    expect(response.status).toBe(200);
    expect(response.location).toBeNull();
  });

  it("leaves a 201 whose body is not JSON unchanged rather than failing", async () => {
    const response = await postOnce(() =>
      Effect.succeed(HttpServerResponse.text("not json {", { status: 201 })),
    );
    expect(response.status).toBe(201);
    expect(response.location).toBeNull();
    expect(response.body).toBe("not json {");
  });

  it.each([
    { data: { links: { self: 42 } } },
    { data: { links: { self: { href: null } } }, links: "nope" },
    { data: null, links: { self: ["/articles/1"] } },
    [{ links: { self: "/articles/1" } }],
    "a JSON string",
    null,
  ])("leaves a 201 whose document %j names no usable self link unchanged", async (body) => {
    const response = await postOnce(() =>
      Effect.succeed(HttpServerResponse.text(toJson(body), { status: 201 })),
    );
    expect(response.status).toBe(201);
    expect(response.location).toBeNull();
  });

  // `Location` is a URI-reference: visible US-ASCII only (RFC 3986).
  it.each([
    ["a CR LF", "/articles/1\r\nset-cookie: x=1"],
    ["a space", "/articles/a b"],
    ["a tab", "/articles/a\tb"],
    ["a byte above 0x7E", "/articles/café"],
    ["a byte at 0x80", "/articles/\u0080"],
    ["a byte at 0xFF", "/articles/ÿ"],
    ["a DEL", "/articles/\u007f"],
  ])("omits a self link containing %s rather than failing", async (_, self) => {
    const response = await postOnce(() =>
      Effect.succeed({ data: { ...created, links: { self } } }),
    );
    expect(response.status).toBe(201);
    expect(response.location).toBeNull();
  });

  it("copies a self link spanning the whole visible ASCII range", async () => {
    const self = "/articles/1?q=a%20b&x=!$'()*+,;=:@-._~#frag";
    const response = await postOnce(() =>
      Effect.succeed({ data: { ...created, links: { self } } }),
    );
    expect(response.location).toBe(self);
  });

  it("leaves a 201 whose body is a stream unchanged", async () => {
    const response = await postOnce(() =>
      Effect.succeed(
        HttpServerResponse.stream(
          Stream.make(new TextEncoder().encode(toJson({ links: { self: "/a/1" } }))),
          { status: 201, contentType: MEDIA_TYPE },
        ),
      ),
    );
    expect(response.status).toBe(201);
    expect(response.location).toBeNull();
  });

  it("keeps a Location the handler set itself", async () => {
    const response = await postOnce(() =>
      Effect.succeed(
        HttpServerResponse.text(toJson({ data: { links: { self: "/articles/1" } } }), {
          status: 201,
          headers: { location: "/elsewhere/1" },
        }),
      ),
    );
    expect(response.location).toBe("/elsewhere/1");
  });

  it("is carried by Endpoint.resource's create too", async () => {
    const api = HttpApi.make("blog").add(
      Group.make(
        Article,
        ...Endpoint.resource(Article, {
          endpoints: { get: false, list: false, update: false, delete: false },
        }),
      ),
    );
    const post = server({
      api,
      handle: () => Effect.succeed({ data: { ...created, links: { self: "/articles/1" } } }),
    });
    expect((await post()).location).toBe("/articles/1");
  });
});

describe("Endpoint.create: Location under Idempotency", () => {
  it("sits inside Idempotency.Middleware, so the recorded response carries it", () => {
    const endpoint = Endpoint.create(Article, { idempotency: true });
    // HttpApiBuilder applies an endpoint's middlewares in order, each wrapping
    // the last: the first is innermost, the last outermost.
    expect([...endpoint.middlewares]).toEqual([
      Middleware.ContentNegotiation,
      Middleware.SchemaErrors,
      Middleware.CreatedLocation,
      Idempotency.Middleware,
    ]);
  });

  it("records the header with the response, and a replay returns it", async () => {
    const memory = Idempotency.memoryStore();
    const recorded: Array<Idempotency.Recorded> = [];
    const store: Idempotency.Store = {
      ...memory,
      complete: (attempt, response) =>
        Effect.andThen(
          Effect.sync(() => recorded.push(response)),
          memory.complete(attempt, response),
        ),
    };
    let calls = 0;
    const post = server({
      api: createApi({ idempotency: true }),
      store,
      handle: () =>
        Effect.sync(() => {
          calls += 1;
          return { data: { ...created, links: { self: "/articles/1" } } };
        }),
    });
    const first = await post("k1");
    const replay = await post("k1");

    expect(calls).toBe(1);
    expect(first.location).toBe("/articles/1");
    expect(recorded.map((response) => response.headers["location"])).toEqual(["/articles/1"]);
    expect(replay.status).toBe(201);
    expect(replay.replayed).toBe("true");
    expect(replay.location).toBe("/articles/1");
    expect(replay.body).toBe(first.body);
  });
});
