/**
 * The server handler factory: the standard JSON:API `list` / `get` /
 * `create` / `update` / `delete` handler set for a flat-table resource — the
 * handler-side counterpart of `Group.flat` / `Group.flatReadOnly`, keyed by
 * the endpoint names those presets declare — plus the §7.4 related-resource
 * handler for `Endpoint.flatRelated`.
 *
 * Handlers receive the decoded endpoint request parts (`params` / `query` /
 * `payload`); input validation lives in the endpoint schemas, so the
 * handlers stay validation-free. Each one is an `Effect.fn` named
 * `api.<segment>.<operation>`, so request traces show which endpoint ran.
 *
 * Everything an application owns is a parameter, not an import:
 *
 * - **the operations** ({@link Ops} / {@link ReadOnlyOps}) — the
 *   Effect-native reads and writes, with whatever error and service channels
 *   they carry; the handlers add only the walk's and the seam's own;
 * - **the viewer** — an effect yielding the request's viewer, threaded into
 *   the capability hook;
 * - **the link base** — an effect yielding the absolute origin the
 *   pagination links are built under;
 * - **the transaction** — {@link Config.transact}, the one seam that opens
 *   the boundary a write runs in. No operation opens a boundary of its own:
 *   each write requires an ambient transaction service, and `create` /
 *   `update` / `delete` supply it here, which makes that structural rather
 *   than conventional;
 * - **the cache** ({@link Cache}) — read-through on `get`, write-through on
 *   `create` / `update`, eviction on `delete` and on a write whose re-read
 *   fails;
 * - **the include walk** ({@link IncludeConfig}) — the family's whitelist
 *   and the loader registry, resolved batched on `get` *and* `list`;
 * - **the hidden write** ({@link HiddenWrite}) — which re-read failures mean
 *   the committed resource is hidden from its writer, answered with the
 *   {@link CommittedDocument} instead of the failure.
 *
 * @since 0.16.0
 */
import { Array as Arr, Cause, Effect, Exit, Option, Predicate, Ref } from "effect";
import * as ApiError from "./ApiError.js";
import * as Assemble from "./Assemble.js";
import type * as Handlers from "./Handlers.js";
import * as Query from "./Query.js";

// ---------------------------------------------------------------------------
// The operations
// ---------------------------------------------------------------------------

/**
 * A page of rows with its real, unpaged total — what a list operation
 * answers (`COUNT(*) OVER ()` alongside the page, at no extra round trip).
 *
 * @since 0.16.0
 * @category models
 */
export interface Page<T> {
  readonly items: ReadonlyArray<T>;
  readonly totalCount: number;
}

/**
 * The Effect-native read operations a resource's read surface is built over.
 *
 * @since 0.16.0
 * @category models
 */
export interface ReadOnlyOps<TList, TResource, TId extends string, E, R> {
  readonly list: (input: TList) => Effect.Effect<Page<TResource>, E, R>;
  readonly get: (id: TId) => Effect.Effect<TResource, E, R>;
}

/**
 * What a `create` / `update` operation answers: the written row's id and,
 * optionally, the version the write committed. The handlers re-read the row
 * by `id`; `version` reaches the wire only in the {@link CommittedDocument}
 * a hidden write answers with.
 *
 * @since 0.17.0
 * @category models
 */
export interface WriteResult<TId extends string> {
  readonly id: TId;
  /**
   * The committed version, echoed as `data.meta.version` when the re-read is
   * hidden. Any type is accepted, so an operation that already answered a
   * `version` of its own keeps compiling; only a string or a finite number
   * reaches the wire as is, a `bigint` as its decimal string, and anything
   * else is left out of `meta`.
   */
  readonly version?: unknown;
}

/**
 * The Effect-native operations a resource's full CRUD surface is built over.
 * The writes carry `RW` — the read services plus the ambient transaction
 * {@link Config.transact} supplies.
 *
 * @since 0.16.0
 * @category models
 */
export interface Ops<
  TList,
  TCreate,
  TUpdate,
  TResource,
  TId extends string,
  E,
  R,
  RW,
> extends ReadOnlyOps<TList, TResource, TId, E, R> {
  readonly create: (input: TCreate) => Effect.Effect<WriteResult<TId>, E, RW>;
  readonly update: (input: TUpdate) => Effect.Effect<WriteResult<TId>, E, RW>;
  readonly delete: (id: TId) => Effect.Effect<unknown, E, RW>;
}

/**
 * The transaction seam: wraps a write in the boundary it runs in, supplying
 * the ambient transaction service `Tx` (and adding the boundary's own
 * failures `ET` and services `RT`).
 *
 * @since 0.16.0
 * @category models
 */
export type Transact<Tx, ET, RT> = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | ET, Exclude<R, Tx> | RT>;

/**
 * A resource cache the handlers read through and write through. Every
 * member is best-effort — the error channel is `never`, so a cache fault
 * degrades to the operation rather than adding a failure mode.
 *
 * @since 0.16.0
 * @category models
 */
