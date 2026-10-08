/**
 * The handler factory over a stub operation set, pinned against the
 * consuming applications' handler corpus: the PATCH id cross-check (409),
 * the collection's pagination links carrying the whole query, the cache's
 * write-through / read-through / eviction against an in-memory stand-in,
 * the transaction boundary each write opens, the `?include=` walk on `get`
 * and `list` through stand-in targets, and the §7.4 related handler.
 */
import { describe, expect, it } from "vite-plus/test";
import { Cause, Context, Effect, Exit, Layer, Option, Schema } from "effect";
import * as ApiError from "./ApiError.js";
import type * as Assemble from "./Assemble.js";
import * as FlatQuery from "./FlatQuery.js";
import * as Group from "./Group.js";
import type * as Handlers from "./Handlers.js";
import * as Include from "./Include.js";
import * as Relationship from "./Relationship.js";
import * as Resource from "./Resource.js";
import * as ResourceHandlers from "./ResourceHandlers.js";
import * as ServerErrors from "./ServerErrors.js";

// ── The family under test ────────────────────────────────────────────

interface User {
  readonly id: string;
  readonly role: "user" | "admin";
}
const ADMIN: User = { id: "u1", role: "admin" };
const USER: User = { id: "u2", role: "user" };

class Viewer extends Context.Service<Viewer, Option.Option<User>>()("test/Viewer") {}
class Transaction extends Context.Service<Transaction, { readonly depth: number }>()("test/Tx") {}

const as = (user: Option.Option<User>) => Layer.succeed(Viewer, user);
const viewer = Effect.map(Effect.service(Viewer), Option.getOrUndefined);
const capabilities = (_resource: Assemble.ResourceLike, user: User | undefined) => ({
  canEdit: user?.role === "admin",
  canDelete: user?.role === "admin",
});

const Place = Resource.make("places", { attributes: { name: Schema.String } });
const Person = Resource.make("people", {
  attributes: { name: Schema.String },
  relationships: { birthPlace: Relationship.one(() => Place) },
});
const PERSON_INCLUDE = Include.make(Person, { birthPlace: Place });
const ListPeople = FlatQuery.listInput({ maxLimit: 100 }, { q: Schema.optionalKey(Schema.String) });
const { listQuery: peopleListQuery } = Group.flat({
  resource: Person,
  list: ListPeople,
  filters: ["q"],
  include: PERSON_INCLUDE,
  create: Schema.Struct({ name: Schema.String }),
  update: Schema.Struct({ id: Schema.String, name: Schema.optionalKey(Schema.String) }),
});

const PLACE = "10000000-0000-4000-8000-000000000001";
const ids = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface PersonLike extends Assemble.ResourceLike {
  readonly type: "people";
  readonly attributes: { readonly name: string };
}
const person = (id: string, name = `Person ${id}`): PersonLike => ({
  type: "people",
  id,
  attributes: { name },
  relationships: {
    birthPlace: {
      data: { type: "places", id: PLACE },
      links: { related: `https://example.test/people/${id}/birthPlace` },
    },
  },
  links: { self: `https://example.test/people/${id}` },
});
const place: Assemble.ResourceLike = {
  type: "places",
  id: PLACE,
  attributes: { name: "Camperdown" },
};

/* The decoded list input the stub ops read — both page fields optional, with no default, so the handler's "caller named no window" fallback is reachable. */
interface ListInput {
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
  readonly include?: ReadonlyArray<string> | undefined;
  readonly q?: string | undefined;
}

