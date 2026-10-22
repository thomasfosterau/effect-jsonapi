/**
 * The relationship-mutation rules: `PATCH`, `POST` and `DELETE` on a
 * relationship endpoint (`/articles/1/relationships/comments`) replace, add
 * to and remove from a resource's linkage, judged by what the relationship
 * endpoint reads back afterwards (JSON:API 1.1 §Updating Relationships).
 *
 * Each probe acts on a resource the kit created from the write fixture
 * (`./write.ts`), never on a caller's sample, and links it to the `ids`
 * sample of the related type, which it never changes. The related type and
 * the relationship's cardinality are read off the relationship endpoint's
 * declared success schema.
 *
 * @since 0.17.0
 * @internal
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Equivalence from "effect/Equivalence";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import {
  type Context,
  describe,
  type Discovered,
  finding,
  isRecord,
  jsonApiAccept,
  type Observation,
  type Rule,
  type RuleImpl,
  statusOf,
  succeeded,
} from "./core.js";
import {
  decided,
  idempotencyHeaders,
  onAccepted,
  ownId,
  overTargets,
  pathFor,
  refusedOnKeyGrounds,
  targets,
  undecided,
  type Verdict,
  viaCreateEndpoint,
  withCreated,
  writeHeaders,
  type WriteTarget,
} from "./write.js";

const rule = (id: string, anchor: string, requirement: string): Rule => ({
  id,
  tier: "spec",
  section: "Updating Relationships",
  reference: `https://jsonapi.org/format/1.1/#${anchor}`,
  level: "MUST",
  requirement,
});

/** A resource identifier as the kit sends it. */
interface Identifier {
  readonly type: string;
  readonly id: string;
}

/**
 * What a relationship write needs beyond its target: the relationship endpoint
 * to read the linkage back through, whether the relationship is to-many, and
 * the identifier to link to.
 */
interface Plan {
  readonly read: Discovered;
  readonly many: boolean;
  readonly link: Identifier;
}

const label = ({ type, id }: Identifier): string => `${type}:${id}`;

/** A linkage as a finding shows it: `null`, or its identifiers in brackets. */
const rendered = (linkage: ReadonlyArray<string>, many: boolean): string =>
  many ? `[${linkage.join(", ")}]` : (linkage[0] ?? "null");

/** The relationship endpoint, cardinality and related sample a write to `target` needs, or why there is none. */
const planFor = (ctx: Context, target: WriteTarget): Result.Result<Plan, string> =>
  Result.gen(function* () {
    const write = target.endpoint;
    const read = yield* Result.fromOption(
      Arr.findFirst(
        ctx.endpoints,
        (endpoint) => endpoint.role === "relationship" && endpoint.path === write.path,
      ),
      () => `no GET ${write.path} to read the linkage back through`,
    );
    if (read.linkage === "unshown")
      return yield* Result.fail(`${read.path} declares no cardinality the kit can read`);
    const link = yield* Result.fromOption(
      Arr.findFirst(read.linkageTypes, (type) =>
        Option.map(Option.fromUndefinedOr(ctx.options.ids[type]), (id): Identifier => ({
          type,
          id,
        })),
      ),
      () =>
        Arr.match(read.linkageTypes, {
          onEmpty: () => `${read.path} declares no identifier type the kit can read`,
          onNonEmpty: ([first]) => `no \`ids\` sample to link to — pass ids["${first}"]`,
        }),
    );
    return { read, many: read.linkage === "many", link };
  });

/** One identifier of a linkage document's `data`, as `type:id`, if it is one. */
// oxlint-disable-next-line effect/no-unknown-parameters -- reads whatever JSON a server put in a linkage document's `data`; it has no schema to parse it by
const identifierLabel = (value: unknown): Option.Option<string> =>
  isRecord(value) && Predicate.isString(value["type"]) && Predicate.isString(value["id"])
    ? Option.some(`${value["type"]}:${value["id"]}`)
    : Option.none();

/**
 * The linkage a relationship endpoint answered, as `type:id` labels sorted
 * (JSON:API gives a to-many linkage no order a read must keep) — or why the
 * answer holds none of the relationship's cardinality.
 */
