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
 * of a stored article with it. Every request goes through `observing`, as in a
 * real run.
 */
const context = (): Core.Context => {
  const store = MutableHashMap.empty<string, string>();
  const serve = (probe: { readonly method?: string; readonly url: string }) => {
    if (probe.method === "POST") {
      const id = `${100 + MutableHashMap.size(store)}`;
      MutableHashMap.set(store, id, "stored");
      return { status: 201, body: article(id) };
    }
    const id = probe.url.replace("/articles/", "");
    return MutableHashMap.has(store, id)
      ? { status: 200, body: article(id) }
      : { status: 404, body: { errors: [{ status: "404" }] } };
  };
  const observed = MutableHashSet.empty<string>();
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
    },
    writes: [],
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
    ),
  };
};

describe("the write fixture's id vetting", () => {
  it("accepts an id it created, read back and removed when the server reuses it", async () => {
    const ctx = context();
    await Effect.runPromise(
      Effect.gen(function* () {
        const rule = yield* Effect.fromOption(Arr.head(Spec.rules));
        const target = yield* Effect.fromOption(Arr.head(Write.targets(ctx, "create").targets));
        // A probe that reads back what it created — as a rule checking that a
        // write was stored would — before the resource is disposed of.
        const readBack = Write.withCreated(
          ctx,
          rule.rule,
          target,
          Write.viaCreateEndpoint(ctx, target),
          () =>
            Effect.forEach(
              Arr.filterMap(ctx.writes, ({ id }) =>
                id === undefined ? Result.failVoid : Result.succeed(id),
              ),
              (id) => ctx.request({ url: `/articles/${id}` }),
              { concurrency: 1, discard: true },
            ),
        );
        yield* readBack;
        yield* readBack;
      }),
    );
    // The read showed articles:100, but the kit had made it: the second create,
    // which the server answered with the same id, is the kit's too.
    expect(MutableHashSet.has(ctx.observed, Core.idKey("articles", "100"))).toBe(true);
    expect(ctx.writes.map(({ id, disposal, detail }) => ({ id, disposal, detail }))).toEqual([
      { id: "100", disposal: "cleaned-up", detail: undefined },
      { id: "100", disposal: "cleaned-up", detail: undefined },
    ]);
  });
});
