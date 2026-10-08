/**
 * The write-fixture machinery: which endpoints a write rule can drive, how a
 * probe creates a disposable target from the caller's fixture, and how that
 * target is disposed of whatever the rule's probe went on to do.
 *
 * The kit cannot synthesise a payload a server will accept, nor undo what it
 * created, so both come from `Options.writes`. Everything here keeps two
 * promises the rules depend on:
 *
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
import { Cause, Effect, Exit } from "effect";
import { MEDIA_TYPE } from "../media.js";
import {
  type Context,
  type Discovered,
  type Finding,
  isRecord,
  type Observation,
  type Outcome,
  resolvePath,
  type Rule,
  settle,
  skip,
  type Fixture,
  type Payload,
  type WriteRecord,
} from "./core.js";

const MUTATING_SKIP =
  "mutating probe — pass `mutating: true` to run it against a disposable target";

/** The request headers every write probe sends. */
export const writeHeaders = {
  accept: MEDIA_TYPE,
  "content-type": MEDIA_TYPE,
};

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/**
 * One resource type a write rule can drive: its fixture, the URL its create
 * endpoint resolves to, and — for the update and delete rules — the endpoint
 * that acts on the resource the kit created.
 *
 * @internal
 */
export interface Target {
  /** The `writes` key — the create endpoint's first literal path segment. */
  readonly key: string;
  readonly fixture: Fixture;
  readonly createPath: string;
  readonly endpoint: Discovered;
}

/** @internal */
export interface Targets {
  readonly targets: ReadonlyArray<Target>;
  /** Why each other candidate endpoint could not be driven — names the missing option. */
  readonly missing: ReadonlyArray<string>;
  /** The candidate endpoints considered, so "none in this api" reads apart from "none usable". */
  readonly candidates: number;
}

const createEndpointFor = (ctx: Context, key: string | undefined): Discovered | undefined =>
  ctx.endpoints.find((endpoint) => endpoint.role === "create" && endpoint.segment === key);

/**
 * The endpoints of `role` a write rule can drive. For `"create"` that is every
 * create endpoint whose type has a `create` fixture; for `"update"` and
 * `"delete"` it is every such endpoint whose type also has a create endpoint
 * and fixture — the kit acts only on resources it created itself, never on a
 * caller's sample — and, for `"update"`, an `update` fixture.
 *
 * @internal
 */
export const targets = (ctx: Context, role: "create" | "update" | "delete"): Targets => {
  const out: Array<Target> = [];
  const missing: Array<string> = [];
  const candidates = ctx.endpoints.filter((endpoint) => endpoint.role === role);
  for (const endpoint of candidates) {
    const reason = unusable(ctx, role, endpoint);
    if (typeof reason === "string") missing.push(reason);
    else out.push(reason);
  }
  return { targets: out, missing, candidates: candidates.length };
};

/** The fixture for `key` if it can drive a rule of `role`, or why not — naming the `writes` key it lacks. */
const fixtureFor = (
  ctx: Context,
  role: "create" | "update" | "delete",
  key: string,
): Fixture | string => {
  const fixture = ctx.options.writes[key];
  if (fixture?.create === undefined)
    return `no create fixture for "${key}" — pass writes["${key}"].create`;
  if (role === "update" && fixture.update === undefined)
    return `no update fixture for "${key}" — pass writes["${key}"].update`;
  return fixture;
};

const unusable = (
  ctx: Context,
  role: "create" | "update" | "delete",
  endpoint: Discovered,
): Target | string => {
  const key = endpoint.segment;
  const create = role === "create" ? endpoint : createEndpointFor(ctx, key);
  if (key === undefined || create === undefined)
    return `${endpoint.method} ${endpoint.path} has no create endpoint to make a disposable target with`;
  const fixture = fixtureFor(ctx, role, key);
  if (typeof fixture === "string") return fixture;
  if (role !== "create" && endpoint.params.length !== 1)
    return `${endpoint.path} has ${endpoint.params.length} path parameters — the kit can substitute only the id it created`;
  const resolution = resolvePath(create, ctx.options);
  return resolution._tag === "Unresolved"
    ? resolution.reason
    : { key, fixture, createPath: resolution.path, endpoint };
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
  const out: Array<Target> = [];
  for (const key of Object.keys(ctx.options.writes)) {
    const fixture = ctx.options.writes[key]!;
    if (fixture.create === undefined) continue;
    out.push({ key, fixture, createPath: operations.path, endpoint: operations });
  }
  return {
    targets: out,
    missing: out.length === 0 ? [noAtomicFixture(ctx, operations)] : [],
    candidates: 1,
  };
};

