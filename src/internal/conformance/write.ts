/**
 * The write-fixture machinery: which endpoints a write rule can drive, how a
 * probe creates a disposable target from the caller's fixture, and how that
 * target is disposed of whatever the rule's probe went on to do.
 *
 * The kit cannot synthesise a payload a server will accept, nor undo what it
 * created, so both come from `Options.writes`. Everything here keeps three
 * promises the rules depend on:
 *
 *   - **The kit refuses an id it evidently did not create.** A create
 *     response's id is taken only when the response names a resource of the
 *     type the kit sent, under an id that is a URL path segment of its own and
 *     is neither an `ids` sample, nor one a read earlier in the run returned
 *     (unless the kit held it live at the time), nor one the run
 *     already holds a live record for. A refused id is recorded as named and
 *     never updated, deleted or handed to `cleanup`. Any other id is trusted:
 *     the kit cannot tell a server that names an existing resource it has not
 *     seen from an honest one.
 *   - **Disposal is unconditional.** A created resource is handed to the rule
 *     inside `Effect.acquireUseRelease`, so the fixture's `cleanup` runs when
 *     the rule passes, when it fails and when it dies.
 *   - **Every creation is on the record.** Each one is appended to
 *     `Context.writes` with what became of it, so a run against a real server
 *     is auditable after the fact.
 *
 * @since 0.17.0
 * @internal
 */
import {
  Array as Arr,
  Cause,
  Data,
  Effect,
  Equal,
  Exit,
  Formatter,
  MutableHashSet,
  Option,
  Order,
  Predicate,
  Record as Rec,
  Result,
  Schema,
} from "effect";
import { HEADER as IDEMPOTENCY_HEADER } from "../../Idempotency.js";
import { MEDIA_TYPE } from "../media.js";
import {
  type Context,
  describe,
  type Discovered,
  errorObjectsOf,
  finding,
  type Finding,
  type Fixture,
  identity,
  idKey,
  isJsonArray,
  isJsonObject,
  isLive,
  jsonApiAccept,
  objectIn,
  type Observation,
  type Outcome,
  type Payload,
  renderThrown,
  resolvePath,
  type Rule,
  settle,
  skip,
  statusOf,
  succeeded,
  topLevel,
  type WriteRecord,
} from "./core.js";

const MUTATING_SKIP =
  "mutating probe — pass `mutating: true` to run it against a disposable target";

/** The request headers every write probe sends. */
const writeHeaders = {
  accept: MEDIA_TYPE,
  "content-type": MEDIA_TYPE,
};

/**
 * The `Idempotency-Key` a write to `endpoint` carries: a fresh one when the
 * endpoint requires it (`idempotency: "required"`), which refuses a write
 * without one, and none otherwise — an endpoint where the key is optional
 * processes an unkeyed write normally. A key never sent before can only ever
 * be a first attempt, never a replay.
 *
 * @internal
 */
export const idempotencyHeaders = (
  endpoint: Discovered,
): Effect.Effect<Readonly<Record<string, string>>> =>
  endpoint.idempotencyKey === "required"
    ? Effect.sync(() => ({
        [IDEMPOTENCY_HEADER]: `conformance-${globalThis.crypto.randomUUID()}`,
      }))
    : Effect.succeed({});

/**
 * Whether `observation` is a 4xx, from an endpoint that declares
 * `Idempotency-Key`, to a request the kit sent without a key (`key` is what
 * {@link idempotencyHeaders} gave it), whose error document names the header
 * as a `source`: a refusal on idempotency grounds, whatever its status. The
 * kit keys only an endpoint whose headers schema plainly requires the header,
 * so one that requires it some other way (through a union, say) reads as
 * optional and is sent none.
 *
 * This is the atomic rule's test. That rule judges only whether the server
 * examined the operations document, and a refusal over the key — the
 * package's own missing-key `400`, `KeyInProgress` (409) or `KeyMismatch`
 * (422) — says nothing about that, so any of them leaves the rule undecided.
 * The delete rule judges the answer itself and uses the narrower
 * {@link refusedForMissingKey}.
 *
 * @internal
 */
export const refusedOnKeyGrounds = (
  endpoint: Discovered,
  key: Readonly<Record<string, string>>,
  observation: Observation,
): boolean =>
  observation.status >= 400 &&
  observation.status < 500 &&
  endpoint.idempotencyKey !== "absent" &&
  !Object.hasOwn(key, IDEMPOTENCY_HEADER) &&
  errorObjectsOf(observation.body).some((error) => {
    const source = error["source"];
    return (
      isJsonObject(source) &&
      Predicate.isString(source["header"]) &&
      source["header"].toLowerCase() === IDEMPOTENCY_HEADER
    );
  });

/**
 * Whether `observation` is an endpoint's refusal of a write the kit sent it
 * without a key: a {@link refusedOnKeyGrounds} refusal whose status is `400`,
 * the package's own `400` for a missing required key
 * (`docs/idempotency.md` §2).
 *
 * This is the delete rule's test, and it is deliberately narrower than the
 * atomic rule's. The delete rule judges the answer itself, so any other 4xx
 * is an answer to the delete and is judged: the package's `KeyInProgress`
 * (409) and `KeyMismatch` (422) name the header too, but neither is what a
 * request without a key can draw.
 *
 * @internal
 */
export const refusedForMissingKey = (
  endpoint: Discovered,
  key: Readonly<Record<string, string>>,
  observation: Observation,
): boolean => observation.status === 400 && refusedOnKeyGrounds(endpoint, key, observation);

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/** What an update fixture returns: a resource object's members, without `type` / `id`. */
type Patch = Omit<Payload, "type">;