export interface Cache<TResource, RC> {
  readonly set: (id: string, resource: TResource) => Effect.Effect<void, never, RC>;
  readonly delete: (id: string) => Effect.Effect<void, never, RC>;
  /** Read-through: `load`'s own channels pass through, with the cache's services added. */
  readonly readThrough: <E, R>(
    id: string,
    load: Effect.Effect<TResource, E, R>,
  ) => Effect.Effect<TResource, E, R | RC>;
}

/**
 * The `?include=` configuration a family's handlers take.
 *
 * @since 0.16.0
 * @category models
 */
export interface IncludeConfig<Targets extends Handlers.IncludeTargets> {
  /**
   * The legal include paths — the family's `Include.make(...).paths`, so the
   * whitelist the handler enforces and the `included` union the endpoint
   * declares are one declaration. Anything else is
   * `ApiError.UnsupportedIncludePath`.
   */
  readonly includable: ReadonlyArray<string>;
  /** The loader registry the walk resolves through (`Handlers.IncludeTargets`). */
  readonly targets: Targets;
  /** The maximum number of hops. Defaults to `Assemble.MAX_INCLUDE_DEPTH`. */
  readonly depth?: number | undefined;
  /** How many loader calls of one level may run at once. Defaults to unbounded. */
  readonly concurrency?: number | "unbounded" | undefined;
}

/**
 * A list endpoint's wire query, named by the decoded shape a handler
 * consumes — what `Group.flat` / `Group.flatReadOnly` return as `listQuery`.
 *
 * @since 0.16.0
 * @category models
 */
export interface ListQuery<TQuery> extends Query.FlatQuerySchema {
  readonly Type: TQuery;
}

/**
 * The declarations a read-only family's handlers are built from.
 *
 * @since 0.16.0
 * @category models
 */
export interface ReadOnlyConfig<
  TQuery,
  TResource extends Assemble.ResourceLike,
  TId extends string,
  V,
  E,
  R,
  RV,
  RL,
  RC,
  Targets extends Handlers.IncludeTargets,
> {
  /**
   * The family's operations. `list` receives the decoded `listQuery` — the
   * flat list input — so an operation typed by a *different* input than the
   * one the endpoint decodes is a compile error at this seam.
   */
  readonly ops: ReadOnlyOps<NoInfer<TQuery>, TResource, TId, E, R>;
  /** The URL path segment the pagination links are built under (`"contests"`). */
  readonly segment: string;
  /**
   * The family's **`list` wire query** — the `listQuery` the group preset
   * returned alongside the group, so the two are the same schema. Every
   * collection link is spelled from it (`Query.canonicalPairs`): `?include=`,
   * each `?filter[…]=`, `?sort=` ride into all five links beside the page
   * cursor. Required, so a family cannot serve cursor-only links that
   * silently re-scope the collection on the next page.
   */
  readonly listQuery: ListQuery<TQuery>;
  /** The absolute origin the links are built under (`"https://example.test"`). */
  readonly linkBase: Effect.Effect<string, never, RL>;
  /** The request's viewer, for the capability hook. Omit for none. */
  readonly viewer?: Effect.Effect<V, never, RV> | undefined;
  /** The capability rule every emitted resource is stamped with. Omit for no stamp. */
  readonly capabilities?: Assemble.CapabilitiesHook<V> | undefined;
  /** Read-through on `get`; write-through and eviction on the writes. */
  readonly cache?: Cache<TResource, RC> | undefined;
  /** The `?include=` walk on `get` and `list`. */
  readonly include?: IncludeConfig<Targets> | undefined;
  /**
   * The page size a collection reports when the query names no `limit` (a
   * query whose `limit` is defaulted on decode never reaches this). Defaults
   * to `100`.
   */
  readonly maxPageLimit?: number | undefined;
}

/**
 * The declarations a CRUD family's handlers are built from.
 *
 * @since 0.16.0
 * @category models
 */
export interface Config<
  TQuery,
  TCreate,
  TUpdate extends { readonly id: TId },
  TResource extends Assemble.ResourceLike,
  TId extends string,
  V,
  E,
  R,
  RW,
  RV,
  RL,
  RC,
  Targets extends Handlers.IncludeTargets,
  Tx,
  ET,
  RT,
  HType extends TResource["type"] = never,
