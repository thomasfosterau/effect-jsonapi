/**
 * The relationship mutation rules ([§Updating a Resource's Relationships]
 * (https://jsonapi.org/format/1.1/#crud-updating-relationships)): a `PATCH`
 * to a relationship URL replaces its linkage, a `POST` adds to a to-many one
 * and a `DELETE` removes from it — each judged by reading the linkage back
 * through `GET /<type>/:id/relationships/<name>`, never by the write's answer
 * alone.
 *
 * Each probe acts on a resource it created from the type's `writes` fixture
 * (`withCreated`, `./write.ts`), disposed of however the rule ends, and links
 * it to the `ids` sample of a type the write endpoint's payload names. The
 * sample is only linked to, never written to itself. A write the server does
 * not accept — a `403` included, which the specification allows for a
 * replacement or removal the server does not permit — decides nothing, nor
 * does a `202`, nor a read the server cannot answer.
 *
 * @since 0.18.0
 * @internal
 */
import { Array as Arr, Effect, Formatter, Option, Order, Result, Schema } from "effect";
import {
  type Context,
  describe,
  type Discovered,
  finding,
  isRecord,
  jsonApiAccept,
  type Observation,
  type Outcome,
  type Rule,
  type RuleImpl,
  statusOf,
  succeeded,
} from "./core.js";
import {
  decided,
  Identity,
  plusRequests,
  overTargets,
  onOwnId,
  pathFor,
  sendLinkage,
  targets,
  undecided,
  type Verdict,
  viaCreateEndpoint,
  withCreated,
  type WriteTarget,
} from "./write.js";

const SPEC = "https://jsonapi.org/format/1.1";

const rule = (id: string, anchor: string, requirement: string): Rule => ({
  id,
  tier: "spec",
  section: "Updating Relationships",
  reference: `${SPEC}/#${anchor}`,
  level: "MUST",
  requirement,
});

/** An identifier as a linkage label: `type:id`. */
const label = ({ type, id }: Identity): string => `${type}:${id}`;

const decodeIdentity = Schema.decodeUnknownOption(Identity);

/** One linkage member as a label: an identifier's `type:id`, anything else as it renders. */
const memberLabel = (item: unknown): string =>
  Option.match(decodeIdentity(item), { onNone: () => Formatter.format(item), onSome: label });

/** The linkage a read's `data` holds, as sorted labels — none when it is not linkage. */
const labelsOf = (data: unknown): Option.Option<ReadonlyArray<string>> => {
  if (data === null) return Option.some([]);
  if (Array.isArray(data)) return Option.some(Arr.sort(Arr.map(data, memberLabel), Order.String));
  return isRecord(data) ? Option.some([memberLabel(data)]) : Option.none();
};

const shown = (labels: ReadonlyArray<string>): string =>
  Arr.match(labels, {
    onEmpty: () => "no linkage",
    onNonEmpty: (members) => `[${members.join(", ")}]`,
  });

/** What one relationship write probe needs beside the resource it creates. */
interface Plan {
  readonly endpoint: Discovered;
  /** The relationship's GET, which the linkage is read back through. */
  readonly read: Discovered;
  readonly sample: Identity;
}

/** The plan for `target`'s relationship write endpoint, or why there is none. */
const planFor = (ctx: Context, target: WriteTarget): Result.Result<Plan, string> =>
  Result.gen(function* () {
    const endpoint = target.endpoint;
    const read = yield* Result.fromOption(
      Arr.findFirst(
        ctx.endpoints,
        (candidate) => candidate.role === "relationship" && candidate.path === endpoint.path,
      ),
      () => `no GET ${endpoint.path} to read the linkage ${endpoint.method} writes back through`,
    );
    const sample = yield* Result.fromOption(
      Arr.findFirst(endpoint.linkageTypes, (type) =>
        Option.map(Option.fromUndefinedOr(ctx.options.ids[type]), (id) => ({ type, id })),
      ),
      () =>
        Arr.match(endpoint.linkageTypes, {
          onEmpty: () =>
            `the payload of ${endpoint.method} ${endpoint.path} names no resource type to link to`,
          onNonEmpty: (types) =>
            `no \`ids\` sample to link through ${endpoint.method} ${endpoint.path} — pass ${types.map((type) => `ids["${type}"]`).join(" or ")}`,
        }),
    );
    return { endpoint, read, sample };
  });