/**
 * One resource type a write rule can drive: its fixture's members, the URL its
 * create endpoint resolves to, and — for the update and delete rules — the
 * endpoint that acts on the resource the kit created.
 *
 * @internal
 */
export interface WriteTarget {
  /** The `writes` key — the create endpoint's first literal path segment. */
  readonly key: string;
  readonly create: () => Payload;
  readonly update: Option.Option<() => Patch>;
  readonly cleanup: Option.Option<(id: string) => Effect.Effect<unknown, unknown>>;
  readonly clientId: Option.Option<ClientId>;
  readonly createPath: string;
  /** The endpoint `createPath` resolves — the one the kit creates through. */
  readonly createEndpoint: Discovered;
  readonly endpoint: Discovered;
}

/** @internal */
export interface Targets {
  readonly targets: ReadonlyArray<WriteTarget>;
  /** Why each other candidate endpoint could not be driven — names the missing option. */
  readonly missing: ReadonlyArray<string>;
  /** The candidate endpoints considered, so "none in this api" reads apart from "none usable". */
  readonly candidates: number;
}

type WriteRole = "create" | "update" | "delete" | "relationshipWrite";

/**
 * A fixture's `clientId`, its `id` bound to it.
 *
 * @internal
 */
export interface ClientId {
  readonly supported: boolean;
  readonly id: () => string;
}

/** A fixture's members, narrowed: what every write rule needs, and what only some do. */
interface Usable {
  readonly create: () => Payload;
  readonly update: Option.Option<() => Patch>;
  readonly cleanup: Option.Option<(id: string) => Effect.Effect<unknown, unknown>>;
  readonly clientId: Option.Option<ClientId>;
}

const usableFixture = (key: string, fixture: Fixture): Result.Result<Usable, string> =>
  Option.match(Option.fromUndefinedOr(fixture.create), {
    onNone: () => Result.fail(`no create fixture for "${key}" — pass writes["${key}"].create`),
    // Each member is called on the fixture, as `fixture.create()` would be, so
    // one written as a method keeps its `this`.
    onSome: (create) =>
      Result.succeed({
        create: () => create.call(fixture),
        update: Option.map(
          Option.fromUndefinedOr(fixture.update),
          (update) => () => update.call(fixture),
        ),
        cleanup: Option.map(
          Option.fromUndefinedOr(fixture.cleanup),
          (cleanup) => (id: string) => cleanup.call(fixture, id),
        ),
        clientId: Option.map(Option.fromUndefinedOr(fixture.clientId), (clientId) => ({
          supported: clientId.supported,
          id: () => clientId.id.call(clientId),
        })),
      }),
  });

/** The fixture for `key` if it can drive a rule of `role`, or why not — naming the `writes` key it lacks. */
const fixtureFor = (ctx: Context, role: WriteRole, key: string): Result.Result<Usable, string> =>
  Option.match(Option.fromUndefinedOr(ctx.options.writes[key]), {
    onNone: () => Result.fail(`no create fixture for "${key}" — pass writes["${key}"].create`),
    onSome: (fixture) =>
      usableFixture(key, fixture).pipe(
        Result.filterOrFail(
          (usable) => role !== "update" || Option.isSome(usable.update),
          () => `no update fixture for "${key}" — pass writes["${key}"].update`,
        ),
      ),
  });

const createEndpointFor = (ctx: Context, key: string): Option.Option<Discovered> =>
  Arr.findFirst(
    ctx.endpoints,
    (endpoint) => endpoint.role === "create" && endpoint.segment === key,
  );

/** The target `endpoint` gives a rule of `role`, or why it gives none. */
const usable = (
  ctx: Context,
  role: WriteRole,
  endpoint: Discovered,
): Result.Result<WriteTarget, string> =>
  Result.gen(function* () {
    const noCreate = `${endpoint.method} ${endpoint.path} has no create endpoint to make a disposable target with`;
    const key = yield* Result.fromOption(Option.fromUndefinedOr(endpoint.segment), () => noCreate);
    const create = yield* Result.fromOption(
      role === "create" ? Option.some(endpoint) : createEndpointFor(ctx, key),
      () => noCreate,
    );
    const fixture = yield* fixtureFor(ctx, role, key);
    if (role !== "create" && endpoint.params.length !== 1)
      return yield* Result.fail(
        `${endpoint.path} has ${endpoint.params.length} path parameters — the kit can substitute only the id it created`,
      );
    const resolution = resolvePath(create, ctx.options);
    if (Predicate.isTagged(resolution, "Unresolved")) return yield* Result.fail(resolution.reason);
    return { key, ...fixture, createPath: resolution.path, createEndpoint: create, endpoint };
  });

/**
 * The endpoints of `role` a write rule can drive. For `"create"` that is every
 * create endpoint whose type has a `create` fixture; for `"update"`,
 * `"delete"` and `"relationshipWrite"` it is every such endpoint whose type
 * also has a create endpoint and fixture — the kit acts on resources it
 * created itself, never on a caller's sample — and, for `"update"`, an
 * `update` fixture. `admits`
 * narrows the candidates to the endpoints a rule is about (those declaring
 * `Idempotency-Key`, say), so one it leaves out is neither a target nor missing.
 *
 * @internal
 */
export const targets = (
  ctx: Context,
  role: WriteRole,
  admits: (endpoint: Discovered) => boolean = () => true,
): Targets => {
  const candidates = Arr.filter(
    ctx.endpoints,
    (endpoint) => endpoint.role === role && admits(endpoint),
  );
  const [found, missing] = Arr.partition(candidates, (endpoint) => usable(ctx, role, endpoint));
  return { targets: found, missing, candidates: candidates.length };
};

