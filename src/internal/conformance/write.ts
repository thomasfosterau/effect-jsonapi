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
 *     (unless the kit took it from a create of its own), nor one the run
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
  Exit,
  MutableHashSet,
  Option,
  Predicate,
  Result,
  Schema,
} from "effect";
import { HEADER as IDEMPOTENCY_HEADER } from "../../Idempotency.js";
import { MEDIA_TYPE } from "../media.js";
import {
  type Context,
  type Discovered,
  errorObjectsOf,
  type Finding,
  type Fixture,
  idKey,
  isRecord,
  type Observation,
  type Outcome,
  type Payload,
  renderThrown,
  resolvePath,
  type Rule,
  settle,
  skip,
  statusOf,
  type WriteRecord,
} from "./core.js";

const MUTATING_SKIP =
  "mutating probe — pass `mutating: true` to run it against a disposable target";

/** The request headers every write probe sends. */
export const writeHeaders = {
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
 * Whether `observation` is an endpoint's refusal of a write the kit sent it
 * without a key: a `400` from an endpoint that declares `Idempotency-Key`, to
 * a request that carried none (`key` is what {@link idempotencyHeaders} gave
 * it), whose error document names the header as a `source` — the package's
 * own `400` for a missing required key (`docs/idempotency.md` §2). The kit
 * keys only an endpoint whose headers schema plainly requires the header, so
 * one that requires it some other way (through a union, say) reads as
 * optional and is sent none. Any other 4xx is an answer to the write — the
 * package's `KeyInProgress` (409) and `KeyMismatch` (422) name the header too,
 * but neither is what a request without a key can draw.
 *
 * @internal
 */
export const refusedForMissingKey = (
  endpoint: Discovered,
  key: Readonly<Record<string, string>>,
  observation: Observation,
): boolean =>
  observation.status === 400 &&
  endpoint.idempotencyKey !== "absent" &&
  !Object.hasOwn(key, IDEMPOTENCY_HEADER) &&
  errorObjectsOf(observation.body).some((error) => {
    const source = error["source"];
    return (
      isRecord(source) &&
      Predicate.isString(source["header"]) &&
      source["header"].toLowerCase() === IDEMPOTENCY_HEADER
    );
  });

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

type WriteRole = "create" | "update" | "delete";

/** A fixture's members, narrowed: what every write rule needs, and what only some do. */
interface Usable {
  readonly create: () => Payload;
  readonly update: Option.Option<() => Patch>;
  readonly cleanup: Option.Option<(id: string) => Effect.Effect<unknown, unknown>>;
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
 * create endpoint whose type has a `create` fixture; for `"update"` and
 * `"delete"` it is every such endpoint whose type also has a create endpoint
 * and fixture — the kit acts on resources it created itself, never on a
 * caller's sample — and, for `"update"`, an `update` fixture. `admits`
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
  decodePrimary(observation.body).pipe(Option.map(({ data }) => data));

/**
 * The resource the first `atomic:results` entry identifies.
 *
 * @internal
 */
export const atomicIdentity = (observation: Observation): Option.Option<Identity> =>
  decodeAtomicResults(observation.body).pipe(
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

const Created = Data.taggedEnum<Created>();

/**
 * How a write probe creates: the request that sends a payload, and where the
 * response names the resource it made.
 *
 * @internal
 */
export interface Via {
  readonly send: (payload: Payload) => Effect.Effect<Observation>;
  readonly identify: (observation: Observation) => Option.Option<Identity>;
}

const build = (target: WriteTarget): Result.Result<Payload, string> =>
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

/** A ledger entry still in place: nothing the kit did has removed it. */
const live = (entry: Entry): boolean =>
  entry.disposal === "left" || entry.disposal === "cleanup-failed";

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
 *   - no successful `GET` earlier in the run has shown (`Context.observed`),
 *     unless the kit took that id from an earlier create of its own: the
 *     server held a resource it showed before the kit made one under its id;
 *   - the run does not already hold a live record for (two live resources
 *     cannot share an id, so one of the two answers is wrong).
 *
 * An id whose earlier holder the kit has since removed is accepted: servers
 * that hand out the next free id reuse it. Any other id is trusted — a server
 * that names an existing resource the run has not seen cannot be told from an
 * honest one. The observed check is only as complete as the reads before it,
 * which is why the read rules run first (`rules` in `./spec.ts`).
 */
const vet = (
  ctx: Context,
  target: WriteTarget,
  payload: Payload,
  named: Identity,
): Result.Result<string, string> => {
  const refuse = (why: string) =>
    Result.fail(`the create response named \`${named.type}:${named.id}\`, ${why} — not touched`);
  if (named.type !== payload.type)
    return refuse(`which the kit did not create (it sent a "${payload.type}" resource)`);
  if (!isOwnSegment(named.id))
    return refuse(
      "which is not a URL path segment of its own (a request to it would reach another URL)",
    );
  const samples = [ctx.options.ids[target.key], ctx.options.ids[named.type]];
  if (Arr.contains(samples, named.id))
    return refuse("which the kit did not create (it is the `ids` sample)");
  const mine = Arr.filter(
    ctx.writes,
    (entry) => entry.type === target.key && entry.id === named.id,
  );
  // A read of what the kit itself created earlier — a read-back — shows that
  // id too; it says nothing about who made it, so only an id the kit never
  // took is refused for having been read.
  if (
    Arr.isReadonlyArrayEmpty(mine) &&
    MutableHashSet.has(ctx.observed, idKey(named.type, named.id))
  )
    return refuse("which the kit did not create (a read earlier in this run returned it)");
  if (Arr.some(mine, live))
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
      type: target.key,
      id,
      rule: rule.id,
      disposal: "left",
      detail: undefined,
    }),
    onFailure: (detail) => ({
      type: target.key,
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
  Result.match(build(target), {
    onFailure: (reason) => Effect.succeed(Created.Unbuilt({ reason })),
    onSuccess: (payload) =>
      via.send(payload).pipe(
        Effect.map((observation) =>
          Created.Sent({
            payload,
            observation,
            entry: isSuccessful(observation)
              ? Option.some(record(ctx, rule, target, payload, via.identify(observation)))
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