> extends ReadOnlyConfig<TQuery, TResource, TId, V, E, R, RV, RL, RC, Targets> {
  readonly ops: Ops<NoInfer<TQuery>, TCreate, TUpdate, TResource, TId, E, R, RW>;
  /**
   * The transaction seam every write runs inside. Omit for none: each
   * operation is then its own (autocommitted) write, and an interrupt that
   * lands after it commits but before it returns its result is seen as a
   * write that never succeeded, so it evicts nothing (see {@link make}).
   */
  readonly transact?: Transact<Tx, ET, RT> | undefined;
  /**
   * Which failures of the post-write re-read mean the committed resource is
   * hidden from its writer, answered with a {@link CommittedDocument} rather
   * than the failure. Omit to fail the write with the re-read's error, as a
   * group without `Group.flat`'s `hiddenWrites` declares.
   */
  // oxlint-disable-next-line effect/prefer-option-over-null -- the `?: T | undefined` spelling AGENTS.md requires under exactOptionalPropertyTypes, as the sibling options do
  readonly hiddenWrite?: HiddenWrite<NoInfer<E>, HType> | undefined;
}

/**
 * Declares when a committed `create` / `update` is **hidden** from its own
 * writer: the write committed, but the re-read the handler runs as that
 * writer fails (a read scope or visibility rule the write itself tripped).
 * Answering that failure — a 404 for a write that committed — invites a
 * retry that duplicates a create, so the handler answers the
 * {@link CommittedDocument} instead: `201` / `200` with the resource's
 * identifier and the committed `version`, and no attributes.
 *
 * Pair it with `Group.flat({ …, hiddenWrites: true })`, whose `create` /
 * `update` success then admits that document.
 *
 * @since 0.17.0
 * @category models
 */
export interface HiddenWrite<E, TType extends string = string> {
  /** The resource type the {@link CommittedDocument}'s `data.type` names. */
  readonly type: TType;
  /**
   * Whether a re-read failure means "hidden" (typically the operation's
   * not-found error). Only a plain failure is asked: a defect or an
   * interruption always propagates, and so does a failure this rejects. A
   * cause carrying several failures is hidden only when this accepts every
   * one of them.
   */
  readonly when: (error: E) => boolean;
}

/**
 * The success document of a committed `create` / `update` whose resource is
 * hidden from its writer ({@link HiddenWrite}): the resource object reduced
 * to its `type` and `id`, with `meta.version` when the operation reported
 * one ({@link WriteResult.version}). A resource object's `attributes` and `relationships` are optional
 * members (JSON:API 1.1 §Resource Objects), so this is still the created or
 * updated resource as primary data — the same members a sparse fieldset
 * that names no fields leaves. It carries no `links.self`, so a `201` built
 * from it has no `Location` (a SHOULD).
 *
 * This is the **value** a handler answers with; `Endpoint.CommittedDocument`
 * is the **schema** that encodes it on the wire (and that
 * `Endpoint.WriteDocument` / `Group.flat({ …, hiddenWrites: true })`
 * declare) — the same split as `Assemble.ResourceDocument` and
 * `Endpoint.ResourceDocument`.
 *
 * @since 0.17.0
 * @category models
 */
export interface CommittedDocument<TType extends string = string, TId extends string = string> {
  readonly data: {
    readonly type: TType;
    readonly id: TId;
    readonly meta?: { readonly version: string | number };
  };
  readonly jsonapi: typeof Assemble.JSONAPI_MEMBER;
}

// ---------------------------------------------------------------------------
// The handlers
// ---------------------------------------------------------------------------

/**
 * The decoded request of a `get`: the id, and the open `?include=` when the
 * endpoint declares it.
 *
 * @since 0.16.0
 * @category models
 */
export interface GetRequest<TId extends string> {
  readonly params: { readonly id: TId };
  readonly query?: { readonly include?: ReadonlyArray<string> | undefined } | undefined;
}

/** The failures a read handler adds to the operation's own. */
type ReadError<E, Targets extends Handlers.IncludeTargets> =
  | E
  | Assemble.IncludeError
  | Handlers.IncludeTargetError<Targets>;

/**
 * The `list` + `get` handlers {@link readOnly} builds.
 *
 * @since 0.16.0
 * @category models
 */
export type ReadOnlyHandlers<
  TResource extends Assemble.ResourceLike,
  TId extends string,
  TQuery,
  E,
  R,
  RV,
  RL,
  RC,
  Targets extends Handlers.IncludeTargets,
> = {
  readonly list: (request: {
    readonly query: TQuery;
  }) => Effect.Effect<
    Assemble.CollectionDocument<TResource>,
    ReadError<E, Targets>,
    R | RV | RL | Handlers.IncludeTargetServices<Targets>
  >;
  readonly get: (
    request: GetRequest<TId>,
  ) => Effect.Effect<
    Assemble.ResourceDocument<TResource>,
    ReadError<E, Targets>,
    R | RV | RC | Handlers.IncludeTargetServices<Targets>
  >;
};

/**
 * The five handlers {@link make} builds. `Committed` is what a
 * {@link Config.hiddenWrite} adds to `create` / `update`'s success — the
 * {@link CommittedDocument} — and `never` without one.
 *
 * @since 0.16.0
 * @category models
 */