/**
 * The targets the atomic rules can drive through `operations`: every type with
 * a `create` fixture, each sent as an `add` operation. Which types the
 * operations endpoint accepts is not discoverable, so a type it refuses reads
 * as undecided rather than as a finding.
 *
 * @internal
 */
export const atomicTargets = (ctx: Context, operations: Discovered): Targets => {
  const found = Arr.filterMap(Arr.fromRecord(ctx.options.writes), ([key, fixture]) =>
    usableFixture(key, fixture).pipe(
      Result.map((fields): WriteTarget => ({
        key,
        ...fields,
        createPath: operations.path,
        createEndpoint: operations,
        endpoint: operations,
      })),
    ),
  );
  return {
    targets: found,
    missing: Arr.match(found, {
      onEmpty: () => [noAtomicFixture(ctx, operations)],
      onNonEmpty: () => [],
    }),
    candidates: 1,
  };
};

/** The skip reason when no type has a `create` fixture, naming the keys the api suggests. */
const noAtomicFixture = (ctx: Context, operations: Discovered): string => {
  const keys = Arr.filterMap(ctx.endpoints, (endpoint) =>
    endpoint.role === "create" && endpoint.segment !== undefined
      ? Result.succeed(`writes["${endpoint.segment}"].create`)
      : Result.failVoid,
  );
  const suggestion = Arr.match(keys, {
    onEmpty: () => `writes["<type>"].create for a type it accepts`,
    onNonEmpty: (named) => named.join(" or "),
  });
  return `no create fixture to send to ${operations.path} — pass ${suggestion}`;
};

/**
 * The URL of the resource the kit created, through `endpoint`'s path.
 *
 * @internal
 */
export const pathFor = (endpoint: Discovered, id: string): string =>
  endpoint.path.replace(`:${endpoint.params[0]}`, encodeURIComponent(id));

// ---------------------------------------------------------------------------
// What a create response names
// ---------------------------------------------------------------------------

/**
 * A resource identifier as a response document carries it.
 *
 * @internal
 */
export const Identity = Schema.Struct({ type: Schema.String, id: Schema.String });

/** @internal */
export type Identity = typeof Identity.Type;

const decodePrimary = Schema.decodeUnknownOption(Schema.Struct({ data: Identity }));
const decodeAtomicResults = Schema.decodeUnknownOption(
  Schema.Struct({ "atomic:results": Schema.Array(Schema.Unknown) }),
);

/**
 * The resource a response document's primary data identifies, if it is a
 * resource object with a string `type` and `id`.
 *
 * @internal
 */
export const primaryIdentity = (observation: Observation): Option.Option<Identity> =>
  Option.flatMap(observation.body, decodePrimary).pipe(Option.map(({ data }) => data));

/**
 * The resource the first `atomic:results` entry identifies.
 *
 * @internal
 */
export const atomicIdentity = (observation: Observation): Option.Option<Identity> =>
  Option.flatMap(observation.body, decodeAtomicResults).pipe(
    Option.flatMap((body) => Arr.head(body["atomic:results"])),
    Option.flatMap(decodePrimary),
    Option.map(({ data }) => data),
  );

// ---------------------------------------------------------------------------
// Creating and disposing
// ---------------------------------------------------------------------------

type Entry = Context["writes"][number];

/**
 * What a write probe's creation produced: the fixture threw before anything
 * was sent, or a request was sent — with the ledger entry for what it created,
 * when the server answered with a 2xx.
 *
 * @internal
 */
export type Created = Data.TaggedEnum<{
  Unbuilt: { readonly reason: string };
  Sent: {
    readonly payload: Payload;
    readonly observation: Observation;
    /** None when the request was not answered with a 2xx. */
    readonly entry: Option.Option<Entry>;
  };
}>;

/** @internal */
export const Created = Data.taggedEnum<Created>();

/**
 * How a write probe creates: the request that sends a payload, and where the
 * response names the resource it made.
 *
 * @internal
 */
export interface Via {
  readonly send: (payload: Payload) => Effect.Effect<Observation>;
  /** The resource `observation`, the answer to sending `payload`, names. */
  readonly identify: (observation: Observation, payload: Payload) => Option.Option<Identity>;
}

/**
 * The fixture's create payload, or why there is none — `create` threw.
 *
 * @internal
 */
export const buildCreate = (target: WriteTarget): Result.Result<Payload, string> =>
  Result.try({
    try: target.create,
    catch: (error) => `writes["${target.key}"].create threw: ${renderThrown(error)}`,
  });

/**
 * The fixture's update, or why there is none — `update` is absent or threw.
 *
 * @internal
 */
export const buildUpdate = (target: WriteTarget): Result.Result<Patch, string> =>
  Option.match(target.update, {
    onNone: () =>
      Result.fail(`no update fixture for "${target.key}" — pass writes["${target.key}"].update`),
    onSome: (update) =>
      Result.try({
        try: update,
        catch: (error) => `writes["${target.key}"].update threw: ${renderThrown(error)}`,
      }),
  });

/**
 * Whether `id`, percent-encoded as one URL path segment, is still exactly that
 * segment once the URL is normalised. `encodeURIComponent` escapes `/`, `?`,
 * `#` and `%` but leaves `.` alone, and a URL's dot segments are resolved
 * before it is sent: `/articles/..` is `/`, `/articles/.` is `/articles/`. An
 * empty id leaves `/articles/` too. A request built from any of them reaches a
 * URL other than the resource's own — the collection, or the root.
 *
 * An id no URL can carry — a lone surrogate, which `encodeURIComponent`
 * throws on — is no segment either. It comes straight from the server's
 * response, so this must answer rather than throw: a throw here would die in
 * the step that records the create, before the record exists.
 */