const linkageIn = (
  observation: Observation,
  plan: Plan,
  id: string,
): Result.Result<ReadonlyArray<string>, string> => {
  const where = `reading ${pathFor(plan.read, id)}`;
  if (!succeeded(observation)) return Result.fail(`${where} answered ${statusOf(observation)}`);
  const data = isRecord(observation.body) ? observation.body["data"] : undefined;
  const items = plan.many
    ? Array.isArray(data)
      ? Option.some(data)
      : Option.none()
    : data === null
      ? Option.some([])
      : Option.some([data]);
  return Result.fromOption(
    Option.flatMap(items, (values) => Option.all(Arr.map(values, identifierLabel))),
    () => `${where} answered no ${plan.many ? "to-many" : "to-one"} resource linkage`,
  ).pipe(Result.map((labels) => Arr.sort(labels, Order.String)));
};

const sameLinkage = Arr.makeEquivalence(Equivalence.String);

/** The probe's requests: each counted as it is sent. */
interface Tally {
  sent: number;
}

const readLinkage = (ctx: Context, tally: Tally, plan: Plan, id: string) =>
  Effect.map(
    ctx.request({ url: pathFor(plan.read, id), headers: jsonApiAccept }),
    (observation) => {
      tally.sent += 1;
      return { observation, linkage: linkageIn(observation, plan, id) };
    },
  );

/**
 * Sends `data` to the created resource's relationship through `endpoint`, and
 * answers the observation when the server accepted it — `200` or `204` — or
 * why the write decides nothing: deferred (`202`), refused (`403`, which
 * §Updating Relationships allows a server that does not permit the change),
 * refused over `Idempotency-Key`, or otherwise not accepted.
 */
const mutate = (
  ctx: Context,
  tally: Tally,
  endpoint: Discovered,
  id: string,
  data: Identifier | ReadonlyArray<Identifier>,
): Effect.Effect<Result.Result<Observation, string>> =>
  idempotencyHeaders(endpoint).pipe(
    Effect.flatMap((key) =>
      ctx.request({
        method: endpoint.method,
        url: pathFor(endpoint, id),
        headers: { ...writeHeaders, ...key },
        body: { data },
      }),
    ),
    Effect.map((observation) => {
      tally.sent += 1;
      const request = `${endpoint.method} ${pathFor(endpoint, id)}`;
      if (observation.status === 200 || observation.status === 204)
        return Result.succeed(observation);
      if (observation.status === 202)
        return Result.fail(`${request} answered 202 Accepted — deferred, so nothing to read back`);
      if (refusedOnKeyGrounds(endpoint, observation.probe.headers, observation))
        return Result.fail(
          `${request} was refused over \`Idempotency-Key\` (${describe(observation)})`,
        );
      if (observation.status === 403)
        return Result.fail(
          `${request} was refused with 403, which a server may answer a relationship change it does not allow`,
        );
      return Result.fail(`the server did not accept ${request} (${describe(observation)})`);
    }),
  );

/** The finding for a linkage that read back otherwise than the write said it would be. */
const misread = (
  self: Rule,
  plan: Plan,
  write: Observation,
  read: Observation,
  {
    did,
    expected,
    actual,
  }: {
    readonly did: string;
    readonly expected: ReadonlyArray<string>;
    readonly actual: ReadonlyArray<string>;
  },
) =>
  finding(self, {
    detail: `after ${write.probe.method} ${write.probe.url} ${did}, ${read.probe.url} reads back ${rendered(actual, plan.many)}`,
    expected: `the linkage ${rendered(expected, plan.many)}`,
    observed: describe(read),
    probe: write.probe,
  });

/**
 * Runs `probe` on a resource created from `target`'s fixture and the plan for
 * its relationship, settling as undecided whatever stops it short.
 */
const onCreated = (
  ctx: Context,
  self: Rule,
  target: WriteTarget,
  probe: (plan: Plan, id: string, tally: Tally) => Effect.Effect<Result.Result<Verdict, string>>,
): Effect.Effect<Verdict> =>
  Result.match(planFor(ctx, target), {
    onFailure: (reason) => Effect.succeed(undecided(reason)),
    onSuccess: (plan) =>
      withCreated(
        ctx,
        self,
        target,
        viaCreateEndpoint(ctx, target),
        onAccepted(target, (created) =>
          Result.match(ownId(created), {
            onFailure: (reason) => Effect.succeed(undecided(reason)),
            onSuccess: (id) => {
              const tally: Tally = { sent: 1 };
              return Effect.map(probe(plan, id, tally), Result.getOrElse(undecided));
            },
          }),
        ),
      ),
  });