export type CrudHandlers<
  TCreate,
  TUpdate,
  TResource extends Assemble.ResourceLike,
  TId extends string,
  TQuery,
  E,
  R,
  RW,
  RV,
  RL,
  RC,
  Targets extends Handlers.IncludeTargets,
  Tx,
  ET,
  RT,
  Committed = never,
> = ReadOnlyHandlers<TResource, TId, TQuery, E, R, RV, RL, RC, Targets> & {
  readonly create: (request: {
    readonly payload: TCreate;
  }) => Effect.Effect<
    Assemble.ResourceDocument<TResource> | Committed,
    E | ET,
    R | RV | RC | RT | Exclude<RW, Tx>
  >;
  readonly update: (request: {
    readonly params: { readonly id: TId };
    readonly payload: TUpdate;
  }) => Effect.Effect<
    Assemble.ResourceDocument<TResource> | Committed,
    E | ET | ApiError.Conflict,
    R | RV | RC | RT | Exclude<RW, Tx>
  >;
  readonly delete: (request: {
    readonly params: { readonly id: TId };
  }) => Effect.Effect<void, E | ET, RC | RT | Exclude<RW, Tx>>;
};

/**
 * Cross-checks the route `:id` against a `PATCH` payload's `id`, failing
 * `ApiError.Conflict` on a mismatch — JSON:API §7.6.2 requires the resource
 * object in a `PATCH` to carry `id`, and the server MUST answer `409 Conflict`
 * when it doesn't match the endpoint. The one seam every update handler
 * routes through, and the same class `Group.flat`'s `update` declares, so
 * the wire matches what the contract advertises.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { ResourceHandlers } from "@thomasfosterau/effect-jsonapi"
 *
 * console.log(Effect.runSync(Effect.flip(ResourceHandlers.assertIdMatchesPath("a", "b"))).detail)
 * // → URL id "a" does not match payload id "b".
 * ```
 *
 * @since 0.16.0
 * @category utils
 */
export const assertIdMatchesPath = (
  paramsId: string,
  payloadId: string,
): Effect.Effect<void, ApiError.Conflict> =>
  paramsId === payloadId
    ? Effect.void
    : new ApiError.Conflict({
        detail: `URL id "${paramsId}" does not match payload id "${payloadId}".`,
      });

const identityTransact: Transact<never, never, never> = (effect) => effect;

const none = Effect.succeed(undefined);

/**
 * Builds the `list` / `get` handlers for a read-only resource, keyed by the
 * endpoint names `Group.flatReadOnly` declares.
 *
 * `list` resolves the page's `?include=` walk **before** the assembler, one
 * loader call per distinct target type per level across the whole page;
 * `get` reads through the cache when one is wired, and walks its include
 * from the (cached or fresh) primary resource's linkage.
 *
 * @example
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { FlatQuery, Group, Resource, ResourceHandlers } from "@thomasfosterau/effect-jsonapi"
 *
 * const Contest = Resource.make("contests", { attributes: { name: Schema.NonEmptyString } })
 * const { listQuery } = Group.flatReadOnly({
 *   resource: Contest,
 *   list: FlatQuery.listInput({ maxLimit: 100 })
 * })
 * const rows = [{ type: "contests", id: "1", attributes: { name: "Bennelong" } }]
 *
 * const handlers = ResourceHandlers.readOnly({
 *   segment: "contests",
 *   listQuery,
 *   linkBase: Effect.succeed("https://example.test"),
 *   ops: {
 *     list: () => Effect.succeed({ items: rows, totalCount: 1 }),
 *     get: (id) => Effect.succeed(rows[0]!)
 *   }
 * })
 * const document = Effect.runSync(handlers.list({ query: { offset: 0, limit: 10 } }))
 * console.log(document.meta.totalCount, document.links.self)
 * // → 1 https://example.test/contests?page[offset]=0&page[limit]=10
 * ```
 *
 * @since 0.16.0
 * @category constructors
 */
export const readOnly = <
  TQuery,
  TResource extends Assemble.ResourceLike,
  TId extends string = string,
  V = undefined,
  E = never,
  R = never,
  RV = never,
  RL = never,
  RC = never,
  Targets extends Handlers.IncludeTargets = never,