const isOwnSegment = (id: string): boolean =>
  id !== "" &&
  Result.try(() => {
    const path = `/type/${encodeURIComponent(id)}`;
    return new URL(path, "http://conformance.invalid").pathname === path;
  }).pipe(Result.getOrElse(() => false));

/**
 * The id a create response named, if the kit may act on it — or why not. The
 * kit refuses an id it evidently did not create, so the response must name a
 * resource of the type the kit sent, under an id that:
 *
 *   - is a URL path segment of its own (see `isOwnSegment`), since the update
 *     and delete rules put it in a URL and `cleanup` may too;
 *   - is not an `ids` sample, which the kit did not create;
 *   - no successful `GET` earlier in the run has shown (`Context.observed`)
 *     while the kit held no live resource under it: the server held a
 *     resource it showed before the kit made one under its id — a read-back of
 *     the kit's own resource, made while it was live, is not counted;
 *   - the run does not already hold a live record for (two live resources
 *     cannot share an id, so one of the two answers is wrong).
 *
 * An id whose earlier holder the kit has since removed is accepted: servers
 * that hand out the next free id reuse it. Any other id is trusted — a server
 * that names an existing resource the run has not seen cannot be told from an
 * honest one. The observed check is only as complete as the reads before it,
 * which is why the read rules run first (`rules` in `./spec.ts`).
 *
 * `found` vets a resource no response named — one a probe found in a
 * collection after a request that should have created nothing (see
 * {@link withBatch}) — and words the refusal by it. That read showed the id,
 * so the observed check is left out; the rest stand.
 */
const vet = (
  ctx: Context,
  target: WriteTarget,
  payload: Payload,
  named: Identity,
  found?: string,
): Result.Result<string, string> => {
  const refuse = (why: string) =>
    Result.fail(
      `${found ?? "the create response named"} \`${named.type}:${named.id}\`, ${why} — not touched`,
    );
  if (named.type !== payload.type)
    return refuse(`which the kit did not create (it sent a "${payload.type}" resource)`);
  if (!isOwnSegment(named.id))
    return refuse(
      "which is not a URL path segment of its own (a request to it would reach another URL)",
    );
  const samples = [ctx.options.ids[target.key], ctx.options.ids[named.type]];
  if (Arr.contains(samples, named.id))
    return refuse("which the kit did not create (it is the `ids` sample)");
  // A read-back of what the kit created shows its id too, but `observing`
  // leaves out an id the ledger held live when the read came back — so what
  // is here was shown while the kit held no resource under it. A resource
  // `found` was shown by the read that found it, which is the point.
  if (found === undefined && MutableHashSet.has(ctx.observed, idKey(named.type, named.id)))
    return refuse("which the kit did not create (a read earlier in this run returned it)");
  const mine = Arr.filter(
    ctx.writes,
    (entry) => entry.type === named.type && entry.id === named.id,
  );
  if (Arr.some(mine, isLive))
    return refuse(
      "which this create did not make (an earlier create in this run holds that id and has not been removed)",
    );
  return Result.succeed(named.id);
};

/** Appends what a 2xx create made to the run's record, keeping an id only when the kit may act on it. */
const record = (
  ctx: Context,
  rule: Rule,
  target: WriteTarget,
  payload: Payload,
  named: Option.Option<Identity>,
): Entry => {
  const claim: Result.Result<string, string> = Option.match(named, {
    onNone: () => Result.fail("the response named no id, so nothing could be cleaned up"),
    onSome: (identity) => vet(ctx, target, payload, identity),
  });
  // With an id, `dispose` settles `disposal` and `detail` once the probe is done with it.
  const entry: Entry = Result.match(claim, {
    onSuccess: (id) => ({
      type: payload.type,
      id,
      rule: rule.id,
      disposal: "left",
      detail: undefined,
    }),
    onFailure: (detail) => ({
      type: payload.type,
      id: undefined,
      rule: rule.id,
      disposal: "left",
      detail,
    }),
  });
  ctx.writes.push(entry);
  return entry;
};

/**
 * Runs the fixture's `cleanup` on `id`, recording how it ended; never fails or
 * dies. `detail` renders what it failed with, or the defect it threw or died
 * with, through {@link renderThrown} — not `Cause.pretty`, which itself throws
 * on a value it cannot inspect, and would turn a failed cleanup into a defect
 * of the release step.
 */
const runCleanup = (
  entry: Entry,
  id: string,
  cleanup: (id: string) => Effect.Effect<unknown, unknown>,
): Effect.Effect<void> =>
  Effect.exit(Effect.suspend(() => cleanup(id))).pipe(
    Effect.map(
      Exit.match({
        onSuccess: () => {
          entry.disposal = "cleaned-up";
          entry.detail = undefined;
        },
        onFailure: (cause) => {
          entry.disposal = "cleanup-failed";
          entry.detail = renderThrown(Cause.squash(cause));
        },
      }),
    ),
  );

/** Disposes of one ledger entry, unless it has no id the kit may act on or is already gone. */
const disposeEntry = (target: WriteTarget, entry: Entry): Effect.Effect<void> => {
  const id = entry.id;
  if (id === undefined || entry.disposal !== "left") return Effect.void;
  return Option.match(target.cleanup, {
    onNone: () =>
      Effect.sync(() => {
        entry.detail = `no cleanup — pass writes["${target.key}"].cleanup to remove it`;
      }),
    onSome: (cleanup) => runCleanup(entry, id, cleanup),
  });
};