/** A rule over every relationship write endpoint of `method` the write fixture can drive. */
const overRelationshipWrites = (
  ctx: Context,
  self: Rule,
  method: string,
  probe: (target: WriteTarget) => Effect.Effect<Verdict>,
) =>
  overTargets(
    ctx,
    self,
    targets(ctx, "relationshipWrite", (endpoint) => endpoint.method === method),
    `${method} relationship endpoint`,
    probe,
  );

/** The linkage read back, or the reason it could not be — a `Result` the probes chain on. */
const linkageOf = ({
  linkage,
}: {
  readonly linkage: Result.Result<ReadonlyArray<string>, string>;
}) => linkage;

/**
 * Sends `data` to the created resource's relationship, reads the linkage back
 * and judges it against `expected`; `did` says what the write was to do.
 */
const writeThenRead = (
  ctx: Context,
  self: Rule,
  target: WriteTarget,
  plan: Plan,
  id: string,
  tally: Tally,
  change: {
    readonly data: Identifier | ReadonlyArray<Identifier>;
    readonly did: string;
    readonly expected: ReadonlyArray<string>;
  },
) =>
  Effect.gen(function* () {
    const write = yield* mutate(ctx, tally, target.endpoint, id, change.data);
    if (Result.isFailure(write)) return Result.fail(write.failure);
    const read = yield* readLinkage(ctx, tally, plan, id);
    return Result.map(linkageOf(read), (actual) =>
      decided(
        tally.sent,
        sameLinkage(actual, change.expected)
          ? []
          : [
              misread(self, plan, write.success, read.observation, {
                did: change.did,
                expected: change.expected,
                actual,
              }),
            ],
      ),
    );
  });

// ---------------------------------------------------------------------------
// PATCH: replace
// ---------------------------------------------------------------------------

const replaceRule = rule(
  "spec/relationships/replace",
  "crud-updating-relationships",
  "A PATCH to a relationship endpoint MUST replace the relationship's linkage with the request's `data` — a resource identifier (or `null`) for a to-one relationship, every member for a to-many one — so the relationship endpoint, read afterwards, answers exactly that linkage.",
);

const replace: RuleImpl = {
  creates: true,
  rule: replaceRule,
  run: (ctx) =>
    overRelationshipWrites(ctx, replaceRule, "PATCH", (target) =>
      onCreated(ctx, replaceRule, target, (plan, id, tally) =>
        writeThenRead(ctx, replaceRule, target, plan, id, tally, {
          data: plan.many ? [plan.link] : plan.link,
          did: `replaced the linkage with ${rendered([label(plan.link)], plan.many)}`,
          expected: [label(plan.link)],
        }),
      ),
    ),
};

// ---------------------------------------------------------------------------
// POST: add
// ---------------------------------------------------------------------------

/** What a to-many write leaves: `before` with `label` added once, or taken out. */
const withMember = (before: ReadonlyArray<string>, member: string): ReadonlyArray<string> =>
  Arr.sort(Arr.dedupe([...before, member]), Order.String);

const withoutMember = (before: ReadonlyArray<string>, member: string): ReadonlyArray<string> =>
  Arr.filter(before, (held) => held !== member);

/** Why a to-one relationship decides nothing for a rule about to-many ones. */
const toOne = (target: WriteTarget, plan: Plan): string =>
  `${target.endpoint.method} ${target.endpoint.path} writes a to-one relationship (${plan.read.path} declares one identifier), which only PATCH may change`;

const addRule = rule(
  "spec/relationships/add",
  "crud-updating-to-many-relationships",
  "A POST to a to-many relationship endpoint MUST add every specified member not already in the relationship, and MUST NOT add a member that is already there — so the relationship endpoint, read afterwards, answers the linkage it held before plus each new member, once.",
);

/**
 * Sends `send` to the created resource's to-many relationship, between two
 * reads of its linkage, and judges the second read against `expect` applied
 * to the first.
 */
