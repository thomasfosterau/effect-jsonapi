/**
 * The handler factory over a stub operation set, pinned against the
 * consuming applications' handler corpus: the PATCH id cross-check (409),
 * the collection's pagination links carrying the whole query, the cache's
 * write-through / read-through / eviction against an in-memory stand-in,
 * the transaction boundary each write opens, the `?include=` walk on `get`
 * and `list` through stand-in targets, and the §7.4 related handler.
 */
import * as MutableHashMap from "effect/MutableHashMap";
import * as R from "effect/Record";
import { it } from "@effect/vitest";
import { assert, describe, expect } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
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

/** The update input the stub ops take. */
interface UpdateInput {
  readonly id: string;
  readonly name?: string | undefined;
}

/** A stub op set over an in-memory store, counting every call. */
const makeOps = (seed: ReadonlyArray<PersonLike>) => {
  const store = MutableHashMap.fromIterable(seed.map((p) => [p.id, p] as const));
  const calls = { list: 0, get: 0, create: 0, update: 0, delete: 0 };
  const ops: ResourceHandlers.Ops<
    ListInput,
    { readonly name: string },
    UpdateInput,
    PersonLike,
    string,
    ServerErrors.NotFound,
    never,
    Transaction
  > = {
    list: (input) =>
      Effect.sync(() => {
        calls.list += 1;
        const all = Arr.fromIterable(MutableHashMap.values(store)).filter(
          (p) => input.q === undefined || p.attributes.name.toLowerCase().includes(input.q),
        );
        const offset = input.offset ?? 0;
        const limit = input.limit ?? all.length;
        return { items: all.slice(offset, offset + limit), totalCount: all.length };
      }),
    get: (id) =>
      Effect.suspend(() => {
        calls.get += 1;
        const found = Option.getOrUndefined(MutableHashMap.get(store, id));
        return found === undefined
          ? new ServerErrors.NotFound({ resource: "people", id })
          : Effect.succeed(found);
      }),
    create: (input) =>
      Effect.gen(function* () {
        yield* Transaction;
        calls.create += 1;
        const created = person(ids(MutableHashMap.size(store) + 1), input.name);
        MutableHashMap.set(store, created.id, created);
        return { id: created.id };
      }),
    update: (input) =>
      Effect.gen(function* () {
        yield* Transaction;
        calls.update += 1;
        const current = Option.getOrUndefined(MutableHashMap.get(store, input.id));
        if (current === undefined) return yield* Effect.die("missing");
        MutableHashMap.set(store, input.id, {
          ...current,
          attributes: { name: input.name ?? current.attributes.name },
        });
        return { id: input.id };
      }),
    delete: (id) =>
      Effect.gen(function* () {
        yield* Transaction;
        calls.delete += 1;
        MutableHashMap.remove(store, id);
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
  const store = MutableHashMap.empty<string, PersonLike>();
  const state = { getFails: false };
  const cache: ResourceHandlers.Cache<PersonLike, Viewer> = {
    set: (id, resource) => Effect.sync(() => void MutableHashMap.set(store, id, resource)),
    delete: (id) => Effect.sync(() => void MutableHashMap.remove(store, id)),
    readThrough: <E, R>(
      id: string,
      load: Effect.Effect<PersonLike, E, R>,
    ): Effect.Effect<PersonLike, E, R | Viewer> =>
      Effect.gen(function* () {
        const user = yield* viewer;
        if (user?.role === "admin") return yield* load;
        const hit = state.getFails
          ? undefined
          : Option.getOrUndefined(MutableHashMap.get(store, id));
        if (hit !== undefined) return hit;
        const loaded = yield* load;
        MutableHashMap.set(store, id, loaded);
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

// SAFETY: the stub ops read the same members the family's list query decodes.
const listQuery = peopleListQuery as ResourceHandlers.ListQuery<ListInput>;

const handlersFor = (
  ops: ReturnType<typeof makeOps>["ops"],
  extra: { readonly capabilitiesOnIncluded?: boolean } = {},
) => {
  const { cache, store: cacheStore, state } = makeCache();
  const { transact, opened } = makeTransact();
  const handlers = ResourceHandlers.make({
    ops,
    segment: "people",
    listQuery,
    linkBase: Effect.succeed("https://example.test"),
    viewer,
    capabilities,
    cache,
    transact,
    include: { includable: PERSON_INCLUDE.paths, targets },
    ...extra,
  });
  return { handlers, cacheStore, state, opened };
};

const failure = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);
    if (Exit.isSuccess(exit)) return expect.fail("expected a failure");
    const error = Cause.findErrorOption(exit.cause);
    assert(Option.isSome(error), "expected a typed failure");
    return error.value as { readonly _tag: string };
  });

/** Runs `effect` to its success, failing the test on any other exit. */
const success = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A> =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);
    if (Exit.isFailure(exit)) return expect.fail(`expected a success: ${Cause.pretty(exit.cause)}`);
    return exit.value;
  });

describe("assertIdMatchesPath", () => {
  it.effect("passes a matching pair and fails Conflict on a mismatch", () =>
    Effect.gen(function* () {
      yield* ResourceHandlers.assertIdMatchesPath("a", "a");
      const error = yield* failure(ResourceHandlers.assertIdMatchesPath("a", "b"));
      expect(error).toBeInstanceOf(ApiError.Conflict);
      expect((error as ApiError.Conflict).detail).toBe('URL id "a" does not match payload id "b".');
    }),
  );
});

describe("update", () => {
  it.effect(
    "answers 409 before touching the operation when the payload id differs from the route",
    () =>
      Effect.gen(function* () {
        const { ops, calls } = seeded();
        const { handlers, opened } = handlersFor(ops);
        const error = yield* failure(
          handlers
            .update({ params: { id: ids(1) }, payload: { id: ids(2), name: "X" } })
            .pipe(Effect.provide(as(Option.some(ADMIN)))),
        );
        expect(error).toBeInstanceOf(ApiError.Conflict);
        expect(calls.update).toBe(0);
        expect(opened()).toBe(0);
      }),
  );

  it.effect(
    "runs the operation in a transaction, re-reads, writes through and answers the document",
    () =>
      Effect.gen(function* () {
        const { ops, calls } = seeded();
        const { handlers, cacheStore, opened } = handlersFor(ops);
        const document = yield* handlers
          .update({ params: { id: ids(1) }, payload: { id: ids(1), name: "Renamed" } })
          .pipe(Effect.provide(as(Option.some(ADMIN))));
        expect(opened()).toBe(1);
        expect(calls).toMatchObject({ update: 1, get: 1 });
        expect(document.data.attributes.name).toBe("Renamed");
        expect(document.data.meta).toEqual({ canEdit: true, canDelete: true });
        expect(Option.getOrUndefined(MutableHashMap.get(cacheStore, ids(1)))?.attributes.name).toBe(
          "Renamed",
        );
      }),
  );
});

describe("create / delete", () => {
  it.effect("creates inside a transaction and caches the new resource; delete evicts it", () =>
    Effect.gen(function* () {
      const { ops, calls, store } = seeded();
      const { handlers, cacheStore, opened } = handlersFor(ops);
      const layer = as(Option.some(ADMIN));
      const created = yield* handlers
        .create({ payload: { name: "Delta" } })
        .pipe(Effect.provide(layer));
      expect(created.data.attributes.name).toBe("Delta");
      expect(MutableHashMap.has(cacheStore, created.data.id)).toBe(true);
      expect(opened()).toBe(1);
      const removed = yield* handlers
        .delete({ params: { id: created.data.id } })
        .pipe(Effect.provide(layer));
      expect(removed).toBeUndefined();
      expect(MutableHashMap.has(cacheStore, created.data.id)).toBe(false);
      expect(MutableHashMap.has(store, created.data.id)).toBe(false);
      expect(calls).toMatchObject({ create: 1, delete: 1 });
      expect(opened()).toBe(2);
    }),
  );
});

/**
 * A write that hides the row from its own writer (pulpit#107): the write
 * commits, the writer's re-read fails, and the cached public entry must not
 * survive it. The fixtures vary one seam each: a re-read that hides or
 * breaks, a transaction that interrupts after the operation, an operation
 * that refuses.
 */
describe("a write whose re-read fails", () => {
  class StoreDown extends Schema.TaggedError<StoreDown, { readonly brand: unique symbol }>()(
    "StoreDown",
    {},
  ) {}

  /** The seeded ops, with a re-read that fails for the ids in `hidden` as `reread` says. */
  const hidingOps = (
    reread: (id: string) => Effect.Effect<never, ServerErrors.NotFound | StoreDown> = (id) =>
      new ServerErrors.NotFound({ resource: "people", id }),
  ) => {
    const seededOps = seeded();
    const hidden: Array<string> = [];
    const ops: ResourceHandlers.Ops<
      ListInput,
      { readonly name: string },
      UpdateInput,
      PersonLike,
      string,
      ServerErrors.NotFound | StoreDown,
      never,
      Transaction
    > = {
      ...seededOps.ops,
      get: (id) => (hidden.includes(id) ? reread(id) : seededOps.ops.get(id)),
      // The write hides what it wrote, and reports the version it committed.
      create: (input) =>
        Effect.map(seededOps.ops.create(input), ({ id }) => {
          hidden.push(id);
          return { id, version: 1 };
        }),
      update: (input) =>
        Effect.map(seededOps.ops.update(input), ({ id }) => {
          hidden.push(id);
          return { id, version: 7 };
        }),
    };
    return { ...seededOps, ops, hidden };
  };

  class CommitFailed extends Schema.TaggedError<CommitFailed, { readonly brand: unique symbol }>()(
    "CommitFailed",
    {},
  ) {}
  type HiddenRule = ResourceHandlers.HiddenWrite<ServerErrors.NotFound | StoreDown, "people">;

  /**
   * The handler config the tests vary: a transaction seam, the hidden-write
   * rule, and a cache whose eviction is asynchronous (it signals
   * `evicting`, then yields to the scheduler before it deletes), so an
   * interrupt can land part-way through it.
   */
  const build = (
    ops: ReturnType<typeof hidingOps>["ops"],
    options: {
      readonly transact?: ResourceHandlers.Transact<Transaction, CommitFailed, never>;
      // oxlint-disable-next-line effect/prefer-option-over-null -- forwarded as is to `ResourceHandlers.make`'s own `?: T | undefined` option
      readonly hiddenWrite?: HiddenRule | undefined;
      readonly evicting?: Deferred.Deferred<void>;
    } = {},
  ) => {
    const made = makeCache();
    const { store: cacheStore } = made;
    const { evicting } = options;
    const cache: typeof made.cache =
      evicting === undefined
        ? made.cache
        : {
            ...made.cache,
            delete: (id) =>
              Effect.andThen(
                Deferred.succeed(evicting, undefined),
                Effect.andThen(Effect.sleep("10 millis"), made.cache.delete(id)),
              ),
          };
    // The public entry a reader cached before the write.
    MutableHashMap.set(cacheStore, ids(1), person(ids(1), "Public"));
    MutableHashMap.set(cacheStore, ids(2), person(ids(2), "Public"));
    const handlers = ResourceHandlers.make({
      ops,
      segment: "people",
      listQuery,
      linkBase: Effect.succeed("https://example.test"),
      viewer,
      capabilities,
      cache,
      transact: options.transact ?? makeTransact().transact,
      hiddenWrite: options.hiddenWrite,
    });
    return { handlers, cacheStore };
  };

  const admin = as(Option.some(ADMIN));
  const renameFirst = { params: { id: ids(1) }, payload: { id: ids(1), name: "Private" } };

  // The guarantee is that an interrupt can't separate a commit from its
  // cache step: with the re-read pending (it never answers), an external
  // interrupt still lets the eviction that follows run to completion, though
  // the eviction itself is asynchronous.
  // These tests run on the live clock (`it.live`): the cache's eviction sleeps,
  // which `it.effect`'s TestClock would never advance.
  it.live.each(["create", "update"] as const)(
    "evicts in full when the %s is interrupted while its re-read is pending",
    (kind) =>
      Effect.gen(function* () {
        const rereading = Deferred.makeUnsafe<void>();
        const evicting = Deferred.makeUnsafe<void>();
        const { ops } = hidingOps(() =>
          Effect.andThen(Deferred.succeed(rereading, undefined), Effect.never),
        );
        const { handlers, cacheStore } = build(ops, { evicting });
        // A stale entry under the id the create is about to write.
        MutableHashMap.set(cacheStore, ids(4), person(ids(4), "Stale"));
        const written = kind === "create" ? ids(4) : ids(1);
        const write =
          kind === "create"
            ? handlers.create({ payload: { name: "Delta" } })
            : handlers.update(renameFirst);
        yield* success(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(write.pipe(Effect.provide(admin)));
            yield* Deferred.await(rereading);
            yield* Fiber.interrupt(fiber);
          }),
        );
        expect(Deferred.isDoneUnsafe(evicting)).toBe(true);
        expect(MutableHashMap.has(cacheStore, written)).toBe(false);
      }),
  );

  it.live("evicts in full when a delete is interrupted during its eviction", () =>
    Effect.gen(function* () {
      const evicting = Deferred.makeUnsafe<void>();
      const { ops, store } = hidingOps();
      const { handlers, cacheStore } = build(ops, { evicting });
      yield* success(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            handlers.delete({ params: { id: ids(2) } }).pipe(Effect.provide(admin)),
          );
          yield* Deferred.await(evicting);
          yield* Fiber.interrupt(fiber);
        }),
      );
      expect(MutableHashMap.has(store, ids(2))).toBe(false);
      expect(MutableHashMap.has(cacheStore, ids(2))).toBe(false);
    }),
  );

  // The operation ran, then the commit failed: the write may have committed
  // (a lost acknowledgement), so a plain failure evicts too, not only an
  // interruption.
  it.effect("evicts when the transaction fails after the operation succeeded", () =>
    Effect.gen(function* () {
      const failingCommit: ResourceHandlers.Transact<Transaction, CommitFailed, never> = (effect) =>
        Effect.andThen(
          Effect.provideService(effect, Transaction, { depth: 1 }),
          Effect.fail(new CommitFailed()),
        );
      const { ops, calls } = hidingOps();
      const { handlers, cacheStore } = build(ops, { transact: failingCommit });
      expect(
        yield* failure(handlers.update(renameFirst).pipe(Effect.provide(admin))),
      ).toBeInstanceOf(CommitFailed);
      expect(MutableHashMap.has(cacheStore, ids(1))).toBe(false);
      expect(
        yield* failure(handlers.delete({ params: { id: ids(2) } }).pipe(Effect.provide(admin))),
      ).toBeInstanceOf(CommitFailed);
      expect(MutableHashMap.has(cacheStore, ids(2))).toBe(false);
      expect(calls).toMatchObject({ update: 1, delete: 1, get: 0 });
    }),
  );

  it.effect(
    "evicts the cached entry when the writer can no longer read the row, and fails as the re-read did",
    () =>
      Effect.gen(function* () {
        const { ops, store } = hidingOps();
        const { handlers, cacheStore } = build(ops);
        const error = yield* failure(handlers.update(renameFirst).pipe(Effect.provide(admin)));
        expect(error._tag).toBe("NotFound");
        expect(Option.getOrUndefined(MutableHashMap.get(store, ids(1)))?.attributes.name).toBe(
          "Private",
        );
        expect(MutableHashMap.has(cacheStore, ids(1))).toBe(false);
        expect(MutableHashMap.has(cacheStore, ids(2))).toBe(true);
      }),
  );

  it.effect("evicts on any re-read failure, and propagates its cause unchanged", () =>
    Effect.gen(function* () {
      const failing = hidingOps(() => new StoreDown());
      const failed = build(failing.ops);
      const exit = yield* Effect.exit(
        failed.handlers.update(renameFirst).pipe(Effect.provide(admin)),
      );
      expect(Exit.isFailure(exit) && Cause.findErrorOption(exit.cause)).toEqual(
        Option.some(new StoreDown()),
      );
      expect(MutableHashMap.has(failed.cacheStore, ids(1))).toBe(false);
    }),
  );

  // A cause carrying a defect (or an interruption) beside the failure is never
  // a hidden write, whatever the rule says of the failure.
  it.effect.each([
    ["a defect", Cause.die("boom")],
    ["an interruption", Cause.interrupt()],
  ] as const)("never answers a re-read failure carrying %s as hidden", ([_, extra]) =>
    Effect.gen(function* () {
      const breaking = hidingOps((id) =>
        Effect.failCause(
          Cause.combine(Cause.fail(new ServerErrors.NotFound({ resource: "people", id })), extra),
        ),
      );
      const broke = build(breaking.ops, { hiddenWrite: { type: "people", when: () => true } });
      const exit = yield* Effect.exit(
        broke.handlers.update(renameFirst).pipe(Effect.provide(admin)),
      );
      expect(Exit.isFailure(exit) && exit.cause.reasons.length).toBe(2);
      expect(MutableHashMap.has(broke.cacheStore, ids(1))).toBe(false);
    }),
  );

  it.effect("evicts when the transaction is interrupted after the operation succeeded", () =>
    Effect.gen(function* () {
      // The commit point is inside the boundary: the operation ran, then the
      // boundary is interrupted before the handler's cache step.
      const interrupting: ResourceHandlers.Transact<Transaction, never, never> = (effect) =>
        Effect.andThen(Effect.provideService(effect, Transaction, { depth: 1 }), Effect.interrupt);
      const { ops, calls } = hidingOps();
      const { handlers, cacheStore } = build(ops, { transact: interrupting });
      const update = yield* Effect.exit(handlers.update(renameFirst).pipe(Effect.provide(admin)));
      expect(Exit.isFailure(update) && Cause.hasInterruptsOnly(update.cause)).toBe(true);
      expect(MutableHashMap.has(cacheStore, ids(1))).toBe(false);

      const remove = yield* Effect.exit(
        handlers.delete({ params: { id: ids(2) } }).pipe(Effect.provide(admin)),
      );
      expect(Exit.isFailure(remove)).toBe(true);
      expect(MutableHashMap.has(cacheStore, ids(2))).toBe(false);
      expect(calls).toMatchObject({ update: 1, delete: 1, get: 0 });
    }),
  );

  it.effect("never evicts for a write the operation refuses", () =>
    Effect.gen(function* () {
      const { ops } = hidingOps();
      const refusing = {
        ...ops,
        update: (input: { readonly id: string }) =>
          Effect.fail(new ServerErrors.NotFound({ resource: "people", id: input.id })),
        delete: (id: string) => Effect.fail(new ServerErrors.NotFound({ resource: "people", id })),
      };
      const { handlers, cacheStore } = build(refusing);
      expect(
        yield* failure(handlers.update(renameFirst).pipe(Effect.provide(admin))),
      ).toBeInstanceOf(ServerErrors.NotFound);
      expect(
        yield* failure(handlers.delete({ params: { id: ids(2) } }).pipe(Effect.provide(admin))),
      ).toBeInstanceOf(ServerErrors.NotFound);
      expect(Option.getOrUndefined(MutableHashMap.get(cacheStore, ids(1)))?.attributes.name).toBe(
        "Public",
      );
      expect(Option.getOrUndefined(MutableHashMap.get(cacheStore, ids(2)))?.attributes.name).toBe(
        "Public",
      );
    }),
  );

  describe("with a hiddenWrite rule", () => {
    const hiddenWrite = {
      type: "people",
      when: (error: ServerErrors.NotFound | StoreDown) => error instanceof ServerErrors.NotFound,
    } as const;

    it.effect(
      "answers a hidden update with the committed identifier and version, after evicting",
      () =>
        Effect.gen(function* () {
          const { ops } = hidingOps();
          const { handlers, cacheStore } = build(ops, { hiddenWrite });
          const document = yield* success(handlers.update(renameFirst).pipe(Effect.provide(admin)));
          expect(document).toEqual({
            data: { type: "people", id: ids(1), meta: { version: 7 } },
            jsonapi: { version: "1.1" },
          });
          expect(MutableHashMap.has(cacheStore, ids(1))).toBe(false);
        }),
    );

    it.effect(
      "answers a hidden create the same way, and omits meta when the op reports no version",
      () =>
        Effect.gen(function* () {
          const { ops } = hidingOps();
          const created = yield* success(
            build(ops, { hiddenWrite })
              .handlers.create({ payload: { name: "Delta" } })
              .pipe(Effect.provide(admin)),
          );
          expect(created).toEqual({
            data: { type: "people", id: ids(4), meta: { version: 1 } },
            jsonapi: { version: "1.1" },
          });
          const versionless = {
            ...ops,
            create: (input: { readonly name: string }) =>
              Effect.map(ops.create(input), ({ id }) => ({ id })),
          };
          const bare = yield* success(
            build(versionless, { hiddenWrite })
              .handlers.create({ payload: { name: "Echo" } })
              .pipe(Effect.provide(admin)),
          );
          expect(bare.data).toEqual({ type: "people", id: ids(5) });
        }),
    );

    // Only the re-read is asked: a write the operation itself refuses never
    // committed, so it fails as refused, whatever the rule would say.
    it.effect(
      "fails a create / update the operation refuses, even with a rule that names everything",
      () =>
        Effect.gen(function* () {
          const { ops } = hidingOps();
          const refused = (id: string) => new ServerErrors.NotFound({ resource: "people", id });
          const refusing = {
            ...ops,
            create: (_input: { readonly name: string }) => Effect.fail(refused(ids(4))),
            update: (input: UpdateInput) => Effect.fail(refused(input.id)),
          };
          const { handlers, cacheStore } = build(refusing, {
            hiddenWrite: { type: "people", when: () => true },
          });
          // `failure` fails the test on a success, so no committed document went out.
          expect(
            yield* failure(
              handlers.create({ payload: { name: "Delta" } }).pipe(Effect.provide(admin)),
            ),
          ).toEqual(refused(ids(4)));
          expect(yield* failure(handlers.update(renameFirst).pipe(Effect.provide(admin)))).toEqual(
            refused(ids(1)),
          );
          expect(
            Option.getOrUndefined(MutableHashMap.get(cacheStore, ids(1)))?.attributes.name,
          ).toBe("Public");
        }),
    );

    it.effect("fails with the whole cause when the rule names only some of its failures", () =>
      Effect.gen(function* () {
        const { ops } = hidingOps((id) =>
          Effect.failCause(
            Cause.combine(
              Cause.fail(new ServerErrors.NotFound({ resource: "people", id })),
              Cause.fail(new StoreDown()),
            ),
          ),
        );
        const { handlers, cacheStore } = build(ops, { hiddenWrite });
        const exit = yield* Effect.exit(handlers.update(renameFirst).pipe(Effect.provide(admin)));
        expect(Exit.isFailure(exit) && exit.cause.reasons.length).toBe(2);
        expect(MutableHashMap.has(cacheStore, ids(1))).toBe(false);
      }),
    );

    it.effect(
      "fails with the empty cause, rather than hiding it, when the re-read fails with no reason",
      () =>
        Effect.gen(function* () {
          const { ops } = hidingOps(() => Effect.failCause(Cause.empty));
          const { handlers, cacheStore } = build(ops, {
            hiddenWrite: { type: "people", when: () => true },
          });
          const exit = yield* Effect.exit(handlers.update(renameFirst).pipe(Effect.provide(admin)));
          expect(Exit.isFailure(exit) && exit.cause.reasons.length).toBe(0);
          expect(MutableHashMap.has(cacheStore, ids(1))).toBe(false);
        }),
    );

    // `version` is `unknown`: what reaches the wire is a string or a finite
    // number as is, a bigint as its decimal string, and nothing else.
    it.effect.each([
      ["a bigint", 12n, { version: "12" }],
      ["a string", "v3", { version: "v3" }],
      ["NaN", Number.NaN, undefined],
      ["positive infinity", Number.POSITIVE_INFINITY, undefined],
      ["negative infinity", Number.NEGATIVE_INFINITY, undefined],
      ["an object", { revision: 3 }, undefined],
    ])(
      "echoes a version that is %s as meta.version only when it has a wire form",
      ([_, version, meta]) =>
        Effect.gen(function* () {
          const { ops } = hidingOps();
          const versioned = {
            ...ops,
            create: (input: { readonly name: string }) =>
              Effect.map(ops.create(input), ({ id }) => ({ id, version })),
          };
          const created = yield* success(
            build(versioned, { hiddenWrite })
              .handlers.create({ payload: { name: "Delta" } })
              .pipe(Effect.provide(admin)),
          );
          expect(created.data).toEqual(
            meta === undefined
              ? { type: "people", id: ids(4) }
              : { type: "people", id: ids(4), meta },
          );
        }),
    );

    it.effect("still fails with a re-read error the rule does not name", () =>
      Effect.gen(function* () {
        const { ops } = hidingOps(() => new StoreDown());
        const { handlers, cacheStore } = build(ops, { hiddenWrite });
        expect(
          yield* failure(handlers.update(renameFirst).pipe(Effect.provide(admin))),
        ).toBeInstanceOf(StoreDown);
        expect(MutableHashMap.has(cacheStore, ids(1))).toBe(false);
      }),
    );

    it.effect(
      "answers the full document, and writes it through, when the writer can still read the row",
      () =>
        Effect.gen(function* () {
          const { ops, hidden } = hidingOps();
          const visible = {
            ...ops,
            update: (input: UpdateInput) =>
              Effect.tap(ops.update(input), () => Effect.sync(() => void hidden.splice(0))),
          };
          const { handlers, cacheStore } = build(visible, { hiddenWrite });
          const document = yield* success(handlers.update(renameFirst).pipe(Effect.provide(admin)));
          expect(document.data).toMatchObject({ id: ids(1), attributes: { name: "Private" } });
          expect(
            Option.getOrUndefined(MutableHashMap.get(cacheStore, ids(1)))?.attributes.name,
          ).toBe("Private");
        }),
    );
  });
});