/** A stub op set over an in-memory store, counting every call. */
const makeOps = (seed: ReadonlyArray<PersonLike>) => {
  const store = new Map<string, PersonLike>(seed.map((p) => [p.id, p]));
  const calls = { list: 0, get: 0, create: 0, update: 0, delete: 0 };
  const ops: ResourceHandlers.Ops<
    ListInput,
    { readonly name: string },
    { readonly id: string; readonly name?: string | undefined },
    PersonLike,
    string,
    ServerErrors.NotFound,
    never,
    Transaction
  > = {
    list: (input) =>
      Effect.sync(() => {
        calls.list += 1;
        const all = [...store.values()].filter(
          (p) => input.q === undefined || p.attributes.name.toLowerCase().includes(input.q),
        );
        const offset = input.offset ?? 0;
        const limit = input.limit ?? all.length;
        return { items: all.slice(offset, offset + limit), totalCount: all.length };
      }),
    get: (id) =>
      Effect.suspend(() => {
        calls.get += 1;
        const found = store.get(id);
        return found === undefined
          ? new ServerErrors.NotFound({ resource: "people", id })
          : Effect.succeed(found);
      }),
    create: (input) =>
      Effect.gen(function* () {
        yield* Transaction;
        calls.create += 1;
        const created = person(ids(store.size + 1), input.name);
        store.set(created.id, created);
        return { id: created.id };
      }),
    update: (input) =>
      Effect.gen(function* () {
        yield* Transaction;
        calls.update += 1;
        const current = store.get(input.id);
        if (current === undefined) throw new Error("missing");
        store.set(input.id, {
          ...current,
          attributes: { name: input.name ?? current.attributes.name },
        });
        return { id: input.id };
      }),
    delete: (id) =>
      Effect.gen(function* () {
        yield* Transaction;
        calls.delete += 1;
        store.delete(id);
      }),
  };
  return { ops, calls, store };
};

/** A counting transaction seam: provides the ambient service, counts boundaries. */
const makeTransact = () => {
  let opened = 0;
  const transact: ResourceHandlers.Transact<Transaction, never, never> = (effect) =>
    Effect.suspend(() => {
      opened += 1;
      return Effect.provideService(effect, Transaction, { depth: 1 });
    });
  return { transact, opened: () => opened };
};

/** An in-memory cache stand-in with a freshness bypass for admins and a fault switch. */
const makeCache = () => {
  const store = new Map<string, PersonLike>();
  const state = { getFails: false };
  const cache: ResourceHandlers.Cache<PersonLike, Viewer> = {
    set: (id, resource) => Effect.sync(() => void store.set(id, resource)),
    delete: (id) => Effect.sync(() => void store.delete(id)),
    readThrough: <E, R>(
      id: string,
      load: Effect.Effect<PersonLike, E, R>,
    ): Effect.Effect<PersonLike, E, R | Viewer> =>
      Effect.gen(function* () {
        const user = yield* viewer;
        if (user?.role === "admin") return yield* load;
        const hit = state.getFails ? undefined : store.get(id);
        if (hit !== undefined) return hit;
        const loaded = yield* load;
        store.set(id, loaded);
        return loaded;
      }),
  };
  return { cache, store, state };
};

const targetCalls: Array<ReadonlyArray<string>> = [];
const targets = {
  places: ((requested) => {
    targetCalls.push(requested);
    return Effect.succeed(
      requested.filter((id) => id === PLACE).map(() => place as Handlers.ResourceValue),
    );
  }) satisfies Handlers.IncludeTarget,
} satisfies Handlers.IncludeTargets;

const seeded = () =>
  makeOps([person(ids(1), "Alpha"), person(ids(2), "Beta"), person(ids(3), "Gamma")]);

const handlersFor = (ops: ReturnType<typeof makeOps>["ops"]) => {
  const { cache, store: cacheStore, state } = makeCache();
  const { transact, opened } = makeTransact();
  const handlers = ResourceHandlers.make({
    ops,
    segment: "people",
    listQuery: peopleListQuery as ResourceHandlers.ListQuery<ListInput>,
    linkBase: Effect.succeed("https://example.test"),
    viewer,
    capabilities,
    cache,
    transact,
    include: { includable: PERSON_INCLUDE.paths, targets },
  });
  return { handlers, cacheStore, state, opened };
};

const failure = async <A, E>(effect: Effect.Effect<A, E, never>) => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return expect.fail("expected a failure");
  return Option.getOrThrow(Cause.findErrorOption(exit.cause)) as { readonly _tag: string };
};

describe("assertIdMatchesPath", () => {
  it("passes a matching pair and fails Conflict on a mismatch", async () => {
    await Effect.runPromise(ResourceHandlers.assertIdMatchesPath("a", "a"));
    const error = await failure(ResourceHandlers.assertIdMatchesPath("a", "b"));
    expect(error).toBeInstanceOf(ApiError.Conflict);
    expect((error as ApiError.Conflict).detail).toBe('URL id "a" does not match payload id "b".');
  });
});