const judgedBetweenReads = (
  ctx: Context,
  self: Rule,
  target: WriteTarget,
  plan: Plan,
  id: string,
  tally: Tally,
  change: {
    readonly did: string;
    readonly expect: (before: ReadonlyArray<string>) => ReadonlyArray<string>;
    /** Why the first read leaves nothing to judge, when it does. */
    readonly unready?: (before: ReadonlyArray<string>) => Option.Option<string>;
  },
) =>
  Effect.gen(function* () {
    const before = Result.flatMap(linkageOf(yield* readLinkage(ctx, tally, plan, id)), (held) =>
      Option.match(change.unready?.(held) ?? Option.none(), {
        onNone: () => Result.succeed(held),
        onSome: Result.fail,
      }),
    );
    if (Result.isFailure(before)) return Result.fail(before.failure);
    return yield* writeThenRead(ctx, self, target, plan, id, tally, {
      data: [plan.link],
      did: `${change.did} over ${rendered(before.success, true)}`,
      expected: change.expect(before.success),
    });
  });

const add: RuleImpl = {
  creates: true,
  rule: addRule,
  run: (ctx) =>
    overRelationshipWrites(ctx, addRule, "POST", (target) =>
      onCreated(ctx, addRule, target, (plan, id, tally) =>
        plan.many
          ? judgedBetweenReads(ctx, addRule, target, plan, id, tally, {
              did: `added ${label(plan.link)}`,
              expect: (before) => withMember(before, label(plan.link)),
            })
          : Effect.succeed(Result.fail(toOne(target, plan))),
      ),
    ),
};

// ---------------------------------------------------------------------------
// DELETE: remove
// ---------------------------------------------------------------------------

const removeRule = rule(
  "spec/relationships/remove",
  "crud-updating-to-many-relationships",
  "A DELETE to a to-many relationship endpoint MUST remove the specified members from the relationship, or answer as if they were removed when they were not there — so the relationship endpoint, read afterwards, answers the linkage it held before without them.",
);

/**
 * Puts the related sample into the created resource's to-many linkage first,
 * through the relationship's POST endpoint, or failing one its PATCH —
 * so the DELETE has a member to remove. Answers why it could not.
 */
const seed = (
  ctx: Context,
  target: WriteTarget,
  plan: Plan,
  id: string,
  tally: Tally,
): Effect.Effect<Result.Result<void, string>> => {
  const sibling = (method: string) =>
    Arr.findFirst(
      ctx.endpoints,
      (endpoint) =>
        endpoint.role === "relationshipWrite" &&
        endpoint.method === method &&
        endpoint.path === target.endpoint.path,
    );
  return Option.match(
    Option.orElse(sibling("POST"), () => sibling("PATCH")),
    {
      onNone: () =>
        Effect.succeed(
          Result.fail(
            `no POST or PATCH ${target.endpoint.path} to put ${label(plan.link)} in the linkage before removing it`,
          ),
        ),
      onSome: (endpoint) =>
        Effect.map(
          mutate(ctx, tally, endpoint, id, [plan.link]),
          Result.map(() => undefined),
        ),
    },
  );
};

const remove: RuleImpl = {
  creates: true,
  rule: removeRule,
  run: (ctx) =>
    overRelationshipWrites(ctx, removeRule, "DELETE", (target) =>
      onCreated(ctx, removeRule, target, (plan, id, tally) =>
        plan.many
          ? Effect.gen(function* () {
              const seeded = yield* seed(ctx, target, plan, id, tally);
              if (Result.isFailure(seeded)) return Result.fail(seeded.failure);
              return yield* judgedBetweenReads(ctx, removeRule, target, plan, id, tally, {
                did: `removed ${label(plan.link)}`,
                expect: (before) => withoutMember(before, label(plan.link)),
                unready: (before) =>
                  Arr.contains(before, label(plan.link))
                    ? Option.none()
                    : Option.some(
                        `${label(plan.link)} was not in the linkage after adding it, so there is no member to remove`,
                      ),
              });
            })
          : Effect.succeed(Result.fail(toOne(target, plan))),
      ),
    ),
};

/**
 * The relationship-mutation rules, in report order.
 *
 * @internal
 */
export const relationshipRules: ReadonlyArray<RuleImpl> = [replace, add, remove];