describe("get", () => {
  it.effect(
    "serves a non-admin from the cache when the entry is there, and populates it on a miss",
    () =>
      Effect.gen(function* () {
        const { ops, calls } = seeded();
        const { handlers, cacheStore } = handlersFor(ops);
        const layer = as(Option.some(USER));
        const first = yield* handlers.get({ params: { id: ids(2) } }).pipe(Effect.provide(layer));
        expect(first.data.attributes.name).toBe("Beta");
        expect(first.data.meta).toEqual({ canEdit: false, canDelete: false });
        expect(calls.get).toBe(1);
        expect(MutableHashMap.has(cacheStore, ids(2))).toBe(true);
        const second = yield* handlers.get({ params: { id: ids(2) } }).pipe(Effect.provide(layer));
        expect(second.data.id).toBe(ids(2));
        expect(calls.get).toBe(1);
      }),
  );

  it.effect(
    "bypasses the cache for an admin (freshness) and degrades a cache fault to the operation",
    () =>
      Effect.gen(function* () {
        const { ops, calls } = seeded();
        const { handlers, cacheStore, state } = handlersFor(ops);
        MutableHashMap.set(cacheStore, ids(1), person(ids(1), "Stale"));
        const admin = yield* handlers
          .get({ params: { id: ids(1) } })
          .pipe(Effect.provide(as(Option.some(ADMIN))));
        expect(admin.data.attributes.name).toBe("Alpha");
        expect(calls.get).toBe(1);
        state.getFails = true;
        const anon = yield* handlers
          .get({ params: { id: ids(1) } })
          .pipe(Effect.provide(as(Option.none())));
        expect(anon.data.attributes.name).toBe("Alpha");
        expect(calls.get).toBe(2);
      }),
  );

  it.effect("answers NotFound for an unknown id", () =>
    Effect.gen(function* () {
      const { ops } = seeded();
      const { handlers } = handlersFor(ops);
      const error = yield* failure(
        handlers.get({ params: { id: ids(9) } }).pipe(Effect.provide(as(Option.some(USER)))),
      );
      expect(error._tag).toBe("NotFound");
    }),
  );

  it.effect("resolves `?include=` through the target registry, and refuses an unlisted path", () =>
    Effect.gen(function* () {
      const { ops } = seeded();
      const { handlers } = handlersFor(ops);
      targetCalls.length = 0;
      const document = yield* handlers
        .get({ params: { id: ids(1) }, query: { include: ["birthPlace"] } })
        .pipe(Effect.provide(as(Option.some(USER))));
      expect(document.included?.map((r) => `${r.type}:${r.id}`)).toEqual([`places:${PLACE}`]);
      expect(targetCalls).toEqual([[PLACE]]);
      const error = yield* failure(
        handlers
          .get({ params: { id: ids(1) }, query: { include: ["nope"] } })
          .pipe(Effect.provide(as(Option.some(USER)))),
      );
      expect(error).toBeInstanceOf(ApiError.UnsupportedIncludePath);
    }),
  );
});