>(
  config: ReadOnlyConfig<TQuery, TResource, TId, V, E, R, RV, RL, RC, Targets>,
): ReadOnlyHandlers<TResource, TId, TQuery, E, R, RV, RL, RC, Targets> => {
  const { ops, segment, cache, include, capabilities } = config;
  const maxPageLimit = config.maxPageLimit ?? 100;
  const viewer = (config.viewer ?? none) as Effect.Effect<V, never, RV>;
  // Built once per family: `Query.canonicalPairs` returns the encoder-bound
  // function, and nothing about it varies by request.
  const linkPairs = Query.canonicalPairs(config.listQuery);
  const assemble = {
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(include === undefined
      ? {}
      : {
          includable: include.includable,
          targets: include.targets,
          depth: include.depth,
          concurrency: include.concurrency,
        }),
  };

  const list = Effect.fn(`api.${segment}.list`)(function* ({ query }: { readonly query: TQuery }) {
    const base = yield* config.linkBase;
    const page = yield* ops.list(query);
    const window = query as {
      readonly limit?: number;
      readonly offset?: number;
      readonly include?: ReadonlyArray<string>;
    };
    const limit = window.limit ?? Math.min(Math.max(page.items.length, 1), maxPageLimit);
    const offset = window.offset ?? 0;
    return yield* Assemble.collection(
      page.items,
      {
        totalCount: page.totalCount,
        offset,
        limit,
        baseUrl: `${base}/${segment}`,
        // Everything the caller asked for that is not the page cursor, so
        // `next` is the *same* query on the next page.
        query: linkPairs(query),
      },
      { ...assemble, viewer: yield* viewer, include: window.include },
    );
  });

  const get = Effect.fn(`api.${segment}.get`)(function* ({ params, query }: GetRequest<TId>) {
    const resource =
      cache === undefined
        ? yield* ops.get(params.id)
        : yield* cache.readThrough(params.id, ops.get(params.id));
    return yield* Assemble.resource(resource, {
      ...assemble,
      viewer: yield* viewer,
      include: query?.include,
    });
  });

  return { list, get } as unknown as ReadOnlyHandlers<
    TResource,
    TId,
    TQuery,
    E,
    R,
    RV,
    RL,
    RC,
    Targets
  >;
};

/**
 * Builds the `list` / `get` / `create` / `update` / `delete` handlers for an
 * editable resource, keyed by the endpoint names `Group.flat` declares. On
 * top of {@link readOnly}: every write runs inside {@link Config.transact},
 * re-reads the row and writes the fresh resource through the cache;
 * `update` cross-checks the payload `id` against the route
 * ({@link assertIdMatchesPath}) before touching the operation; `delete`
 * evicts the cache entry and answers nothing (the endpoint's 204).
 *
 * A write's commit and its cache step are not separable by an interrupt:
 * once the operation has succeeded, a later failure of the transaction (an
 * interruption included) evicts the entry, since the write may have
 * committed, and so does any failure of the re-read, whose cause then
 * propagates unchanged. A write the operation itself refuses never touches
 * the cache. With {@link Config.hiddenWrite}, a re-read failure it names is
 * answered with the {@link CommittedDocument} instead (after the eviction).
 *
 * "Once the operation has succeeded" is when it *returns*. Inside a
 * {@link Config.transact} that is before the commit, so the window is closed;
 * without one, the operation autocommits, and an interrupt landing after its
 * commit but before it returns (or before its result is recorded) leaves a
 * committed write that evicts nothing. Supply a `transact` where that window
 * matters.
 *
 * @example
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { FlatQuery, Group, Resource, ResourceHandlers } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", { attributes: { name: Schema.NonEmptyString } })
 * const { listQuery } = Group.flat({
 *   resource: Person,
 *   list: FlatQuery.listInput({ maxLimit: 100 }),
 *   create: Schema.Struct({ name: Schema.NonEmptyString }),
 *   update: Schema.Struct({ id: Schema.String, name: Schema.optionalKey(Schema.NonEmptyString) })
 * })
 * const store = new Map([["1", { type: "people", id: "1", attributes: { name: "Ada" } }]])
 *
 * const handlers = ResourceHandlers.make({
 *   segment: "people",
 *   listQuery,
 *   linkBase: Effect.succeed("https://example.test"),
 *   ops: {
 *     list: () => Effect.succeed({ items: [...store.values()], totalCount: store.size }),
 *     get: (id) => Effect.succeed(store.get(id)!),
 *     create: () => Effect.succeed({ id: "1" }),
 *     update: (input: { readonly id: string; readonly name?: string }) => Effect.succeed({ id: input.id }),
 *     delete: () => Effect.void
 *   }
 * })
 * const mismatch = handlers.update({ params: { id: "1" }, payload: { id: "2" } })
 * console.log(Effect.runSync(Effect.flip(mismatch))._tag)
 * // → Conflict
 * ```
 *
 * @since 0.16.0
 * @category constructors
 */
export const make = <
  TQuery,
  TCreate,
  TUpdate extends { readonly id: TId },
  TResource extends Assemble.ResourceLike,
  TId extends string = string,
  V = undefined,
  E = never,
  R = never,
  RW = never,
  RV = never,
  RL = never,
  RC = never,
  Targets extends Handlers.IncludeTargets = never,
  Tx = never,
  ET = never,
  RT = never,
  HType extends TResource["type"] = never,
>(
  config: Config<
    TQuery,
    TCreate,
    TUpdate,
    TResource,
    TId,
    V,
    E,
    R,
    RW,
    RV,
    RL,
    RC,
    Targets,
    Tx,
    ET,
    RT,
    HType
  >,
): CrudHandlers<
  TCreate,
  TUpdate,
  TResource,
  TId,
  TQuery,
  E,
  R,
  RW,
  RV,
  RL,
  RC,
  Targets,
  Tx,
  ET,
  RT,
  Committed<NoInfer<HType>, TId>