/** A read of the relationship's linkage: its labels, or the verdict a read that shows none reaches. */
const readLinkage = (
  ctx: Context,
  impl: Rule,
  url: string,
  what: string,
  final: boolean,
): Effect.Effect<Result.Result<ReadonlyArray<string>, Verdict>> =>
  ctx.request({ url, headers: jsonApiAccept }).pipe(
    Effect.map((observation) => {
      if (final && (observation.status === 404 || observation.status === 410))
        return Result.fail(
          decided(1, [
            finding(impl, {
              detail: `${url}, ${what}, does not read back`,
              expected: "the relationship's linkage",
              observed: describe(observation),
              probe: observation.probe,
            }),
          ]),
        );
      if (!succeeded(observation))
        return Result.fail(
          undecided(
            `reading ${url} ${what} answered ${statusOf(observation)} (${describe(observation)})`,
          ),
        );
      const data = isRecord(observation.body) ? labelsOf(observation.body["data"]) : Option.none();
      return Result.fromOption(data, () =>
        undecided(`reading ${url} ${what} answered no resource linkage (${describe(observation)})`),
      );
    }),
  );

/** A write's answer, if it decides nothing; none when it was accepted and is final. */
const unaccepted = (
  endpoint: Discovered,
  url: string,
  observation: Observation,
): Option.Option<Verdict> => {
  if (observation.status === 202)
    return Option.some(
      undecided(
        `${endpoint.method} ${url} answered 202 Accepted — the change is deferred, so there is nothing stored to read back yet`,
      ),
    );
  return succeeded(observation)
    ? Option.none()
    : Option.some(
        undecided(
          `the server did not accept ${endpoint.method} ${url}, on the resource the kit had just created (${describe(observation)})`,
        ),
      );
};

/**
 * Sends `data` through `endpoint`, on the resource `id`: the answer, or the
 * verdict when it decides nothing (see {@link unaccepted}).
 */
const write = (
  ctx: Context,
  endpoint: Discovered,
  id: string,
  data: Identity | ReadonlyArray<Identity>,
): Effect.Effect<Result.Result<Observation, Verdict>> => {
  const url = pathFor(endpoint, id);
  return sendLinkage(ctx, endpoint, url, data).pipe(
    Effect.map((sent) =>
      Option.match(unaccepted(endpoint, url, sent), {
        onNone: () => Result.succeed(sent),
        onSome: Result.fail,
      }),
    ),
  );
};

/**
 * The verdict on the final read-back: `expected` and what was read must hold
 * the same identifiers, in any order. `requests` counts the probe's requests
 * before the read.
 */
const judgeReadBack = (
  impl: Rule,
  requests: number,
  url: string,
  sent: Observation,
  expected: ReadonlyArray<string>,
  read: ReadonlyArray<string>,
  what: string,
): Verdict =>
  decided(
    requests + 1,
    Arr.sort(expected, Order.String).join("\n") === read.join("\n")
      ? []
      : [
          finding(impl, {
            detail: `after ${sent.probe.method} ${sent.probe.url} ${what}, ${url} reads back ${shown(read)}`,
            expected: shown(Arr.sort(expected, Order.String)),
            observed: shown(read),
            probe: sent.probe,
          }),
        ],
  );

/** What a probe does to the resource `id` the kit created, under `plan`. */
type Mutate = (ctx: Context, plan: Plan, id: string) => Effect.Effect<Verdict>;

/**
 * One probe per relationship write endpoint of `method` whose type has a
 * create endpoint and fixture: create a resource, `mutate` its linkage, and
 * dispose of it.
 */