describe("update", () => {
  it("answers 409 before touching the operation when the payload id differs from the route", async () => {
    const { ops, calls } = seeded();
    const { handlers, opened } = handlersFor(ops);
    const error = await failure(
      handlers
        .update({ params: { id: ids(1) }, payload: { id: ids(2), name: "X" } })
        .pipe(Effect.provide(as(Option.some(ADMIN)))),
    );
    expect(error).toBeInstanceOf(ApiError.Conflict);
    expect(calls.update).toBe(0);
    expect(opened()).toBe(0);
  });

  it("runs the operation in a transaction, re-reads, writes through and answers the document", async () => {
    const { ops, calls } = seeded();
    const { handlers, cacheStore, opened } = handlersFor(ops);
    const document = await Effect.runPromise(
      handlers
        .update({ params: { id: ids(1) }, payload: { id: ids(1), name: "Renamed" } })
        .pipe(Effect.provide(as(Option.some(ADMIN)))),
    );
    expect(opened()).toBe(1);
    expect(calls).toMatchObject({ update: 1, get: 1 });
    expect(document.data.attributes.name).toBe("Renamed");
    expect(document.data.meta).toEqual({ canEdit: true, canDelete: true });
    expect(cacheStore.get(ids(1))?.attributes.name).toBe("Renamed");
  });
});

describe("create / delete", () => {
  it("creates inside a transaction and caches the new resource; delete evicts it", async () => {
    const { ops, calls, store } = seeded();
    const { handlers, cacheStore, opened } = handlersFor(ops);
    const layer = as(Option.some(ADMIN));
    const created = await Effect.runPromise(
      handlers.create({ payload: { name: "Delta" } }).pipe(Effect.provide(layer)),
    );
    expect(created.data.attributes.name).toBe("Delta");
    expect(cacheStore.has(created.data.id)).toBe(true);
    expect(opened()).toBe(1);
    const removed = await Effect.runPromise(
      handlers.delete({ params: { id: created.data.id } }).pipe(Effect.provide(layer)),
    );
    expect(removed).toBeUndefined();
    expect(cacheStore.has(created.data.id)).toBe(false);
    expect(store.has(created.data.id)).toBe(false);
    expect(calls).toMatchObject({ create: 1, delete: 1 });
    expect(opened()).toBe(2);
  });
});

describe("get", () => {
  it("serves a non-admin from the cache when the entry is there, and populates it on a miss", async () => {
    const { ops, calls } = seeded();
    const { handlers, cacheStore } = handlersFor(ops);
    const layer = as(Option.some(USER));
    const first = await Effect.runPromise(
      handlers.get({ params: { id: ids(2) } }).pipe(Effect.provide(layer)),
    );
    expect(first.data.attributes.name).toBe("Beta");
    expect(first.data.meta).toEqual({ canEdit: false, canDelete: false });
    expect(calls.get).toBe(1);
    expect(cacheStore.has(ids(2))).toBe(true);
    const second = await Effect.runPromise(
      handlers.get({ params: { id: ids(2) } }).pipe(Effect.provide(layer)),
    );
    expect(second.data.id).toBe(ids(2));
    expect(calls.get).toBe(1);
  });

  it("bypasses the cache for an admin (freshness) and degrades a cache fault to the operation", async () => {
    const { ops, calls } = seeded();
    const { handlers, cacheStore, state } = handlersFor(ops);
    cacheStore.set(ids(1), person(ids(1), "Stale"));
    const admin = await Effect.runPromise(
      handlers.get({ params: { id: ids(1) } }).pipe(Effect.provide(as(Option.some(ADMIN)))),
    );
    expect(admin.data.attributes.name).toBe("Alpha");
    expect(calls.get).toBe(1);
    state.getFails = true;
    const anon = await Effect.runPromise(
      handlers.get({ params: { id: ids(1) } }).pipe(Effect.provide(as(Option.none()))),
    );
    expect(anon.data.attributes.name).toBe("Alpha");
    expect(calls.get).toBe(2);
  });

  it("answers NotFound for an unknown id", async () => {
    const { ops } = seeded();
    const { handlers } = handlersFor(ops);
    const error = await failure(
      handlers.get({ params: { id: ids(9) } }).pipe(Effect.provide(as(Option.some(USER)))),
    );
    expect(error._tag).toBe("NotFound");
  });

  it("resolves `?include=` through the target registry, and refuses an unlisted path", async () => {
    const { ops } = seeded();
    const { handlers } = handlersFor(ops);
    targetCalls.length = 0;
    const document = await Effect.runPromise(
      handlers
        .get({ params: { id: ids(1) }, query: { include: ["birthPlace"] } })
        .pipe(Effect.provide(as(Option.some(USER)))),
    );
    expect(document.included?.map((r) => `${r.type}:${r.id}`)).toEqual([`places:${PLACE}`]);
    expect(targetCalls).toEqual([[PLACE]]);
    const error = await failure(
      handlers
        .get({ params: { id: ids(1) }, query: { include: ["nope"] } })
        .pipe(Effect.provide(as(Option.some(USER)))),
    );
    expect(error).toBeInstanceOf(ApiError.UnsupportedIncludePath);
  });
});

