import { describe, expect, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as MutableHashMap from "effect/MutableHashMap";
import * as MutableHashSet from "effect/MutableHashSet";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpApi } from "effect/http-api";
import * as Endpoint from "../../Endpoint.js";
import * as Group from "../../Group.js";
import * as Resource from "../../Resource.js";
import * as Core from "./core.js";
import * as Spec from "./spec.js";
import * as Write from "./write.js";

const Article = Resource.make("articles", { attributes: { title: Schema.String } });

const api = HttpApi.make("writes").add(
  Group.make(Article, Endpoint.get(Article), Endpoint.create(Article)),
);

/** An article as the server below answers it. */
const article = (id: string) => ({ data: { type: "articles", id, attributes: {} } });

/**
 * A run's context over a server that stores articles and hands out the next
 * free id — so an id comes back once its resource is gone — and answers a GET
 * of a stored article with it. Every request goes through `observing`, over
 * the run's own ledger, as in a real run. `store` is the server's, so a test
 * can put a resource there that someone other than the kit made.
 */
const context = (store = MutableHashMap.empty<string, string>()): Core.Context => {
  const serve = (probe: { readonly method?: string; readonly url: string }) => {
    if (probe.method === "POST") {
      const id = `${100 + MutableHashMap.size(store)}`;
      MutableHashMap.set(store, id, "stored");
      return { status: 201, body: Option.some(article(id)) };
    }
    const id = probe.url.replace("/articles/", "");
    return MutableHashMap.has(store, id)
      ? { status: 200, body: Option.some(article(id)) }
      : { status: 404, body: Option.some({ errors: [{ status: "404" }] }) };
  };
  const observed = MutableHashSet.empty<string>();
  const writes: Core.Context["writes"] = [];
  return {
    endpoints: Core.discover(api),
    options: {
      baseUrl: "http://fixture.test",
      ids: {},
      paths: {},
      absentId: "absent",
      extensions: [],
      mutating: true,
      writes: {
        articles: {
          create: () => ({ type: "articles", attributes: { title: "probe" } }),
          cleanup: (id) => Effect.sync(() => MutableHashMap.remove(store, id)),
        },
      },
      requestTimeout: Option.none(),
    },
    writes,
    observed,
    request: Core.observing(
      (probe) =>
        Effect.sync(() => ({
          probe: { method: probe.method ?? "GET", url: probe.url, headers: {}, body: undefined },
          headers: {},
          contentType: undefined,
          text: "",
          transportError: undefined,
          redirects: [],
          unfollowed: Option.none(),
          ...serve(probe),
        })),
      observed,
      writes,
    ),
  };
};

/**
 * One create through the fixture, handing `use` what it made before the
 * resource is disposed of.
 */
const createThen = (ctx: Core.Context, use: () => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const rule = yield* Effect.fromOption(Arr.head(Spec.rules));
    const target = yield* Effect.fromOption(Arr.head(Write.targets(ctx, "create").targets));
    yield* Write.withCreated(ctx, rule.rule, target, Write.viaCreateEndpoint(ctx, target), use);
  });

/** Reads back every id the run holds, as a rule checking that a write was stored would. */
const readBackAll = (ctx: Core.Context) =>
  Effect.forEach(
    Arr.filterMap(ctx.writes, ({ id }) =>
      id === undefined ? Result.failVoid : Result.succeed(id),
    ),
    (id) => ctx.request({ url: `/articles/${id}` }),
    { concurrency: 1, discard: true },
  );

describe("the write fixture's id vetting", () => {
  it("accepts an id it created, read back and removed when the server reuses it", async () => {
    const ctx = context();
    const readBack = createThen(ctx, () => readBackAll(ctx));
    await Effect.runPromise(Effect.andThen(readBack, readBack));
    // The read showed articles:100 while the kit held it, so it is not counted
    // as seen: the second create, which the server answered with the same id,
    // is the kit's too.
    expect(MutableHashSet.has(ctx.observed, Core.idKey("articles", "100"))).toBe(false);
    expect(ctx.writes.map(({ id, disposal, detail }) => ({ id, disposal, detail }))).toEqual([
      { id: "100", disposal: "cleaned-up", detail: undefined },
      { id: "100", disposal: "cleaned-up", detail: undefined },
    ]);
  });

  it("refuses an id it once held when a read after its removal showed another holder's", async () => {
    const store = MutableHashMap.empty<string, string>();
    const ctx = context(store);
    await Effect.runPromise(
      Effect.gen(function* () {
        // 1–2. The kit takes articles:100, and removes it.
        yield* createThen(ctx, () => Effect.void);
        // 3. Someone else's articles:100, which a later read shows.
        MutableHashMap.set(store, "100", "another holder's");
        yield* ctx.request({ url: "/articles/100" });
        MutableHashMap.remove(store, "100");
        // 4. The server answers a create with 100 again.
        yield* createThen(ctx, () => Effect.void);
      }),
    );
    expect(MutableHashSet.has(ctx.observed, Core.idKey("articles", "100"))).toBe(true);
    expect(ctx.writes.map(({ id, disposal, detail }) => ({ id, disposal, detail }))).toEqual([
      { id: "100", disposal: "cleaned-up", detail: undefined },
      {
        id: undefined,
        disposal: "left",
        detail:
          "the create response named `articles:100`, which the kit did not create (a read earlier in this run returned it) — not touched",
      },
    ]);
  });
});

describe("read-back comparison", () => {
  const stored = {
    type: "articles",
    id: "1",
    attributes: { title: "probe", publishedAt: "2026-01-01T00:00:00.000Z" },
  };

  it("compares a fixture's members as the JSON the request body carried", () => {
    // A value with its own JSON form, as a `Date` (its ISO string) has.
    const publishedAt = { toJSON: () => "2026-01-01T00:00:00.000Z" };
    const expected = Write.asSent({
      attributes: { title: "probe", publishedAt, draft: undefined },
    });
    expect(expected).toEqual({
      attributes: { title: "probe", publishedAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(Write.readBackDifferences(expected, stored)).toEqual([]);
  });

  it("names a member read back otherwise, and one not read back at all", () => {
    expect(
      Write.readBackDifferences(
        Write.asSent({ attributes: { title: "other", rating: 5 } }),
        stored,
      ),
    ).toEqual([
      'attributes.title: "other" · read back "probe"',
      "attributes.rating: 5 · read back absent",
    ]);
  });
});