/**
 * Disposes of what a probe created, unless the probe's own DELETE already did.
 * Never fails or dies: a cleanup that fails, throws or dies is recorded, not
 * propagated — whatever it fails with, since {@link renderThrown} is total —
 * so one bad cleanup cannot cost the rest of the run its report.
 */
const dispose = (target: WriteTarget, created: Created): Effect.Effect<void> =>
  Created.$match(created, {
    Unbuilt: () => Effect.void,
    Sent: ({ entry }) =>
      Option.match(entry, {
        onNone: () => Effect.void,
        onSome: (entry) => disposeEntry(target, entry),
      }),
  });

const isSuccessful = (observation: Observation): boolean =>
  observation.status >= 200 && observation.status < 300;

/** Builds the fixture's payload and sends it; a non-2xx answer is taken to have created nothing. */
const create = (ctx: Context, rule: Rule, target: WriteTarget, via: Via): Effect.Effect<Created> =>
  Result.match(buildCreate(target), {
    onFailure: (reason) => Effect.succeed(Created.Unbuilt({ reason })),
    onSuccess: (payload) =>
      via.send(payload).pipe(
        Effect.map((observation) =>
          Created.Sent({
            payload,
            observation,
            entry: isSuccessful(observation)
              ? Option.some(record(ctx, rule, target, payload, via.identify(observation, payload)))
              : Option.none(),
          }),
        ),
      ),
  });

/**
 * Creates a disposable target from `target`'s fixture through `via`, hands the
 * result to `use`, and then disposes of whatever was created — however `use`
 * exits.
 *
 * A 2xx is always recorded. Its id is kept, and later acted on, only when the
 * response names a resource the kit may treat as its own (see `vet`); one that
 * names none, or names another, is recorded as left in place.
 *
 * @internal
 */
export const withCreated = <A>(
  ctx: Context,
  rule: Rule,
  target: WriteTarget,
  via: Via,
  use: (created: Created) => Effect.Effect<A>,
): Effect.Effect<A> =>
  Effect.acquireUseRelease(create(ctx, rule, target, via), use, (created) =>
    dispose(target, created),
  );

// ---------------------------------------------------------------------------
// Creating several resources in one atomic request
// ---------------------------------------------------------------------------

/**
 * One resource an atomic probe's request is to `add`: the target whose
 * fixture built it, and the payload it built.
 *
 * @internal
 */
export interface Planned {
  readonly target: WriteTarget;
  readonly payload: Payload;
}

/**
 * What an atomic probe's request was answered with, and — when that was a
 * 2xx — the ledger entry for each planned resource, in plan order, keyed by
 * the `atomic:results` entry at the same position.
 *
 * @internal
 */
export interface Batch {
  readonly observation: Observation;
  /** None when the request was not answered with a 2xx. */
  readonly entries: Option.Option<Arr.NonEmptyReadonlyArray<Entry>>;
}

/**
 * Records a resource the probe found its request left, though the server
 * answered as if it created nothing, so that it is disposed of with the rest
 * — or refuses it, as `vet` would (`found` names where it was found). Answers
 * the entry it recorded.
 *
 * @internal
 */
export type Adopt = (target: WriteTarget, payload: Payload, id: string, found: string) => Entry;

/**
 * The resource each `atomic:results` entry identifies, by position; none for
 * an entry with no resource object as `data`, and no entries at all when the
 * document carries no `atomic:results` array.
 *
 * @internal
 */
export const atomicIdentities = (
  observation: Observation,
): ReadonlyArray<Option.Option<Identity>> =>
  Option.match(Option.flatMap(observation.body, decodeAtomicResults), {
    onNone: () => [],
    onSome: (body) =>
      Arr.map(body["atomic:results"], (result) =>
        decodePrimary(result).pipe(Option.map(({ data }) => data)),
      ),
  });

/**
 * Sends one atomic request that `add`s every `planned` resource, hands what it
 * was answered with to `use`, and then disposes of everything recorded —
 * latest first, so a resource that links to an earlier one goes before it —
 * however `use` exits. A 2xx records one entry per planned resource, its id
 * taken from the `atomic:results` entry at the same position and vetted
 * against that resource's payload; any other answer records nothing, and
 * `use` may `adopt` what it finds the request left anyway.
 *
 * @internal
 */
export const withBatch = <A>(
  ctx: Context,
  rule: Rule,
  planned: Arr.NonEmptyReadonlyArray<Planned>,
  send: Effect.Effect<Observation>,
  use: (batch: Batch, adopt: Adopt) => Effect.Effect<A>,
): Effect.Effect<A> => {
  const held: Array<readonly [WriteTarget, Entry]> = [];
  const hold = (target: WriteTarget, entry: Entry): Entry => {
    held.push([target, entry]);
    return entry;
  };
  const acquire = send.pipe(
    Effect.map((observation): Batch => {
      if (!isSuccessful(observation)) return { observation, entries: Option.none() };
      const named = atomicIdentities(observation);
      return {
        observation,
        entries: Option.some(
          Arr.map(planned, ({ target, payload }, index) =>
            hold(target, record(ctx, rule, target, payload, Option.flatten(Arr.get(named, index)))),
          ),
        ),
      };
    }),
  );
  const adopt: Adopt = (target, payload, id, found) => {
    const entry: Entry = Result.match(
      vet(ctx, target, payload, { type: payload.type, id }, found),
      {
        onSuccess: (own) => {
          // The read that found it showed it; it is the kit's now, so a later
          // create the server hands the same id once it is gone is not refused.
          MutableHashSet.remove(ctx.observed, idKey(payload.type, own));
          return {
            type: payload.type,
            id: own,
            rule: rule.id,
            disposal: "left",
            detail: undefined,
          };
        },
        onFailure: (detail) => ({
          type: payload.type,
          id: undefined,
          rule: rule.id,
          disposal: "left",
          detail,
        }),
      },
    );
    ctx.writes.push(entry);
    return hold(target, entry);
  };
  return Effect.acquireUseRelease(
    acquire,
    (batch) => use(batch, adopt),
    () =>
      Effect.forEach(Arr.reverse(held), ([target, entry]) => disposeEntry(target, entry), {
        concurrency: 1,
        discard: true,
      }),
  );
};