describe("list", () => {
  it("emits the page's pagination links and total, and stamps capabilities per viewer", async () => {
    const { ops } = seeded();
    const { handlers } = handlersFor(ops);
    const document = await Effect.runPromise(
      handlers
        .list({ query: { limit: 1, offset: 1 } })
        .pipe(Effect.provide(as(Option.some(ADMIN)))),
    );
    expect(document.meta).toEqual({ totalCount: 3 });
    expect(document.data.map((r) => r.attributes.name)).toEqual(["Beta"]);
    expect(document.links).toEqual({
      self: "https://example.test/people?page[offset]=1&page[limit]=1",
      first: "https://example.test/people?page[offset]=0&page[limit]=1",
      prev: "https://example.test/people?page[offset]=0&page[limit]=1",
      next: "https://example.test/people?page[offset]=2&page[limit]=1",
      last: "https://example.test/people?page[offset]=2&page[limit]=1",
    });
    expect(document.data[0]?.meta).toEqual({ canEdit: true, canDelete: true });
    const anon = await Effect.runPromise(
      handlers.list({ query: {} }).pipe(Effect.provide(as(Option.none()))),
    );
    expect(anon.data).toHaveLength(3);
    expect(anon.data[0]?.meta).toEqual({ canEdit: false, canDelete: false });
    // One page holds everything: the spec's "no such page" is a `null` link.
    expect(anon.links).toMatchObject({ next: null, prev: null });
  });

  it("resolves a page's include walk in one batch per target type, deduplicated", async () => {
    const { ops } = seeded();
    const { handlers } = handlersFor(ops);
    targetCalls.length = 0;
    const document = await Effect.runPromise(
      handlers
        .list({ query: { include: ["birthPlace"] } })
        .pipe(Effect.provide(as(Option.some(USER)))),
    );
    // Three people share one birthplace: one loader call, one id, one member.
    expect(targetCalls).toEqual([[PLACE]]);
    expect(document.included?.map((r) => r.id)).toEqual([PLACE]);
    expect(document.included?.[0]?.meta).toEqual({ canEdit: false, canDelete: false });
    const plain = await Effect.runPromise(
      handlers.list({ query: {} }).pipe(Effect.provide(as(Option.some(USER)))),
    );
    expect(plain).not.toHaveProperty("included");
  });

  /**
   * One test per axis the links have to carry, each asserting the parameter
   * reaches all five links: a client paginates by `next` / `prev`, and
   * `first` / `last` are the jump targets.
   */
  describe("carries the request's whole query into every link", () => {
    const LINK_NAMES = ["self", "first", "prev", "next", "last"] as const;
    const linksFor = async (query: ListInput) => {
      const { ops } = seeded();
      const { handlers } = handlersFor(ops);
      const document = await Effect.runPromise(
        handlers.list({ query }).pipe(Effect.provide(as(Option.some(USER)))),
      );
      return LINK_NAMES.map((name) => {
        const link = document.links[name];
        if (typeof link !== "string") throw new Error(`the \`${name}\` link is missing`);
        return link;
      });
    };

    it("carries `?include=` and a `filter[…]` member into all five links", async () => {
      for (const link of await linksFor({ limit: 1, offset: 1, include: ["birthPlace"] }))
        expect(link).toContain("include=birthPlace");
      for (const link of await linksFor({ limit: 1, offset: 1, q: "a" }))
        expect(link).toContain("filter[q]=a");
    });

    it("replaces the request's own `page[*]` cursor rather than appending, canonically ordered", async () => {
      const [self, , , next] = await linksFor({
        limit: 1,
        offset: 1,
        q: "a",
        include: ["birthPlace"],
      });
      expect(next).toBe(
        "https://example.test/people?include=birthPlace&filter[q]=a&page[offset]=2&page[limit]=1",
      );
      expect(next?.match(/page\[offset\]=/g)).toHaveLength(1);
      expect(self).toContain("page[offset]=1");
    });
  });
});