const overRelationshipWrites = (
  ctx: Context,
  impl: Rule,
  method: string,
  mutate: Mutate,
): Effect.Effect<Outcome> =>
  overTargets(
    ctx,
    impl,
    targets(ctx, "relationshipWrite", (endpoint) => endpoint.method === method),
    `${method} relationship endpoint`,
    (target) =>
      Result.match(planFor(ctx, target), {
        onFailure: (reason) => Effect.succeed(undecided(reason)),
        onSuccess: (plan) =>
          withCreated(
            ctx,
            impl,
            target,
            viaCreateEndpoint(ctx, target),
            onOwnId(target, (_, id) =>
              mutate(ctx, plan, id).pipe(Effect.map((verdict) => plusRequests(verdict, 1))),
            ),
          ),
      }),
  );

/**
 * Reads the linkage back after `sent`, a write the server accepted, and
 * judges it against `expected`; `before` counts the probe's requests so far.
 */
const readBackAfter = (
  ctx: Context,
  impl: Rule,
  plan: Plan,
  id: string,
  before: number,
  sent: Observation,
  expected: ReadonlyArray<string>,
  what: string,
): Effect.Effect<Verdict> => {
  const url = pathFor(plan.read, id);
  return readLinkage(ctx, impl, url, "afterwards", true).pipe(
    Effect.map(
      Result.match({
        onFailure: (verdict) => plusRequests(verdict, before),
        onSuccess: (read) => judgeReadBack(impl, before, url, sent, expected, read, what),
      }),
    ),
  );
};

/** Why a `POST` / `DELETE` probe cannot run on `plan`'s endpoint, if it cannot: a to-one relationship. */
const toOne = ({ endpoint }: Plan): Option.Option<Verdict> =>
  endpoint.linkage === "one"
    ? Option.some(
        undecided(
          `the payload of ${endpoint.method} ${endpoint.path} declares a to-one relationship — only a to-many one is added to or removed from`,
        ),
      )
    : Option.none();

// ---------------------------------------------------------------------------
// PATCH: replace
// ---------------------------------------------------------------------------

const replace: Mutate = (ctx, plan, id) =>
  Effect.gen(function* () {
    const { endpoint, sample } = plan;
    if (endpoint.linkage === "unshown")
      return undecided(
        `the payload of PATCH ${endpoint.path} declares neither a to-one nor a to-many relationship`,
      );
    const sent = yield* write(ctx, endpoint, id, endpoint.linkage === "one" ? sample : [sample]);
    if (Result.isFailure(sent)) return sent.failure;
    return yield* readBackAfter(
      ctx,
      updateReplaces.rule,
      plan,
      id,
      1,
      sent.success,
      [label(sample)],
      `replacing its linkage with ${label(sample)}`,
    );
  });

const updateReplaces: RuleImpl = {
  creates: true,
  rule: rule(
    "spec/relationships/update-replaces",
    "crud-updating-relationships",
    "A PATCH to a URL from a relationship link replaces the relationship: a to-one relationship with the resource identifier object (or `null`) its `data` carries; for a to-many relationship the server MUST either completely replace every member of the relationship, return an appropriate error response if some resources can not be found or accessed, or return a 403 Forbidden response if complete replacement is not allowed by the server.",
  ),
  run: (ctx) => overRelationshipWrites(ctx, updateReplaces.rule, "PATCH", replace),
};

// ---------------------------------------------------------------------------
// POST: append
// ---------------------------------------------------------------------------

const append: Mutate = (ctx, plan, id) =>
  Effect.gen(function* () {
    const one = toOne(plan);
    if (Option.isSome(one)) return one.value;
    const { endpoint, read, sample } = plan;
    const before = yield* readLinkage(
      ctx,
      addAppends.rule,
      pathFor(read, id),
      "before the POST",
      false,
    );
    if (Result.isFailure(before)) return before.failure;
    const sent = yield* write(ctx, endpoint, id, [sample]);
    if (Result.isFailure(sent)) return sent.failure;
    return yield* readBackAfter(
      ctx,
      addAppends.rule,
      plan,
      id,
      2,
      sent.success,
      Arr.dedupe([...before.success, label(sample)]),
      `adding ${label(sample)} to ${shown(before.success)}`,
    );
  });

