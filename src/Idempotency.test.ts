import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import * as ApiError from "./ApiError.js";
import * as Atomic from "./Atomic.js";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import * as Idempotency from "./Idempotency.js";
import * as Middleware from "./Middleware.js";
import { make as Resource } from "./Resource.js";
import { MEDIA_TYPE } from "./internal/media.js";
import { definedMember } from "./internal/members.js";

const Article = Resource("articles", {
  attributes: { title: Schema.NonEmptyString, body: Schema.String },
});

const sample = {
  type: "articles" as const,
  id: "1",
  attributes: { title: "Hello", body: "World" },
};

const createBody = { data: { type: "articles", attributes: { title: "Hello", body: "World" } } };

// ---------------------------------------------------------------------------
// The key
// ---------------------------------------------------------------------------

describe("Idempotency.Key", () => {
  const decode = Schema.decodeUnknownResult(Idempotency.Key);

  it("accepts a bare token and the RFC 8941 String form, decoding both to the key", () => {
    expect(decode("8e03978e-40d5")).toMatchObject({ _tag: "Success", success: "8e03978e-40d5" });
    expect(decode(`"8e03978e-40d5"`)).toMatchObject({ _tag: "Success", success: "8e03978e-40d5" });
  });

  it("unescapes the String form's escapes", () => {
    expect(decode(`"a\\"b"`)).toMatchObject({ _tag: "Success", success: `a"b` });
  });

  it("rejects an empty key, an over-long key and non-printable characters", () => {
    expect(decode("")._tag).toBe("Failure");
    expect(decode("k".repeat(256))._tag).toBe("Failure");
    expect(decode("key\nwith\nnewlines")._tag).toBe("Failure");
  });

  it("encodes back to the bare form", () => {
    expect(Schema.encodeUnknownSync(Idempotency.Key)("k1")).toBe("k1");
  });
});

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

describe("Idempotency.canonical", () => {
  it("is stable under JSON key order and whitespace", () => {
    const a = Idempotency.canonical({
      method: "POST",
      url: "/articles",
      body: `{"a":1,"b":{"d":4,"c":3}}`,
    });
    const b = Idempotency.canonical({
      method: "POST",
      url: "/articles",
      body: `{ "b": { "c": 3, "d": 4 }, "a": 1 }`,
    });
    expect(a).toBe(b);
  });

  it("is stable under query parameter order, and normalises the method", () => {
    const a = Idempotency.canonical({ method: "post", url: "/articles?b=2&a=1", body: "" });
    const b = Idempotency.canonical({ method: "POST", url: "/articles?a=1&b=2", body: "" });
    expect(a).toBe(b);
  });

  it("distinguishes method, path, query and body", () => {
    const base = { method: "POST", url: "/articles", body: `{"a":1}` };
    const of = Idempotency.canonical;
    expect(of(base)).not.toBe(of({ ...base, method: "PATCH" }));
    expect(of(base)).not.toBe(of({ ...base, url: "/comments" }));
    expect(of(base)).not.toBe(of({ ...base, url: "/articles?draft=1" }));
    expect(of(base)).not.toBe(of({ ...base, body: `{"a":2}` }));
  });

  it("keeps a non-JSON body as received", () => {
    expect(Idempotency.canonical({ method: "POST", url: "/x", body: "not json" })).toContain(
      "not json",
    );
  });
});