> => {
  const { ops, segment, cache, capabilities } = config;
  const viewer = (config.viewer ?? none) as Effect.Effect<V, never, RV>;
  const transact = (config.transact ?? identityTransact) as Transact<Tx, ET, RT>;
  const hidden = config.hiddenWrite;
  const evict = (id: TId) => (cache === undefined ? Effect.void : cache.delete(id));

  /**
   * Runs a write in its transaction, interruptibly (`restore`), and evicts
   * `idOf`'s entry when the transaction fails *after* the operation
   * succeeded — the commit itself, or an interruption — since the write may
   * have committed. The eviction runs under the caller's mask. `written` is
   * set only once the operation has succeeded, so a write it refuses (a
   * gate, a precondition) never evicts, and a forbidden request can't bust
   * the cache. Without a `transact` the operation commits before it returns,
   * so an interrupt between the two is not seen here (documented on
   * {@link make}).
   */
  const commit = <A>(
    restore: <AX, EX, RX>(effect: Effect.Effect<AX, EX, RX>) => Effect.Effect<AX, EX, RX>,
    write: Effect.Effect<A, E, RW>,
    idOf: (result: A) => TId,
  ) =>
    Effect.flatMap(Ref.make(Option.none<TId>()), (written) =>
      restore(
        transact(Effect.tap(write, (result) => Ref.set(written, Option.some(idOf(result))))),
      ).pipe(
        Effect.onError(() =>
          Effect.flatMap(
            Ref.get(written),
            Option.match({ onNone: () => Effect.void, onSome: evict }),
          ),
        ),
      ),
    );

  /**
   * Commit, re-read, write through, assemble — the mutation, with no
   * interrupt gap between the commit and the cache step that follows it.
   * The write and the re-read stay interruptible; everything between and
   * after them runs to completion.
   */
  const commitAndWriteThrough = (write: Effect.Effect<WriteResult<TId>, E, RW>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const result = yield* commit(restore, write, ({ id }) => id);
        const reread = yield* Effect.exit(restore(ops.get(result.id)));
        if (Exit.isFailure(reread)) {
          // Whatever the re-read's failure, the cached entry may now be stale.
          yield* evict(result.id);
          if (hidden !== undefined && isHidden(reread.cause, hidden.when))
            return committedDocument(hidden.type, result);
          return yield* Effect.failCause(reread.cause);
        }
        if (cache !== undefined) yield* cache.set(result.id, reread.value);
        return yield* Assemble.resource(reread.value, {
          ...(capabilities === undefined ? {} : { capabilities }),
          viewer: yield* viewer,
        });
      }),
    );

  const create = Effect.fn(`api.${segment}.create`)(function* ({
    payload,
  }: {
    readonly payload: TCreate;
  }) {
    return yield* commitAndWriteThrough(ops.create(payload));
  });

  const update = Effect.fn(`api.${segment}.update`)(function* ({
    params,
    payload,
  }: {
    readonly params: { readonly id: TId };
    readonly payload: TUpdate;
  }) {
    yield* assertIdMatchesPath(params.id, payload.id);
    return yield* commitAndWriteThrough(ops.update(payload));
  });

  // A hard delete has no tombstone to return: the endpoint answers 204 with
  // no body, so the handler resolves to nothing once the row is gone and the
  // cache entry evicted — with no interrupt gap between the two.
  const remove = Effect.fn(`api.${segment}.delete`)(function* ({
    params,
  }: {
    readonly params: { readonly id: TId };
  }) {
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.andThen(
        commit(restore, ops.delete(params.id), () => params.id),
        evict(params.id),
      ),
    );
  });

  return {
    ...readOnly(config),
    create,
    update,
    delete: remove,
  } as unknown as CrudHandlers<
    TCreate,
    TUpdate,
    TResource,
    TId,
    TQuery,
    E,
    R,
    RW,
    RV,
    RL,
    RC,
    Targets,
    Tx,
    ET,
    RT,
    Committed<HType, TId>
  >;
};

/** What a hidden-write rule naming `HType` adds to a write's success: nothing without one. */
type Committed<HType extends string, TId extends string> = [HType] extends [never]
  ? never
  : CommittedDocument<HType, TId>;

/**
 * Whether a re-read's cause is plain failures only, every one of which the
 * hidden-write rule names: a defect, an interruption or a single failure it
 * rejects keeps the whole cause propagating.
 */
const isHidden = <E>(cause: Cause.Cause<E>, when: (error: E) => boolean): boolean =>
  Arr.isReadonlyArrayNonEmpty(cause.reasons) &&
  Arr.every(cause.reasons, (reason) => Cause.isFailReason(reason) && when(reason.error));