describe("list", () => {
  it.effect("emits the page's pagination links and total, and stamps capabilities per viewer", () =>
    Effect.gen(function* () {
      const { ops } = seeded();
      const { handlers } = handlersFor(ops);
      const document = yield* handlers
        .list({ query: { limit: 1, offset: 1 } })
        .pipe(Effect.provide(as(Option.some(ADMIN))));
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
      const anon = yield* handlers.list({ query: {} }).pipe(Effect.provide(as(Option.none())));
      expect(anon.data).toHaveLength(3);
      expect(anon.data[0]?.meta).toEqual({ canEdit: false, canDelete: false });
      // One page holds everything: the spec's "no such page" is a `null` link.
      expect(anon.links).toMatchObject({ next: null, prev: null });
    }),
  );

  it.effect("resolves a page's include walk in one batch per target type, deduplicated", () =>
    Effect.gen(function* () {
      const { ops } = seeded();
      const { handlers } = handlersFor(ops);
      targetCalls.length = 0;
      const document = yield* handlers
        .list({ query: { include: ["birthPlace"] } })
        .pipe(Effect.provide(as(Option.some(USER))));
      // Three people share one birthplace: one loader call, one id, one member.
      expect(targetCalls).toEqual([[PLACE]]);
      expect(document.included?.map((r) => r.id)).toEqual([PLACE]);
      expect(document.included?.[0]?.meta).toEqual({ canEdit: false, canDelete: false });
      const plain = yield* handlers.list({ query: {} }).pipe(Effect.provide(as(Option.some(USER))));
      expect(plain).not.toHaveProperty("included");
    }),
  );

  it.effect("stamps the page only when `capabilitiesOnIncluded` is false", () =>
    Effect.gen(function* () {
      const { ops } = seeded();
      const { handlers } = handlersFor(ops, { capabilitiesOnIncluded: false });
      const document = yield* handlers
        .list({ query: { include: ["birthPlace"] } })
        .pipe(Effect.provide(as(Option.some(ADMIN))));
      expect(document.data[0]?.meta).toEqual({ canEdit: true, canDelete: true });
      expect(document.included?.map((r) => r.id)).toEqual([PLACE]);
      expect(document.included?.[0]).not.toHaveProperty("meta");
    }),
  );

  /**
   * One test per axis the links have to carry, each asserting the parameter
   * reaches all five links: a client paginates by `next` / `prev`, and
   * `first` / `last` are the jump targets.
   */
  describe("carries the request's whole query into every link", () => {
    const LINK_NAMES = ["self", "first", "prev", "next", "last"] as const;
    const linksFor = (query: ListInput) =>
      Effect.gen(function* () {
        const { ops } = seeded();
        const { handlers } = handlersFor(ops);
        const document = yield* handlers
          .list({ query })
          .pipe(Effect.provide(as(Option.some(USER))));
        return yield* Effect.forEach(
          LINK_NAMES,
          (name) => {
            const link = document.links[name];
            return P.isString(link)
              ? Effect.succeed(link)
              : Effect.die(`the \`${name}\` link is missing`);
          },
          { concurrency: 1 },
        );
      });

    it.effect("carries `?include=` and a `filter[…]` member into all five links", () =>
      Effect.gen(function* () {
        const included = yield* linksFor({ limit: 1, offset: 1, include: ["birthPlace"] });
        Arr.forEach(included, (link) => {
          expect(link).toContain("include=birthPlace");
        });
        const filtered = yield* linksFor({ limit: 1, offset: 1, q: "a" });
        Arr.forEach(filtered, (link) => {
          expect(link).toContain("filter[q]=a");
        });
      }),
    );

    it.effect(
      "replaces the request's own `page[*]` cursor rather than appending, canonically ordered",
      () =>
        Effect.gen(function* () {
          const [self, , , next] = yield* linksFor({
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
        }),
    );
  });
});

describe("readOnly", () => {
  it.effect("exposes exactly `list` and `get`, with no cache or viewer wired", () =>
    Effect.gen(function* () {
      const { ops, calls } = seeded();
      const handlers = ResourceHandlers.readOnly({
        ops,
        segment: "people",
        listQuery: peopleListQuery,
        linkBase: Effect.succeed("https://example.test"),
      });
      expect(Arr.sort(R.keys(handlers), Order.String)).toEqual(["get", "list"]);
      const document = yield* handlers.get({ params: { id: ids(1) } });
      expect(document.data.id).toBe(ids(1));
      expect(document.data).not.toHaveProperty("meta");
      expect(calls.get).toBe(1);
    }),
  );
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

  it.effect(
    "answers a to-many as a paginated collection of only the page's refs, dropping unresolved ones",
    () =>
      Effect.gen(function* () {
        calls.length = 0;
        const handler = ResourceHandlers.related({
          ...config,
          key: "candidates",
          cardinality: "many",
        });
        const document = (yield* handler({
          params: { id: "c1" },
          query: { limit: 2, offset: 0 },
        })) as Assemble.CollectionDocument<Assemble.ResourceLike>;
        expect(calls).toEqual([["k1", "k2"]]);
        expect(document.data.map((r) => r.id)).toEqual(["k1"]);
        expect(document.meta.totalCount).toBe(3);
        expect(document.links.self).toBe(
          "https://example.test/contests/c1/candidates?page[offset]=0&page[limit]=2",
        );
      }),
  );

  it.effect.each(["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"])(
    "drops a ref typed %s, an Object.prototype member, as it does any type with no target",
    (type) =>
      Effect.gen(function* () {
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
        expect(yield* one({ params: { id: "c1" } })).toEqual({
          data: null,
          jsonapi: { version: "1.1" },
        });
      }),
  );

  it.effect("answers a to-one as the related resource, or `data: null` for empty linkage", () =>
    Effect.gen(function* () {
      const one = ResourceHandlers.related({ ...config, key: "election", cardinality: "one" });
      const document = (yield* one({
        params: { id: "c1" },
      })) as Assemble.ResourceDocument<Assemble.ResourceLike>;
      expect(document.data).toMatchObject({ type: "elections", id: "e1" });
      const empty = ResourceHandlers.related({ ...config, key: "polity", cardinality: "one" });
      expect(yield* empty({ params: { id: "c1" } })).toEqual({
        data: null,
        jsonapi: { version: "1.1" },
      });
    }),
  );

  it.effect(
    "answers an empty to-one with `included: []` when the request carried `include` (#232)",
    () =>
      Effect.gen(function* () {
        // §Fetching Includes: a request carrying `include` gets the `included` key,
        // even when there is no related resource to walk from.
        const empty = ResourceHandlers.related({
          ...config,
          key: "polity",
          cardinality: "one",
          includable: ["country", "country.capital.mayor"],
        });
        const [withPath, threeHops, bareInclude, withoutInclude] = yield* Effect.all(
          [
            empty({ params: { id: "c1" }, query: { include: ["country"] } }),
            // A path at the default depth limit (3 hops) is accepted.
            empty({ params: { id: "c1" }, query: { include: ["country.capital.mayor"] } }),
            // `?include=` (no paths) is still a request that carried `include`.
            empty({ params: { id: "c1" }, query: { include: [] } }),
            empty({ params: { id: "c1" }, query: {} }),
          ],
          { concurrency: 1 },
        );
        expect(withPath).toEqual({ data: null, included: [], jsonapi: { version: "1.1" } });
        expect(threeHops).toEqual({ data: null, included: [], jsonapi: { version: "1.1" } });
        expect(bareInclude).toEqual({ data: null, included: [], jsonapi: { version: "1.1" } });
        // Without `include` the key stays absent.
        expect(withoutInclude).not.toHaveProperty("included");
      }),
  );

  it.effect("validates an empty to-one's include paths, as it does a resolved one's", () =>
    Effect.gen(function* () {
      const empty = ResourceHandlers.related({
        ...config,
        key: "polity",
        cardinality: "one",
        includable: ["country"],
      });
      expect(
        yield* failure(empty({ params: { id: "c1" }, query: { include: ["nope"] } })),
      ).toBeInstanceOf(ApiError.UnsupportedIncludePath);
      expect(
        yield* failure(empty({ params: { id: "c1" }, query: { include: ["a.b.c.d"] } })),
      ).toBeInstanceOf(ApiError.UnsupportedIncludeDepth);
      // With no `includable` configured, no path is includable.
      const closed = ResourceHandlers.related({ ...config, key: "polity", cardinality: "one" });
      expect(
        yield* failure(closed({ params: { id: "c1" }, query: { include: ["country"] } })),
      ).toBeInstanceOf(ApiError.UnsupportedIncludePath);
    }),
  );
});