/** The skip reason when no type has a `create` fixture, naming the keys the api suggests. */
const noAtomicFixture = (ctx: Context, operations: Discovered): string => {
  const keys = ctx.endpoints
    .filter((endpoint) => endpoint.role === "create" && endpoint.segment !== undefined)
    .map((endpoint) => `writes["${endpoint.segment}"].create`);
  return `no create fixture to send to ${operations.path} — pass ${
    keys.length === 0 ? `writes["<type>"].create for a type it accepts` : keys.join(" or ")
  }`;
};

/**
 * The URL of the resource the kit created, through `endpoint`'s path.
 *
 * @internal
 */
export const pathFor = (endpoint: Discovered, id: string): string =>
  endpoint.path.replace(`:${endpoint.params[0]}`, encodeURIComponent(id));

// ---------------------------------------------------------------------------
// Creating and disposing
// ---------------------------------------------------------------------------

type Entry = Context["writes"][number];

/**
 * What a write probe's creation produced: the fixture threw before anything
 * was sent, or a request was sent — with the ledger entry for what it created,
 * if it created anything.
 *
 * @internal
 */
export type Created =
  | { readonly _tag: "Unbuilt"; readonly reason: string }
  | {
      readonly _tag: "Sent";
      readonly payload: Payload;
      readonly observation: Observation;
      /** `undefined` when the request was not answered with a 2xx. */
      readonly entry: Entry | undefined;
    };

/**
 * The id of the resource a create response's primary data carries.
 *
 * @internal
 */
export const primaryId = (body: unknown): string | undefined => {
  if (!isRecord(body) || !isRecord(body["data"])) return undefined;
  const id = body["data"]["id"];
  return typeof id === "string" ? id : undefined;
};

const build = (target: Target): Payload | string => {
  try {
    return target.fixture.create!();
  } catch (error) {
    return `writes["${target.key}"].create threw: ${String(error)}`;
  }
};

/**
 * The fixture's update, or why there is none — `update` threw.
 *
 * @internal
 */
export const buildUpdate = (target: Target): Omit<Payload, "type"> | string => {
  try {
    return target.fixture.update!();
  } catch (error) {
    return `writes["${target.key}"].update threw: ${String(error)}`;
  }
};

const record = (ctx: Context, rule: Rule, target: Target, id: string | undefined): Entry => {
  const entry: Entry = {
    type: target.key,
    id,
    rule: rule.id,
    disposal: "left",
    // With an id, `dispose` settles both fields once the probe is done with it.
    detail:
      id === undefined ? "the response named no id, so nothing could be cleaned up" : undefined,
  };
  ctx.writes.push(entry);
  return entry;
};

/**
 * Disposes of what a probe created, unless the probe's own DELETE already did.
 * Never fails: a cleanup that fails or dies is recorded, not propagated, so one
 * bad cleanup cannot cost the rest of the run its report.
 */
const dispose = (target: Target, created: Created): Effect.Effect<void> => {
  if (created._tag === "Unbuilt") return Effect.void;
  const entry = created.entry;
  if (entry === undefined || entry.id === undefined || entry.disposal !== "left")
    return Effect.void;
  const id = entry.id;
  const cleanup = target.fixture.cleanup;
  if (cleanup === undefined) {
    entry.detail = `no cleanup — pass writes["${target.key}"].cleanup to remove it`;
    return Effect.void;
  }
  return Effect.exit(Effect.suspend(() => cleanup(id))).pipe(
    Effect.map((exit) => {
      if (Exit.isSuccess(exit)) {
        entry.disposal = "cleaned-up";
        entry.detail = undefined;
      } else {
        entry.disposal = "cleanup-failed";
        entry.detail = Cause.pretty(exit.cause).split("\n")[0];
      }
    }),
  );
};

/**
 * Creates a disposable target from `target`'s fixture by `send`ing its payload,
 * hands the result to `use`, and then disposes of whatever was created —
 * however `use` exits.
 *
 * `idOf` reads the created resource's id off the response body; a 2xx whose
 * body names none is still recorded, as left behind.
 *
 * @internal
 */