/**
 * The `meta.version` a write result's `version` becomes: a string or a finite
 * number as is, a `bigint` as its decimal string, anything else none.
 */
const wireVersion = ({ version }: WriteResult<string>): Option.Option<string | number> =>
  Predicate.isString(version) || (Predicate.isNumber(version) && Number.isFinite(version))
    ? Option.some(version)
    : Predicate.isBigInt(version)
      ? Option.some(version.toString())
      : Option.none();

/** The {@link CommittedDocument} a hidden write answers. */
const committedDocument = <TId extends string>(
  type: string,
  result: WriteResult<TId>,
): CommittedDocument<string, TId> => ({
  data: Option.match(wireVersion(result), {
    onNone: () => ({ type, id: result.id }),
    onSome: (version) => ({ type, id: result.id, meta: { version } }),
  }),
  jsonapi: Assemble.JSONAPI_MEMBER,
});

// ---------------------------------------------------------------------------
// §7.4 related-resource fetch
// ---------------------------------------------------------------------------

/**
 * The declarations a related-resource handler is built from.
 *
 * @since 0.16.0
 * @category models
 */
export interface RelatedConfig<
  TParent extends Assemble.ResourceLike,
  TId extends string,
  V,
  E,
  R,
  RV,
  RL,
  Targets extends Handlers.IncludeTargets,
> {
  /** The relationship key — the field under `parent.relationships`, and the path segment. */
  readonly key: string;
  readonly cardinality: "one" | "many";
  /** The parent family's URL segment, for the to-many pagination links (`"lists"`). */
  readonly segment: string;
  /** Loads the parent **resource** (not a document) so its linkage can be read. */
  readonly loadParent: (id: TId) => Effect.Effect<TParent, E, R>;
  /**
   * The loader registry the linkage resolves through — the same one the
   * family's `?include=` walk uses, so a related fetch and an include walk
   * can never disagree about what a ref resolves to.
   */
  readonly targets: Targets;
  /** The related resource's includable paths (the to-one `?include=` whitelist). */
  readonly includable?: ReadonlyArray<string> | undefined;
  /**
   * The to-many endpoint's wire query, for the pagination links
   * (`Endpoint.flatRelated`'s `query`, bracketed). Omit for cursor-only links.
   */
  readonly listQuery?: ListQuery<unknown> | undefined;
  readonly linkBase: Effect.Effect<string, never, RL>;
  readonly viewer?: Effect.Effect<V, never, RV> | undefined;
  readonly capabilities?: Assemble.CapabilitiesHook<V> | undefined;
  /** The to-many page size when the caller names none. Defaults to `50`. */
  readonly defaultPageLimit?: number | undefined;
  /** The most related rows one page may resolve. Defaults to `100`. */
  readonly maxPageLimit?: number | undefined;
  /** How many target types' loaders may run at once. Defaults to `6`. */
  readonly concurrency?: number | undefined;
}

/**
 * The decoded request of a related fetch.
 *
 * @since 0.16.0
 * @category models
 */
export interface RelatedRequest<TId extends string> {
  readonly params: { readonly id: TId };
  readonly query?:
    | {
        readonly offset?: number | undefined;
        readonly limit?: number | undefined;
        readonly include?: ReadonlyArray<string> | undefined;
      }
    | undefined;
}

/** Loads a set of refs through the registry, grouped by type, one call per distinct type. */
const loadRefs = <Targets extends Handlers.IncludeTargets>(
  refs: ReadonlyArray<Assemble.Ref>,
  targets: Targets,
  concurrency: number,
): Effect.Effect<
  ReadonlyArray<Assemble.ResourceLike>,
  Handlers.IncludeTargetError<Targets>,
  Handlers.IncludeTargetServices<Targets>
> => {
  const byType = new Map<string, Array<string>>();
  for (const ref of refs) {
    // An own entry only, as `Handlers` loads: a ref typed `constructor` or
    // `toString` names no target, not an `Object.prototype` member.
    if (!Object.hasOwn(targets, ref.type)) continue;
    const ids = byType.get(ref.type) ?? [];
    if (!ids.includes(ref.id)) ids.push(ref.id);
    byType.set(ref.type, ids);
  }
  return Effect.forEach(
    [...byType],
    ([type, ids]) => (targets[type] as Handlers.IncludeTarget)(ids),
    { concurrency },
  ).pipe(
    Effect.map((batches) => {
      const loaded = new Map<string, Assemble.ResourceLike>();
      for (const batch of batches) {
        for (const resource of batch)
          loaded.set(`${resource.type}\0${resource.id}`, resource as Assemble.ResourceLike);
      }
      // In linkage order, dropping a ref that didn't resolve.
      return refs.flatMap((ref) => {
        const resource = loaded.get(`${ref.type}\0${ref.id}`);
        return resource === undefined ? [] : [resource];
      });
    }),
  ) as Effect.Effect<
    ReadonlyArray<Assemble.ResourceLike>,
    Handlers.IncludeTargetError<Targets>,
    Handlers.IncludeTargetServices<Targets>
  >;
};