/**
 * Creates through the target's own create endpoint — `POST /<type>` with the
 * fixture's payload as primary data, and a fresh `Idempotency-Key` when that
 * endpoint requires one (see {@link idempotencyHeaders}).
 *
 * @internal
 */
export const viaCreateEndpoint = (ctx: Context, target: WriteTarget): Via => ({
  send: (payload) =>
    idempotencyHeaders(target.createEndpoint).pipe(
      Effect.flatMap((key) =>
        ctx.request({
          method: "POST",
          url: target.createPath,
          headers: { ...writeHeaders, ...key },
          body: { data: payload },
        }),
      ),
    ),
  identify: primaryIdentity,
});

/**
 * The fixture's client-generated id for a rule that probes a server that
 * does (`supported: true`) or does not support them, or why there is none —
 * `clientId` is absent, declares the other case, or its `id` threw. The kit
 * never makes one up.
 *
 * @internal
 */
export const buildClientId = (
  target: WriteTarget,
  supported: boolean,
): Result.Result<string, string> =>
  Option.match(target.clientId, {
    onNone: () =>
      Result.fail(
        `no client-generated id for "${target.key}" — pass writes["${target.key}"].clientId`,
      ),
    onSome: (clientId) =>
      clientId.supported === supported
        ? Result.try({
            try: clientId.id,
            catch: (error) => `writes["${target.key}"].clientId.id threw: ${renderThrown(error)}`,
          })
        : Result.fail(
            `writes["${target.key}"].clientId declares client-generated ids ${clientId.supported ? "supported" : "unsupported"}, and this rule probes a server that ${supported ? "supports" : "does not support"} them`,
          ),
  });

/**
 * Creates through the target's own create endpoint as {@link viaCreateEndpoint}
 * does, with `id` — a client-generated id the fixture supplied — on the
 * resource object. A 204 names no resource, so it is taken to have made the
 * one the kit asked for: `id`, of the payload's type.
 *
 * @internal
 */
export const viaClientId = (ctx: Context, target: WriteTarget, id: string): Via => {
  const via = viaCreateEndpoint(ctx, target);
  return {
    send: (payload) => {
      const identified = { ...payload, id };
      return via.send(identified);
    },
    identify: (observation, payload) =>
      Option.orElse(primaryIdentity(observation), () =>
        observation.status === 204 ? Option.some({ type: payload.type, id }) : Option.none(),
      ),
  };
};

/**
 * Sends `patch` — the fixture's update — to `type:id`, a resource the kit
 * created, through the target's update endpoint, with a fresh
 * `Idempotency-Key` when that endpoint requires one.
 *
 * @internal
 */
export const sendUpdate = (
  ctx: Context,
  target: WriteTarget,
  type: string,
  id: string,
  patch: Patch,
): Effect.Effect<Observation> =>
  idempotencyHeaders(target.endpoint).pipe(
    Effect.flatMap((key) =>
      ctx.request({
        method: target.endpoint.method,
        url: pathFor(target.endpoint, id),
        headers: { ...writeHeaders, ...key },
        body: { data: { ...patch, type, id } },
      }),
    ),
  );

/**
 * Sends `data` — resource linkage — through `endpoint`, a relationship write
 * endpoint, to `url`, with a fresh `Idempotency-Key` when that endpoint
 * requires one.
 *
 * @internal
 */
export const sendLinkage = (
  ctx: Context,
  endpoint: Discovered,
  url: string,
  data: Identity | ReadonlyArray<Identity> | null,
): Effect.Effect<Observation> =>
  idempotencyHeaders(endpoint).pipe(
    Effect.flatMap((key) =>
      ctx.request({
        method: endpoint.method,
        url,
        headers: { ...writeHeaders, ...key },
        body: { data },
      }),
    ),
  );

// ---------------------------------------------------------------------------
// Reading a write back
// ---------------------------------------------------------------------------

/**
 * The single-resource GET of `target`'s type, which a write is read back
 * through — or why there is none.
 *
 * @internal
 */
export const readEndpointFor = (
  ctx: Context,
  target: WriteTarget,
): Result.Result<Discovered, string> =>
  Result.fromOption(
    Arr.findFirst(
      ctx.endpoints,
      (endpoint) =>
        endpoint.role === "resource" &&
        endpoint.segment === target.key &&
        endpoint.params.length === 1,
    ),
    () =>
      `no single-resource GET endpoint for "${target.key}" with one path parameter to read a write back through`,
  );

/** A JSON object off the wire, as `isJsonObject` narrows one. */
type JsonObject = Schema.JsonObject;

const encodeSent = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeSent = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.JsonObject));

/**
 * A fixture's members as the server received them: the JSON its request body
 * carried, which `JSON.stringify` wrote — a `Date` as the string it was sent
 * as, an `undefined` member absent. Empty when they are not JSON at all, which
 * the request carrying them could not have been sent with.
 *
 * @internal
 */
export const asSent = (members: Omit<Payload, "type">): JsonObject =>
  Option.getOrElse(Option.flatMap(encodeSent(members), decodeSent), () => ({}));