const addAppends: RuleImpl = {
  creates: true,
  rule: rule(
    "spec/relationships/add-appends",
    "crud-updating-to-many-relationships",
    "If a client makes a POST request to a URL from a relationship link, the server MUST add the specified members to the relationship unless they are already present.",
  ),
  run: (ctx) => overRelationshipWrites(ctx, addAppends.rule, "POST", append),
};

// ---------------------------------------------------------------------------
// DELETE: remove
// ---------------------------------------------------------------------------

/**
 * The endpoint that links the sample before a removal can remove it: the
 * relationship's `POST`, or else its `PATCH` (which replaces the linkage with
 * the sample alone).
 */
const linkerFor = (ctx: Context, { endpoint }: Plan): Option.Option<Discovered> => {
  const on = (method: string) =>
    Arr.findFirst(
      ctx.endpoints,
      (candidate) =>
        candidate.role === "relationshipWrite" &&
        candidate.method === method &&
        candidate.path === endpoint.path,
    );
  return Option.orElse(on("POST"), () => on("PATCH"));
};

/**
 * The linkage before the DELETE, holding the sample: as first read, or — when
 * that does not hold it — after linking it through {@link linkerFor}. Fails
 * with the verdict when there is none; succeeds with the requests it made.
 */
const linkedBefore = (
  ctx: Context,
  plan: Plan,
  id: string,
): Effect.Effect<
  Result.Result<{ readonly linked: ReadonlyArray<string>; readonly requests: number }, Verdict>
> =>
  Effect.gen(function* () {
    const readUrl = pathFor(plan.read, id);
    const read = (what: string) => readLinkage(ctx, removeDeletes.rule, readUrl, what, false);
    const first = yield* read("before the DELETE");
    if (Result.isFailure(first)) return Result.fail(first.failure);
    const wanted = label(plan.sample);
    if (first.success.includes(wanted))
      return Result.succeed({ linked: first.success, requests: 1 });
    const linker = linkerFor(ctx, plan);
    if (Option.isNone(linker))
      return Result.fail(
        undecided(
          `${readUrl} does not link ${wanted}, and there is no POST or PATCH ${plan.endpoint.path} to link it with before removing it`,
        ),
      );
    const url = pathFor(linker.value, id);
    const sent = yield* write(ctx, linker.value, id, [plan.sample]);
    if (Result.isFailure(sent)) return Result.fail(sent.failure);
    const second = yield* read(`after ${linker.value.method} ${url}`);
    if (Result.isFailure(second)) return Result.fail(second.failure);
    return second.success.includes(wanted)
      ? Result.succeed({ linked: second.success, requests: 3 })
      : Result.fail(
          undecided(
            `${linker.value.method} ${url} did not link ${wanted} to remove — see spec/relationships/${linker.value.method === "POST" ? "add-appends" : "update-replaces"}`,
          ),
        );
  });

const remove: Mutate = (ctx, plan, id) =>
  Effect.gen(function* () {
    const one = toOne(plan);
    if (Option.isSome(one)) return one.value;
    const before = yield* linkedBefore(ctx, plan, id);
    if (Result.isFailure(before)) return before.failure;
    const { linked, requests } = before.success;
    const { endpoint, sample } = plan;
    const sent = yield* write(ctx, endpoint, id, [sample]);
    if (Result.isFailure(sent)) return sent.failure;
    return yield* readBackAfter(
      ctx,
      removeDeletes.rule,
      plan,
      id,
      requests + 1,
      sent.success,
      linked.filter((member) => member !== label(sample)),
      `removing ${label(sample)} from ${shown(linked)}`,
    );
  });

const removeDeletes: RuleImpl = {
  creates: true,
  rule: rule(
    "spec/relationships/remove-deletes",
    "crud-updating-to-many-relationships",
    "If the client makes a DELETE request to a URL from a relationship link the server MUST delete the specified members from the relationship or return a 403 Forbidden response.",
  ),
  run: (ctx) => overRelationshipWrites(ctx, removeDeletes.rule, "DELETE", remove),
};

/**
 * The relationship mutation rules, in report order.
 *
 * @internal
 */
export const relationshipRules: ReadonlyArray<RuleImpl> = [
  updateReplaces,
  addAppends,
  removeDeletes,
];