/**
 * A JSON:API §7.4 related-resource fetch handler for one declared
 * relationship — the handler counterpart of `Endpoint.flatRelated`. It loads
 * the parent, reads the relationship's linkage refs, and resolves them
 * through the loader registry as primary `data`: a **to-many** answers a
 * paginated collection (offset / limit over the linkage; only the page's
 * refs are loaded, one call per distinct target type), a **to-one** the
 * single related resource honouring `?include=`, or `{ data: null }` for
 * empty linkage — with `included: []` when the request carried `include`,
 * whose paths are validated either way. A ref that doesn't resolve is
 * dropped, never a failure.
 *
 * @since 0.16.0
 * @category constructors
 */
export const related = <
  TParent extends Assemble.ResourceLike,
  TId extends string = string,
  V = undefined,
  E = never,
  R = never,
  RV = never,
  RL = never,
  Targets extends Handlers.IncludeTargets = never,
>(
  config: RelatedConfig<TParent, TId, V, E, R, RV, RL, Targets>,
): ((request: RelatedRequest<TId>) => Effect.Effect<
  | Assemble.CollectionDocument<Assemble.ResourceLike>
  | Assemble.ResourceDocument<Assemble.ResourceLike>
  | {
      readonly data: null;
      readonly included?: readonly [];
      readonly jsonapi: typeof Assemble.JSONAPI_MEMBER;
    },
  E | Assemble.IncludeError | Handlers.IncludeTargetError<Targets>,
  R | RV | RL | Handlers.IncludeTargetServices<Targets>
>) => {
  const viewer = (config.viewer ?? none) as Effect.Effect<V, never, RV>;
  const capabilities =
    config.capabilities === undefined ? {} : { capabilities: config.capabilities };
  const concurrency = config.concurrency ?? 6;
  const linkPairs =
    config.listQuery === undefined ? undefined : Query.canonicalPairs(config.listQuery);
  const name = `api.${config.segment}.related.${config.key}`;

  const many = Effect.fn(name)(function* ({ params, query }: RelatedRequest<TId>) {
    const base = yield* config.linkBase;
    const refs = Assemble.relationshipRefs(yield* config.loadParent(params.id), config.key);
    const offset = query?.offset ?? 0;
    // Bound the page so the resolve fan-out can't scale with the full linkage.
    const limit = Math.min(
      query?.limit ?? config.defaultPageLimit ?? 50,
      config.maxPageLimit ?? 100,
    );
    const page = yield* loadRefs(refs.slice(offset, offset + limit), config.targets, concurrency);
    return yield* Assemble.collection(
      page,
      {
        totalCount: refs.length,
        offset,
        limit,
        baseUrl: `${base}/${config.segment}/${params.id}/${config.key}`,
        ...(linkPairs === undefined || query === undefined ? {} : { query: linkPairs(query) }),
      },
      { ...capabilities, viewer: yield* viewer },
    );
  });

  const one = Effect.fn(name)(function* ({ params, query }: RelatedRequest<TId>) {
    const refs = Assemble.relationshipRefs(yield* config.loadParent(params.id), config.key);
    const [resource] = yield* loadRefs(refs.slice(0, 1), config.targets, concurrency);
    // An empty linkage and a ref that doesn't resolve are the same answer on
    // the wire: `data: null`. There is nothing to walk from, but the request's
    // paths are still validated as a resolved resource's are, and a request
    // carrying `include` still gets the key, empty (§Fetching Includes, #232).
    if (resource === undefined) {
      const include = query?.include;
      if (include === undefined) return { data: null, jsonapi: Assemble.JSONAPI_MEMBER } as const;
      yield* Query.validateIncludePaths(include, {
        includable: config.includable ?? [],
        maxDepth: Assemble.MAX_INCLUDE_DEPTH,
      });
      return { data: null, included: [], jsonapi: Assemble.JSONAPI_MEMBER } as const;
    }
    return yield* Assemble.resource(resource, {
      ...capabilities,
      viewer: yield* viewer,
      include: query?.include,
      includable: config.includable,
      targets: config.targets,
    });
  });

  return (config.cardinality === "many" ? many : one) as unknown as (
    request: RelatedRequest<TId>,
  ) => Effect.Effect<
    | Assemble.CollectionDocument<Assemble.ResourceLike>
    | Assemble.ResourceDocument<Assemble.ResourceLike>
    | {
        readonly data: null;
        readonly included?: readonly [];
        readonly jsonapi: typeof Assemble.JSONAPI_MEMBER;
      },
    E | Assemble.IncludeError | Handlers.IncludeTargetError<Targets>,
    R | RV | RL | Handlers.IncludeTargetServices<Targets>
  >;
};