export const withCreated = <A>(
  ctx: Context,
  rule: Rule,
  target: Target,
  options: {
    readonly send: (payload: Payload) => Effect.Effect<Observation>;
    readonly idOf: (body: unknown) => string | undefined;
  },
  use: (created: Created) => Effect.Effect<A>,
): Effect.Effect<A> =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const payload = build(target);
      if (typeof payload === "string") {
        const unbuilt: Created = { _tag: "Unbuilt", reason: payload };
        return unbuilt;
      }
      const observation = yield* options.send(payload);
      const ok = observation.status >= 200 && observation.status < 300;
      const entry = ok ? record(ctx, rule, target, options.idOf(observation.body)) : undefined;
      const sent: Created = { _tag: "Sent", payload, observation, entry };
      return sent;
    }),
    use,
    (created) => dispose(target, created),
  );

/**
 * Creates through the target's own create endpoint — `POST /<type>` with the
 * fixture's payload as primary data.
 *
 * @internal
 */
export const viaCreateEndpoint = (ctx: Context, target: Target) => ({
  send: (payload: Payload) =>
    ctx.request({
      method: "POST",
      url: target.createPath,
      headers: writeHeaders,
      body: { data: payload },
    }),
  idOf: primaryId,
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
export type Verdict =
  | {
      readonly _tag: "Decided";
      readonly requests: number;
      readonly findings: ReadonlyArray<Finding>;
    }
  | { readonly _tag: "Undecided"; readonly reason: string };

/** @internal */
export const decided = (requests: number, findings: ReadonlyArray<Finding>): Verdict => ({
  _tag: "Decided",
  requests,
  findings,
});

/** @internal */
export const undecided = (reason: string): Verdict => ({ _tag: "Undecided", reason });

/**
 * A creation the server accepted: a 2xx, on the record.
 *
 * @internal
 */
export type Accepted = Extract<Created, { readonly _tag: "Sent" }> & { readonly entry: Entry };

/**
 * The accepted creation, or why there is none: the fixture threw, or the server
 * did not accept the fixture's payload. Neither is a verdict on a rule — a
 * payload the server rejects proves nothing about what it answers on success —
 * so both read as "not checked", naming the cause.
 *
 * @internal
 */
export const accepted = (target: Target, created: Created): Accepted | string => {
  if (created._tag === "Unbuilt") return created.reason;
  if (created.entry !== undefined) return { ...created, entry: created.entry };
  const { status, text } = created.observation;
  return `the server did not accept writes["${target.key}"].create (${status}${
    text === "" ? "" : ` — ${text.slice(0, 160)}`
  }) — a write rule needs a payload the server accepts`;
};

/**
 * A rule decided on the resource a create probe made: `decide` runs only when
 * the server accepted the fixture's payload.
 *
 * @internal
 */
export const onAccepted =
  (target: Target, decide: (created: Accepted) => Effect.Effect<Verdict>) =>
  (created: Created): Effect.Effect<Verdict> => {
    const result = accepted(target, created);
    return typeof result === "string" ? Effect.succeed(undecided(result)) : decide(result);
  };

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
  probe: (target: Target) => Effect.Effect<Verdict>,
): Effect.Effect<Outcome> =>
  Effect.gen(function* () {
    if (!ctx.options.mutating) return skip(rule, MUTATING_SKIP);
    if (found.candidates === 0) return skip(rule, `no ${what} in this api`);
    // One target at a time: each creates and disposes of server state, and a
    // concurrent create could trip a uniqueness rule the fixture relies on.
    const verdicts = yield* Effect.forEach(found.targets, probe, { concurrency: 1 });
    const settled = verdicts.flatMap((verdict) => (verdict._tag === "Decided" ? [verdict] : []));
    const reasons = [
      ...found.missing,
      ...verdicts.flatMap((verdict) => (verdict._tag === "Undecided" ? [verdict.reason] : [])),
    ];
    if (settled.length === 0) return skip(rule, reasons.join("; "));
    return settle(
      rule,
      settled.reduce((total, verdict) => total + verdict.requests, 0),
      settled.flatMap((verdict) => verdict.findings),
      reasons.length === 0 ? undefined : `not decided for: ${reasons.join("; ")}`,
    );
  });

/**
 * The run's writes as report data — a snapshot, so the report does not alias
 * the ledger the rules appended to.
 *
 * @internal
 */
export const snapshot = (ctx: Context): ReadonlyArray<WriteRecord> =>
  ctx.writes.map((entry) => ({ ...entry }));