/** A server value for an `observed` line, cut to 80 code units. */
const rendered = (value: Schema.Json): string => {
  const text = Formatter.format(value);
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
};

/** A member for an `observed` line: `absent` when there is none. */
const shown = (value: Option.Option<Schema.Json>): string =>
  Option.match(value, { onNone: () => "absent", onSome: rendered });

const membersOf = (
  resource: JsonObject,
  member: "attributes" | "relationships",
): Readonly<Record<string, Schema.Json>> => objectIn(resource[member]);

/**
 * A relationship's linkage as one comparable value: `null`, one identity, or
 * a to-many relationship's identities in sorted order — JSON:API gives a
 * to-many linkage no order a read must keep. None when it carries no `data`
 * (and, at each call, when the relationship is not an object at all).
 */
const linkageValue = (relationship: JsonObject): Option.Option<Schema.Json> => {
  if (!("data" in relationship)) return Option.none();
  const data = relationship["data"];
  const key = (item: Schema.Json): string =>
    isJsonObject(item) ? (identity(item) ?? rendered(item)) : rendered(item);
  if (isJsonArray(data)) return Option.some(Arr.sort(Arr.map(data, key), Order.String));
  return Option.some(data === null ? null : key(data));
};

/**
 * Each member `expected` states that `stored` does not show alike, as
 * `attributes.<name>: … · read back …`: every attribute `expected` carries,
 * and the linkage of every relationship it carries `data` for. A member only
 * `stored` carries is not compared — a default fieldset may differ.
 *
 * @internal
 */
export const readBackDifferences = (
  expected: JsonObject,
  stored: JsonObject,
): ReadonlyArray<string> => {
  const storedAttributes = membersOf(stored, "attributes");
  const storedRelationships = membersOf(stored, "relationships");
  const attributes = Arr.filterMap(
    Arr.fromRecord(membersOf(expected, "attributes")),
    ([name, value]) =>
      Equal.equals(value, storedAttributes[name])
        ? Result.failVoid
        : Result.succeed(
            `attributes.${name}: ${rendered(value)} · read back ${shown(Rec.get(storedAttributes, name))}`,
          ),
  );
  const relationships = Arr.filterMap(
    Arr.fromRecord(membersOf(expected, "relationships")),
    ([name, relationship]) =>
      Option.match(Option.flatMap(Option.liftPredicate(relationship, isJsonObject), linkageValue), {
        onNone: () => Result.failVoid,
        onSome: (linkage) => {
          const read = Option.flatMap(
            Option.filter(Rec.get(storedRelationships, name), isJsonObject),
            linkageValue,
          );
          return Option.exists(read, (other) => Equal.equals(linkage, other))
            ? Result.failVoid
            : Result.succeed(
                `relationships.${name}.data: ${rendered(linkage)} · read back ${Option.match(read, {
                  onNone: () => "no linkage",
                  onSome: rendered,
                })}`,
              );
        },
      }),
  );
  return [...attributes, ...relationships];
};

/**
 * A response document's primary data, when it is one resource object.
 *
 * @internal
 */
export const primaryResource = (observation: Observation): Option.Option<JsonObject> =>
  Option.filter(topLevel(observation.body, "data"), isJsonObject);

/**
 * Reads `type:id` back through `get` and judges it against `expected` — what
 * the write said the resource now is, which `what` names. A resource the
 * server no longer has (`404` or `410`) was not stored; an answer that is not
 * that resource, or shows a member otherwise, is a finding. Any other answer
 * (a server error, a refusal, no answer) decides nothing.
 *
 * @internal
 */
export const readBack = (
  ctx: Context,
  rule: Rule,
  requests: number,
  get: Discovered,
  type: string,
  id: string,
  what: string,
  expected: JsonObject,
): Effect.Effect<Verdict> =>
  ctx.request({ url: pathFor(get, id), headers: jsonApiAccept }).pipe(
    Effect.map((observation): Verdict => {
      const broken = (detail: string, observed = describe(observation)) =>
        decided(requests + 1, [
          finding(rule, {
            detail,
            expected: `the resource as ${what} — the same \`attributes\` and relationship linkage`,
            observed,
            probe: observation.probe,
          }),
        ]);
      if (observation.status === 404 || observation.status === 410)
        return broken(`${type}:${id}, which ${what}, does not read back through ${get.path}`);
      if (!succeeded(observation))
        return undecided(
          `reading ${type}:${id} back through ${get.path} answered ${statusOf(observation)} (${describe(observation)})`,
        );
      return Option.match(
        Option.filter(
          primaryResource(observation),
          (resource) => resource["type"] === type && resource["id"] === id,
        ),
        {
          onNone: () =>
            broken(`reading ${type}:${id} back through ${get.path} did not answer that resource`),
          onSome: (stored) =>
            Arr.match(readBackDifferences(expected, stored), {
              onEmpty: () => decided(requests + 1, []),
              onNonEmpty: (differences) =>
                broken(
                  `${type}:${id} reads back through ${get.path} otherwise than ${what}`,
                  differences.join("; "),
                ),
            }),
        },
      );
    }),
  );

// ---------------------------------------------------------------------------
// Settling a write rule
// ---------------------------------------------------------------------------

/**
 * One target's contribution to a write rule: the findings it produced over
 * `requests` requests, or the reason it could not decide the rule.
 *
 * @internal
 */
export type Verdict = Data.TaggedEnum<{
  Decided: { readonly requests: number; readonly findings: ReadonlyArray<Finding> };
  Undecided: { readonly reason: string };
}>;

const Verdict = Data.taggedEnum<Verdict>();

type Decided = Data.TaggedEnum.Value<Verdict, "Decided">;