describe("Idempotency.fingerprint", () => {
  it("is a 64-character hex digest of the canonical string", async () => {
    const print = await Effect.runPromise(
      Idempotency.fingerprint({
        method: "POST",
        url: "/articles",
        body: JSON.stringify(createBody),
      }),
    );
    expect(print).toMatch(/^[0-9a-f]{64}$/);
  });

  it("agrees whenever the canonical strings agree", async () => {
    const a = await Effect.runPromise(
      Idempotency.fingerprint({ method: "POST", url: "/a", body: `{"x":1,"y":2}` }),
    );
    const b = await Effect.runPromise(
      Idempotency.fingerprint({ method: "POST", url: "/a", body: `{"y":2,"x":1}` }),
    );
    const c = await Effect.runPromise(
      Idempotency.fingerprint({ method: "POST", url: "/a", body: `{"y":3,"x":1}` }),
    );
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

// ---------------------------------------------------------------------------
// The store contract
// ---------------------------------------------------------------------------

const attempt = (key: string, fingerprint: string): Idempotency.Attempt => ({
  key,
  fingerprint,
  request: undefined as never,
});

describe("Idempotency.memoryStore", () => {
  it("claims a fresh key, then reports the in-progress claim", () => {
    const store = Idempotency.memoryStore();
    const first = Effect.runSync(store.claim(attempt("k", "fp")));
    const second = Effect.runSync(store.claim(attempt("k", "fp")));
    expect(first).toEqual({ _tag: "Claimed" });
    expect(second).toEqual({ _tag: "InProgress", fingerprint: "fp" });
  });

  it("reports a completed claim with the recorded response", () => {
    const store = Idempotency.memoryStore();
    const recorded = { status: 201, headers: { "content-type": MEDIA_TYPE }, body: "{}" };
    Effect.runSync(store.claim(attempt("k", "fp")));
    Effect.runSync(store.complete(attempt("k", "fp"), recorded));
    expect(Effect.runSync(store.claim(attempt("k", "fp")))).toEqual({
      _tag: "Completed",
      fingerprint: "fp",
      response: recorded,
    });
  });

  it("makes a released key claimable again", () => {
    const store = Idempotency.memoryStore();
    Effect.runSync(store.claim(attempt("k", "fp")));
    Effect.runSync(store.release(attempt("k", "fp")));
    expect(Effect.runSync(store.claim(attempt("k", "fp")))).toEqual({ _tag: "Claimed" });
  });
});

// ---------------------------------------------------------------------------
// The errors
// ---------------------------------------------------------------------------

describe("Idempotency errors", () => {
  it("KeyMismatch is a 422 error document sourced at the header", () => {
    expect(ApiError.toDocument(new Idempotency.KeyMismatch())).toEqual({
      errors: [
        {
          status: "422",
          code: "idempotency_key_mismatch",
          title: "Idempotency-Key Mismatch",
          detail: expect.stringContaining("already been used"),
          source: { header: "idempotency-key" },
        },
      ],
    });
  });

  it("KeyInProgress is a 409 error document sourced at the header", () => {
    expect(ApiError.toDocument(new Idempotency.KeyInProgress())).toEqual({
      errors: [
        {
          status: "409",
          code: "idempotency_key_in_progress",
          title: "Idempotency-Key In Progress",
          detail: expect.stringContaining("still being processed"),
          source: { header: "idempotency-key" },
        },
      ],
    });
  });

  it("advertises the profile in a jsonapi object", () => {
    expect(Idempotency.jsonapi).toEqual({ version: "1.1", profile: [Idempotency.PROFILE_URI] });
    expect(Idempotency.PROFILE_URI).toBe(
      "https://thomasfosterau.github.io/effect-jsonapi/profiles/idempotency/v1",
    );
  });
});

// ---------------------------------------------------------------------------
// The middleware, end to end
// ---------------------------------------------------------------------------

// One server per test, over a store the test owns, so replays and conflicts are
// observed on the wire — status, headers and body — rather than in a decoder.
const server = (options: {
  readonly api: unknown;
  readonly live: Layer.Layer<any, any, any>;
  readonly store: Idempotency.Store;
}) => {
  const appLayer = HttpApiBuilder.layer(options.api as never).pipe(
    Layer.provide(options.live),
    Layer.provide(Middleware.layerWith({ extensions: [Atomic.EXTENSION_URI] })),
    Layer.provide(Idempotency.layer(options.store)),
  ) as unknown as Layer.Layer<never, never, HttpRouter.HttpRouter>;
  const { dispose, handler } = HttpRouter.toWebHandler(appLayer);
  return {
    dispose,
    request: async (init: {
      readonly method?: string;
      readonly url?: string;
      readonly key?: string;
      readonly body?: unknown;
      readonly contentType?: string;
    }) => {
      const response = await handler(
        new Request(init.url ?? "http://localhost/articles", {
          method: init.method ?? "POST",
          headers: {
            "content-type": init.contentType ?? MEDIA_TYPE,
            ...definedMember("idempotency-key", init.key),
          },
          ...definedMember("body", init.body === undefined ? undefined : JSON.stringify(init.body)),
        }),
      );
      return {
        status: response.status,
        replayed: response.headers.get(Idempotency.REPLAY_HEADER),
        body: await response.text(),
      };
    },
  };
};

const articlesApi = (idempotency: Idempotency.Option) =>
  HttpApi.make("blog").add(Group.make(Article, Endpoint.create(Article, { idempotency } as never)));

const articlesLive = (
  api: HttpApi.Constraint,
  handle: () => Effect.Effect<any, any, any>,
): Layer.Layer<any, any, any> =>
  HttpApiBuilder.group(api as never, "articles", (handlers: any) =>
    handlers.handle("create", handle),
  ) as Layer.Layer<any, any, any>;

describe("Idempotency.layer", () => {
  it("replays the original response verbatim, marking it with the replay header", async () => {
    let calls = 0;
    const api = articlesApi(true);
    const live = articlesLive(api, () =>
      Effect.sync(() => {
        calls += 1;
        return { data: { ...sample, id: String(calls) } };
      }),
    );
    const { dispose, request } = server({ api, live, store: Idempotency.memoryStore() });
    onTestFinished(() => dispose());
    const first = await request({ key: "k1", body: createBody });
    const second = await request({ key: "k1", body: createBody });

    expect(calls).toBe(1);
    expect(first.status).toBe(201);
    expect(first.replayed).toBeNull();
    expect(second.status).toBe(201);
    expect(second.body).toBe(first.body);
    expect(second.replayed).toBe("true");
  });

  it("accepts the RFC 8941 String spelling of the same key as the same key", async () => {
    let calls = 0;
    const api = articlesApi(true);
    const live = articlesLive(api, () =>
      Effect.sync(() => {
        calls += 1;
        return { data: sample };
      }),
    );
    const { dispose, request } = server({ api, live, store: Idempotency.memoryStore() });
    onTestFinished(() => dispose());
    await request({ key: "k1", body: createBody });
    const replay = await request({ key: `"k1"`, body: createBody });
    expect(calls).toBe(1);
    expect(replay.replayed).toBe("true");
  });

  it("rejects the same key carrying a different body with a 422, without running the handler", async () => {
    let calls = 0;
    const api = articlesApi(true);
    const live = articlesLive(api, () =>
      Effect.sync(() => {
        calls += 1;
        return { data: sample };
      }),
    );
    const { dispose, request } = server({ api, live, store: Idempotency.memoryStore() });
    onTestFinished(() => dispose());
    await request({ key: "k1", body: createBody });
    const conflicting = await request({
      key: "k1",
      body: { data: { type: "articles", attributes: { title: "Different", body: "World" } } },
    });

    expect(calls).toBe(1);
    expect(conflicting.status).toBe(422);
    expect(JSON.parse(conflicting.body)).toEqual(
      ApiError.toDocument(new Idempotency.KeyMismatch()),
    );
  });

  it("treats the same key on a different target as a mismatch, not a fresh slot", async () => {
    const api = HttpApi.make("blog").add(
      Group.make(
        Article,
        Endpoint.create(Article, { idempotency: true }),
        Endpoint.create(Article, { name: "draft", path: "/drafts", idempotency: true }),
      ),
    );
    const live = HttpApiBuilder.group(api as never, "articles", (handlers: any) =>
      handlers
        .handle("create", () => Effect.succeed({ data: sample }))
        .handle("draft", () => Effect.succeed({ data: sample })),
    ) as Layer.Layer<any, any, any>;
    const { dispose, request } = server({ api, live, store: Idempotency.memoryStore() });
    onTestFinished(() => dispose());
    await request({ key: "k1", body: createBody });
    const elsewhere = await request({
      key: "k1",
      url: "http://localhost/drafts",
      body: createBody,
    });
    expect(elsewhere.status).toBe(422);
  });

  it("answers 409 while an attempt with the same key and body is still in flight", async () => {
    const store: Idempotency.Store = {
      ...Idempotency.memoryStore(),
      claim: (a) => Effect.succeed({ _tag: "InProgress", fingerprint: a.fingerprint }),
    };
    const api = articlesApi(true);
    const live = articlesLive(api, () => Effect.succeed({ data: sample }));
    const { dispose, request } = server({ api, live, store });
    onTestFinished(() => dispose());
    const inFlight = await request({ key: "k1", body: createBody });
    expect(inFlight.status).toBe(409);
    expect(JSON.parse(inFlight.body)).toEqual(ApiError.toDocument(new Idempotency.KeyInProgress()));
  });

  it("prefers the mismatch over the in-flight conflict", async () => {
    const store: Idempotency.Store = {
      ...Idempotency.memoryStore(),
      claim: () => Effect.succeed({ _tag: "InProgress", fingerprint: "some-other-request" }),
    };
    const api = articlesApi(true);
    const live = articlesLive(api, () => Effect.succeed({ data: sample }));
    const { dispose, request } = server({ api, live, store });
    onTestFinished(() => dispose());
    expect((await request({ key: "k1", body: createBody })).status).toBe(422);
  });

  it("records nothing for a request carrying no key", async () => {
    let calls = 0;
    const api = articlesApi(true);
    const live = articlesLive(api, () =>
      Effect.sync(() => {
        calls += 1;
        return { data: sample };
      }),
    );
    const store = Idempotency.memoryStore();
    const { dispose, request } = server({ api, live, store });
    onTestFinished(() => dispose());
    await request({ body: createBody });
    await request({ body: createBody });
    expect(calls).toBe(2);
    expect(Effect.runSync(store.claim(attempt("k1", "fp")))).toEqual({ _tag: "Claimed" });
  });

  it("releases the key when the handler fails, so the write may be attempted again", async () => {
    class TitleTaken extends ApiError.make<TitleTaken>()("TitleTaken", { status: 409 }) {}
    let calls = 0;
    const api = HttpApi.make("blog").add(
      Group.make(Article, Endpoint.create(Article, { idempotency: true, errors: [TitleTaken] })),
    );
    const live = articlesLive(api, () =>
      Effect.sync(() => {
        calls += 1;
      }).pipe(Effect.andThen(Effect.fail(new TitleTaken()))),
    );
    const { dispose, request } = server({ api, live, store: Idempotency.memoryStore() });
    onTestFinished(() => dispose());
    const first = await request({ key: "k1", body: createBody });
    const second = await request({ key: "k1", body: createBody });
    // A declared failure is not a completed write: the handler ran again and
    // answered the same way, rather than the key being burned on a 409.
    expect(calls).toBe(2);
    expect(first.status).toBe(409);
    expect(second.status).toBe(409);
    expect(second.replayed).toBeNull();
  });

  it("records a rejection rendered before the handler, so a corrected retry must use a new key", async () => {
    let calls = 0;
    const api = articlesApi(true);
    const live = articlesLive(api, () =>
      Effect.sync(() => {
        calls += 1;
        return { data: sample };
      }),
    );
    const { dispose, request } = server({ api, live, store: Idempotency.memoryStore() });
    onTestFinished(() => dispose());
    const malformed = await request({
      key: "k1",
      body: { data: { type: "articles", attributes: {} } },
    });
    const corrected = await request({ key: "k1", body: createBody });

    expect(calls).toBe(0);
    expect(malformed.status).toBe(400);
    // The client changed the request under a key that already named another
    // one — a mismatch, not a second chance at the same key.
    expect(corrected.status).toBe(422);
  });

  it("releases the key on a 5xx, so the client may retry it", async () => {
    let calls = 0;
    const api = articlesApi(true);
    const live = articlesLive(api, () =>
      Effect.sync(() => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return { data: sample };
      }),
    );
    const { dispose, request } = server({ api, live, store: Idempotency.memoryStore() });
    onTestFinished(() => dispose());
    const failed = await request({ key: "k1", body: createBody });
    const retried = await request({ key: "k1", body: createBody });
    expect(failed.status).toBe(500);
    expect(retried.status).toBe(201);
    expect(retried.replayed).toBeNull();
    expect(calls).toBe(2);
  });

  it("answers a missing required key with the standard 400 naming the header", async () => {
    const api = articlesApi("required");
    const live = articlesLive(api, () => Effect.succeed({ data: sample }));
    const { dispose, request } = server({ api, live, store: Idempotency.memoryStore() });
    onTestFinished(() => dispose());
    const missing = await request({ body: createBody });
    expect(missing.status).toBe(400);
    expect(JSON.parse(missing.body).errors[0].source).toEqual({ header: "idempotency-key" });
  });

  it("replays a bodyless 204 as a 204", async () => {
    let calls = 0;
    const api = HttpApi.make("blog").add(
      Group.make(Article, Endpoint.delete(Article, { idempotency: true })),
    );
    const live = HttpApiBuilder.group(api as never, "articles", (handlers: any) =>
      handlers.handle("delete", () =>
        Effect.sync(() => {
          calls += 1;
        }),
      ),
    ) as Layer.Layer<any, any, any>;
    const { dispose, request } = server({ api, live, store: Idempotency.memoryStore() });
    onTestFinished(() => dispose());
    const first = await request({
      method: "DELETE",
      url: "http://localhost/articles/1",
      key: "k1",
    });
    const second = await request({
      method: "DELETE",
      url: "http://localhost/articles/1",
      key: "k1",
    });

    expect(calls).toBe(1);
    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect(second.body).toBe("");
    expect(second.replayed).toBe("true");
  });

  it("leaves safe methods alone", async () => {
    const api = HttpApi.make("blog").add(
      Group.make(Article, Endpoint.get(Article).middleware(Idempotency.Middleware)),
    );
    const live = HttpApiBuilder.group(api as never, "articles", (handlers: any) =>
      handlers.handle("get", () => Effect.succeed({ data: sample })),
    ) as Layer.Layer<any, any, any>;
    const store = Idempotency.memoryStore();
    const { dispose, request } = server({ api, live, store });
    onTestFinished(() => dispose());
    const read = await request({ method: "GET", url: "http://localhost/articles/1", key: "k1" });
    expect(read.status).toBe(200);
    expect(Effect.runSync(store.claim(attempt("k1", "fp")))).toEqual({ _tag: "Claimed" });
  });
});

// ---------------------------------------------------------------------------
// Atomic operations: one key covers the whole request
// ---------------------------------------------------------------------------

describe("Idempotency and the atomic operations extension", () => {
  const operationsBody = {
    "atomic:operations": [
      {
        op: "add",
        data: { type: "articles", lid: "a1", attributes: { title: "Hello", body: "World" } },
      },
    ],
  };

  const operationsApi = HttpApi.make("ops").add(
    Group.make("operations", Endpoint.operations([Article], { idempotency: true })),
  );

  it("replays the whole atomic:results document, so a replayed lid keeps its assigned id", async () => {
    let calls = 0;
    const live = HttpApiBuilder.group(operationsApi as never, "operations", (handlers: any) =>
      handlers.handle("operations", () =>
        Effect.sync(() => {
          calls += 1;
          return { "atomic:results": [{ data: { ...sample, id: String(calls) } }] };
        }),
      ),
    ) as Layer.Layer<any, any, any>;
    const { dispose, request } = server({
      api: operationsApi,
      live,
      store: Idempotency.memoryStore(),
    });
    onTestFinished(() => dispose());
    const first = await request({
      key: "k1",
      url: "http://localhost/operations",
      body: operationsBody,
    });
    const second = await request({
      key: "k1",
      url: "http://localhost/operations",
      body: operationsBody,
    });

    expect(calls).toBe(1);
    expect(JSON.parse(first.body)["atomic:results"][0].data.id).toBe("1");
    expect(second.body).toBe(first.body);
    expect(second.replayed).toBe("true");
  });

  it("rejects the same key carrying a different operations list", async () => {
    const live = HttpApiBuilder.group(operationsApi as never, "operations", (handlers: any) =>
      handlers.handle("operations", () => Effect.succeed({ "atomic:results": [{ data: sample }] })),
    ) as Layer.Layer<any, any, any>;
    const { dispose, request } = server({
      api: operationsApi,
      live,
      store: Idempotency.memoryStore(),
    });
    onTestFinished(() => dispose());
    await request({ key: "k1", url: "http://localhost/operations", body: operationsBody });
    const changed = await request({
      key: "k1",
      url: "http://localhost/operations",
      body: {
        "atomic:operations": [
          ...operationsBody["atomic:operations"],
          {
            op: "add",
            data: { type: "articles", lid: "a2", attributes: { title: "Second", body: "!" } },
          },
        ],
      },
    });
    expect(changed.status).toBe(422);
  });
});