describe("readOnly", () => {
  it("exposes exactly `list` and `get`, with no cache or viewer wired", async () => {
    const { ops, calls } = seeded();
    const handlers = ResourceHandlers.readOnly({
      ops,
      segment: "people",
      listQuery: peopleListQuery as ResourceHandlers.ListQuery<ListInput>,
      linkBase: Effect.succeed("https://example.test"),
    });
    expect(Object.keys(handlers).sort()).toEqual(["get", "list"]);
    const document = await Effect.runPromise(handlers.get({ params: { id: ids(1) } }));
    expect(document.data.id).toBe(ids(1));
    expect(document.data).not.toHaveProperty("meta");
    expect(calls.get).toBe(1);
  });
});

describe("related", () => {
  const parent = (): Assemble.ResourceLike => ({
    type: "contests",
    id: "c1",
    attributes: {},
    relationships: {
      election: { data: { type: "elections", id: "e1" } },
      candidates: {
        data: [
          { type: "candidates", id: "k1" },
          { type: "candidates", id: "k2" },
          { type: "candidates", id: "k3" },
        ],
      },
      polity: { data: null },
    },
  });
  const calls: Array<ReadonlyArray<string>> = [];
  const registry = {
    elections: ((ids) =>
      Effect.succeed(
        ids.map((id) => ({ type: "elections", id, attributes: {} })),
      )) satisfies Handlers.IncludeTarget,
    candidates: ((ids) => {
      calls.push(ids);
      return Effect.succeed(
        ids.filter((id) => id !== "k2").map((id) => ({ type: "candidates", id, attributes: {} })),
      );
    }) satisfies Handlers.IncludeTarget,
  } satisfies Handlers.IncludeTargets;
  const config = {
    segment: "contests",
    loadParent: (_id: string) => Effect.succeed(parent()),
    targets: registry,
    linkBase: Effect.succeed("https://example.test"),
  };

  it("answers a to-many as a paginated collection of only the page's refs, dropping unresolved ones", async () => {
    calls.length = 0;
    const handler = ResourceHandlers.related({ ...config, key: "candidates", cardinality: "many" });
    const document = (await Effect.runPromise(
      handler({ params: { id: "c1" }, query: { limit: 2, offset: 0 } }),
    )) as Assemble.CollectionDocument<Assemble.ResourceLike>;
    expect(calls).toEqual([["k1", "k2"]]);
    expect(document.data.map((r) => r.id)).toEqual(["k1"]);
    expect(document.meta.totalCount).toBe(3);
    expect(document.links.self).toBe(
      "https://example.test/contests/c1/candidates?page[offset]=0&page[limit]=2",
    );
  });

  it("drops a ref whose type names an Object.prototype member, as it does any type with no target", async () => {
    for (const type of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      const one = ResourceHandlers.related({
        ...config,
        loadParent: (_id: string) =>
          Effect.succeed({
            type: "contests",
            id: "c1",
            attributes: {},
            relationships: { election: { data: { type, id: "e1" } } },
          }),
        key: "election",
        cardinality: "one",
      });
      expect(await Effect.runPromise(one({ params: { id: "c1" } }))).toEqual({
        data: null,
        jsonapi: { version: "1.1" },
      });
    }
  });

  it("answers a to-one as the related resource, or `data: null` for empty linkage", async () => {
    const one = ResourceHandlers.related({ ...config, key: "election", cardinality: "one" });
    const document = (await Effect.runPromise(
      one({ params: { id: "c1" } }),
    )) as Assemble.ResourceDocument<Assemble.ResourceLike>;
    expect(document.data).toMatchObject({ type: "elections", id: "e1" });
    const empty = ResourceHandlers.related({ ...config, key: "polity", cardinality: "one" });
    expect(await Effect.runPromise(empty({ params: { id: "c1" } }))).toEqual({
      data: null,
      jsonapi: { version: "1.1" },
    });
  });
});