/** @internal */
export const decided = (requests: number, findings: ReadonlyArray<Finding>): Verdict =>
  Verdict.Decided({ requests, findings });

/** @internal */
export const undecided = (reason: string): Verdict => Verdict.Undecided({ reason });

/**
 * `verdict`, counting `more` requests made before the ones it counts; an
 * undecided verdict as it is.
 *
 * @internal
 */
export const plusRequests = (verdict: Verdict, more: number): Verdict =>
  Verdict.$match(verdict, {
    Decided: ({ requests, findings }) => decided(requests + more, findings),
    Undecided: () => verdict,
  });

/**
 * A creation the server accepted: a 2xx, on the record.
 *
 * @internal
 */
export interface Accepted {
  readonly payload: Payload;
  readonly observation: Observation;
  readonly entry: Entry;
}

/**
 * The accepted creation, or why there is none: the fixture threw, or the server
 * did not accept the fixture's payload. Neither is a verdict on a rule — a
 * payload the server rejects proves nothing about what it answers on success —
 * so both read as "not checked", naming the cause.
 *
 * @internal
 */
export const accepted = (target: WriteTarget, created: Created): Result.Result<Accepted, string> =>
  Created.$match(created, {
    Unbuilt: ({ reason }) => Result.fail(reason),
    Sent: ({ payload, observation, entry }) =>
      Option.match(entry, {
        onSome: (entry) => Result.succeed({ payload, observation, entry }),
        onNone: () =>
          Result.fail(
            `the server did not accept writes["${target.key}"].create (${statusOf(observation)}${
              observation.text === "" ? "" : ` — ${observation.text.slice(0, 160)}`
            }) — a write rule needs a payload the server accepts`,
          ),
      }),
  });

/**
 * The id of the resource the kit created and may act on, or why there is none
 * — the response named no id, or named one the kit did not create.
 *
 * @internal
 */
export const ownId = (created: Accepted): Result.Result<string, string> =>
  Result.fromOption(
    Option.fromUndefinedOr(created.entry.id),
    () => created.entry.detail ?? "the create response named no id",
  );

/**
 * A rule decided on the resource a create probe made: `decide` runs only when
 * the server accepted the fixture's payload.
 *
 * @internal
 */
export const onAccepted =
  (target: WriteTarget, decide: (created: Accepted) => Effect.Effect<Verdict>) =>
  (created: Created): Effect.Effect<Verdict> =>
    Result.match(accepted(target, created), {
      onFailure: (reason) => Effect.succeed(undecided(reason)),
      onSuccess: decide,
    });

/**
 * A rule decided on the resource a create probe made and may act on:
 * `decide` runs only when the server accepted the fixture's payload and named
 * an id the kit may act on.
 *
 * @internal
 */
export const onOwnId = (
  target: WriteTarget,
  decide: (created: Accepted, id: string) => Effect.Effect<Verdict>,
): ((created: Created) => Effect.Effect<Verdict>) =>
  onAccepted(target, (created) =>
    Result.match(ownId(created), {
      onFailure: (reason) => Effect.succeed(undecided(reason)),
      onSuccess: (id) => decide(created, id),
    }),
  );

const decision = (verdict: Verdict): Result.Result<Decided, string> =>
  Verdict.$match(verdict, {
    Decided: (settled) => Result.succeed(settled),
    Undecided: ({ reason }) => Result.fail(reason),
  });

/**
 * Runs `probe` over every usable target and settles the rule: findings fail it,
 * a rule that decided nothing anywhere is `Skipped` naming every reason, and a
 * pass carries a note naming the targets it could not decide.
 *
 * @internal
 */
export const overTargets = (
  ctx: Context,
  rule: Rule,
  found: Targets,
  what: string,
  probe: (target: WriteTarget) => Effect.Effect<Verdict>,
): Effect.Effect<Outcome> =>
  overTargetsAll(ctx, rule, found, what, (target) => Effect.map(probe(target), Arr.of));

/**
 * {@link overTargets}, for a probe that reaches more than one verdict per
 * target — one per request it judges.
 *
 * @internal
 */
export const overTargetsAll = (
  ctx: Context,
  rule: Rule,
  found: Targets,
  what: string,
  probe: (target: WriteTarget) => Effect.Effect<ReadonlyArray<Verdict>>,
): Effect.Effect<Outcome> =>
  Effect.gen(function* () {
    if (!ctx.options.mutating) return skip(rule, MUTATING_SKIP);
    if (found.candidates === 0) return skip(rule, `no ${what} in this api`);
    // One target at a time: each creates and disposes of server state, and a
    // concurrent create could trip a uniqueness rule the fixture relies on.
    const verdicts = Arr.flatten(yield* Effect.forEach(found.targets, probe, { concurrency: 1 }));
    const [settled, undecidedFor] = Arr.partition(verdicts, decision);
    const reasons = [...found.missing, ...undecidedFor];
    const note = Arr.match(reasons, {
      onEmpty: () => undefined,
      onNonEmpty: (named) => `not decided for: ${named.join("; ")}`,
    });
    return Arr.match(settled, {
      onEmpty: () => skip(rule, reasons.join("; ")),
      onNonEmpty: (verdicts) =>
        settle(
          rule,
          Arr.reduce(verdicts, 0, (total, verdict) => total + verdict.requests),
          Arr.flatMap(verdicts, (verdict) => verdict.findings),
          note,
        ),
    });
  });

/**
 * The run's writes as report data — a snapshot, so the report does not alias
 * the ledger the rules appended to.
 *
 * @internal
 */
export const snapshot = (ctx: Context): ReadonlyArray<WriteRecord> =>
  ctx.writes.map((entry) => ({ ...entry }));
