/**
 * The relationship mutation rules ([§Updating a Resource's Relationships]
 * (https://jsonapi.org/format/1.1/#crud-updating-relationships)): a `PATCH`
 * to a relationship URL replaces its linkage — a to-one one with `null` too —
 * a `POST` adds to a to-many one and a `DELETE` removes from it, each judged
 * by reading the linkage back through `GET /<type>/:id/relationships/<name>`,
 * never by the write's answer alone. Three more judge the answer: a successful
 * write answers 202, 204 or 200 with the linkage as it now stands; a `PATCH`
 * or `POST` naming a resource that does not exist answers 404; and a `DELETE`
 * naming one succeeds, since that resource is already missing from the
 * relationship.
 *
 * Each probe acts on a resource it created from the type's `writes` fixture
 * (`withCreated`, `./write.ts`), disposed of however the rule ends, and links
 * it to the `ids` sample of a type the write endpoint's payload names — or,
 * for the 404 and the absent removal, to `absentId` under that type. The
 * sample is only linked to, never written to itself. A write the server does
 * not accept — a `403` included, which the specification allows for a
 * replacement or removal the server does not permit — decides nothing, nor
 * does a read the server cannot answer; a `202` decides nothing that a
 * read-back would.
 *
 * @since 0.18.0
 * @internal
 */
import { Array as Arr, Effect, Formatter, Match, Option, Order, Result, Schema } from "effect";
import {
  type Context,
  describe,
  type Discovered,
  finding,
  documentOf,
  isJsonArray,
  isJsonObject,
  jsonApiAccept,
  type Observation,
  type Outcome,
  type Rule,
  type RuleImpl,
  statusOf,
  succeeded,
  topLevel,
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
const memberLabel = (item: Schema.Json): string =>
  Option.match(decodeIdentity(item), { onNone: () => Formatter.format(item), onSome: label });

/** The linkage a read's `data` holds, as sorted labels — none when it is not linkage. */
const labelsOf = (data: Schema.Json): Option.Option<ReadonlyArray<string>> => {
  if (data === null) return Option.some([]);
  if (isJsonArray(data)) return Option.some(Arr.sort(Arr.map(data, memberLabel), Order.String));
  return isJsonObject(data) ? Option.some([memberLabel(data)]) : Option.none();
};

const shown = (labels: ReadonlyArray<string>): string =>
  Arr.match(labels, {
    onEmpty: () => "no linkage",
    onNonEmpty: (members) => `[${members.join(", ")}]`,
  });

/** What one relationship write probe needs beside the resource it creates. */
interface Plan {
  readonly endpoint: Discovered;
  /** The relationship's GET, which the linkage is read back through — if there is one. */
  readonly read: Option.Option<Discovered>;
  readonly sample: Identity;
}

const noRead = (endpoint: Discovered): string =>
  `no GET ${endpoint.path} to read the linkage ${endpoint.method} writes back through`;

/** The URL `plan`'s linkage on the resource `id` is read through, or the verdict when there is none. */
const readUrlOf = (plan: Plan, id: string): Result.Result<string, Verdict> =>
  Option.match(plan.read, {
    onNone: () => Result.fail(undecided(noRead(plan.endpoint))),
    onSome: (read) => Result.succeed(pathFor(read, id)),
  });

/** The relationship GET at `endpoint`'s path, which its linkage is read back through — if there is one. */
const readFor = (ctx: Context, endpoint: Discovered): Option.Option<Discovered> =>
  Arr.findFirst(
    ctx.endpoints,
    (candidate) => candidate.role === "relationship" && candidate.path === endpoint.path,
  );

/**
 * The plan for `target`'s relationship write endpoint, or why there is none —
 * which, unless `readless`, includes a relationship GET to read back through.
 */
const planOf = (
  ctx: Context,
  target: WriteTarget,
  readless: boolean,
): Result.Result<Plan, string> =>
  Result.gen(function* () {
    const endpoint = target.endpoint;
    const read = readFor(ctx, endpoint);
    if (!readless && Option.isNone(read)) return yield* Result.fail(noRead(endpoint));
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

/** The plan for a rule that reads the linkage back. */
const planFor = (ctx: Context, target: WriteTarget): Result.Result<Plan, string> =>
  planOf(ctx, target, false);

/**
 * A read of the relationship's linkage: its labels, or the verdict a read that
 * shows none reaches. `final` names the rule a read-back judges, for which a
 * `404` or `410` is a finding — the write was not stored; any other read that
 * shows no linkage decides nothing.
 */
const readLinkage = (
  ctx: Context,
  url: string,
  what: string,
  final: Option.Option<Rule>,
): Effect.Effect<Result.Result<ReadonlyArray<string>, Verdict>> =>
  ctx.request({ url, headers: jsonApiAccept }).pipe(
    Effect.map((observation) => {
      if (Option.isSome(final) && (observation.status === 404 || observation.status === 410))
        return Result.fail(
          decided(1, [
            finding(final.value, {
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
      const data = Option.flatMap(topLevel(observation.body, "data"), labelsOf);
      return Result.fromOption(data, () =>
        undecided(`reading ${url} ${what} answered no resource linkage (${describe(observation)})`),
      );
    }),
  );

/** The answer to `endpoint`'s write to `url`, as a verdict when it decides nothing that a read-back would; none when it was accepted and is final. */
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
 * Sends `data` through `endpoint`, on the resource `id`, as a step before the
 * write a rule judges: the answer, or the verdict when it decides nothing
 * (see {@link unaccepted}).
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
type Probe<P> = (ctx: Context, plan: P, id: string) => Effect.Effect<Verdict>;

/**
 * One probe per relationship write endpoint `admits` whose type has a create
 * endpoint and fixture: plan it, create a resource, `probe` its linkage, and
 * dispose of it. `what` names the endpoints for a skip that finds none.
 */
const overRelationshipWrites = <P>(
  ctx: Context,
  impl: Rule,
  admits: (endpoint: Discovered) => boolean,
  what: string,
  plan: (ctx: Context, target: WriteTarget) => Result.Result<P, string>,
  probe: Probe<P>,
): Effect.Effect<Outcome> =>
  overTargets(ctx, impl, targets(ctx, "relationshipWrite", admits), what, (target) =>
    Result.match(plan(ctx, target), {
      onFailure: (reason) => Effect.succeed(undecided(reason)),
      onSuccess: (planned) =>
        withCreated(
          ctx,
          impl,
          target,
          viaCreateEndpoint(ctx, target),
          onOwnId(target, (_, id) =>
            probe(ctx, planned, id).pipe(Effect.map((verdict) => plusRequests(verdict, 1))),
          ),
        ),
    }),
  );

/** An endpoint of `method`. */
const ofMethod =
  (method: string) =>
  (endpoint: Discovered): boolean =>
    endpoint.method === method;

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
  const url = readUrlOf(plan, id);
  if (Result.isFailure(url)) return Effect.succeed(url.failure);
  return readLinkage(ctx, url.success, "afterwards", Option.some(impl)).pipe(
    Effect.map(
      Result.match({
        onFailure: (verdict) => plusRequests(verdict, before),
        onSuccess: (read) => judgeReadBack(impl, before, url.success, sent, expected, read, what),
      }),
    ),
  );
};

/**
 * The write a rule judges, as sent: its answer, whatever it was, the probe's
 * requests so far (the write included), the linkage it should leave behind,
 * and what it did, for a finding.
 */
interface Sent {
  readonly answer: Observation;
  readonly requests: number;
  readonly expected: ReadonlyArray<string>;
  readonly what: string;
}

/** Sends one kind of relationship write to the resource `id`, or the verdict when there is nothing to send. */
type Send = (ctx: Context, plan: Plan, id: string) => Effect.Effect<Result.Result<Sent, Verdict>>;

/**
 * The rule judging the linkage `send` leaves behind, read back: a write that
 * is not accepted, or a 202, decides nothing.
 */
const readBackOf =
  (impl: Rule, send: Send): Probe<Plan> =>
  (ctx, plan, id) =>
    Effect.gen(function* () {
      const sent = yield* send(ctx, plan, id);
      if (Result.isFailure(sent)) return sent.failure;
      const { answer, requests, expected, what } = sent.success;
      const refused = unaccepted(plan.endpoint, pathFor(plan.endpoint, id), answer);
      if (Option.isSome(refused)) return refused.value;
      return yield* readBackAfter(ctx, impl, plan, id, requests, answer, expected, what);
    });

/**
 * `send`, for a `POST` / `DELETE`: on an endpoint whose payload declares a
 * to-one relationship it sends nothing, since only a to-many one is added to
 * or removed from.
 */
const toManyOnly =
  (send: Send): Send =>
  (ctx, plan, id) =>
    plan.endpoint.linkage === "one"
      ? Effect.succeed(
          Result.fail(
            undecided(
              `the payload of ${plan.endpoint.method} ${plan.endpoint.path} declares a to-one relationship — only a to-many one is added to or removed from`,
            ),
          ),
        )
      : send(ctx, plan, id);

// ---------------------------------------------------------------------------
// PATCH: replace
// ---------------------------------------------------------------------------

const sendReplace: Send = (ctx, plan, id) =>
  Effect.gen(function* () {
    const { endpoint, sample } = plan;
    if (endpoint.linkage === "unshown")
      return Result.fail(
        undecided(
          `the payload of PATCH ${endpoint.path} declares neither a to-one nor a to-many relationship`,
        ),
      );
    const answer = yield* sendLinkage(
      ctx,
      endpoint,
      pathFor(endpoint, id),
      endpoint.linkage === "one" ? sample : [sample],
    );
    return Result.succeed({
      answer,
      requests: 1,
      expected: [label(sample)],
      what: `replacing its linkage with ${label(sample)}`,
    });
  });

const updateReplaces: RuleImpl = {
  creates: true,
  rule: rule(
    "spec/relationships/update-replaces",
    "crud-updating-relationships",
    "A PATCH to a URL from a relationship link replaces the relationship: a to-one relationship with the resource identifier object (or `null`) its `data` carries; for a to-many relationship the server MUST either completely replace every member of the relationship, return an appropriate error response if some resources can not be found or accessed, or return a 403 Forbidden response if complete replacement is not allowed by the server.",
  ),
  run: (ctx) =>
    overRelationshipWrites(
      ctx,
      updateReplaces.rule,
      ofMethod("PATCH"),
      "PATCH relationship endpoint",
      planFor,
      readBackOf(updateReplaces.rule, sendReplace),
    ),
};

// ---------------------------------------------------------------------------
// PATCH: clear a to-one relationship with `null`
// ---------------------------------------------------------------------------

/**
 * The plan for clearing `target`'s to-one relationship, or why there is none:
 * its payload must admit `data: null`, which a required one does not.
 */
const clearablePlanFor = (ctx: Context, target: WriteTarget): Result.Result<Plan, string> =>
  target.endpoint.linkageNullable
    ? planFor(ctx, target)
    : Result.fail(
        `the payload of PATCH ${target.endpoint.path} does not admit \`data: null\` — the relationship is required`,
      );

/**
 * How many requests it took for the resource `id`'s to-one linkage to hold
 * something to clear: one read when it already does, or — when it reads back
 * empty — that read, a PATCH linking the sample and a second read showing it.
 */
const linkedToOne = (
  ctx: Context,
  plan: Plan,
  id: string,
): Effect.Effect<Result.Result<number, Verdict>> =>
  Effect.gen(function* () {
    const readUrl = readUrlOf(plan, id);
    if (Result.isFailure(readUrl)) return Result.fail(readUrl.failure);
    const first = yield* readLinkage(ctx, readUrl.success, "before the PATCH", Option.none());
    if (Result.isFailure(first)) return Result.fail(first.failure);
    if (Arr.isReadonlyArrayNonEmpty(first.success)) return Result.succeed(1);
    const linked = yield* write(ctx, plan.endpoint, id, plan.sample);
    if (Result.isFailure(linked)) return Result.fail(linked.failure);
    const url = pathFor(plan.endpoint, id);
    const second = yield* readLinkage(ctx, readUrl.success, `after PATCH ${url}`, Option.none());
    if (Result.isFailure(second)) return Result.fail(second.failure);
    return Arr.isReadonlyArrayNonEmpty(second.success)
      ? Result.succeed(3)
      : Result.fail(
          undecided(
            `PATCH ${url} did not link ${label(plan.sample)} to clear — see spec/relationships/update-replaces`,
          ),
        );
  });

const sendClear: Send = (ctx, plan, id) =>
  Effect.gen(function* () {
    const before = yield* linkedToOne(ctx, plan, id);
    if (Result.isFailure(before)) return Result.fail(before.failure);
    const answer = yield* sendLinkage(ctx, plan.endpoint, pathFor(plan.endpoint, id), null);
    return Result.succeed({
      answer,
      requests: before.success + 1,
      expected: [],
      what: "replacing its linkage with `null`",
    });
  });

const updateToOneNull: RuleImpl = {
  creates: true,
  rule: rule(
    "spec/relationships/update-to-one-null",
    "crud-updating-to-one-relationships",
    "A server MUST respond to PATCH requests to a URL from a to-one relationship link as described below. The PATCH request MUST include a top-level member named `data` containing one of a resource identifier object corresponding to the new related resource, or `null`, to remove the relationship.",
  ),
  run: (ctx) =>
    overRelationshipWrites(
      ctx,
      updateToOneNull.rule,
      (endpoint) => endpoint.method === "PATCH" && endpoint.linkage === "one",
      "PATCH endpoint on a to-one relationship",
      clearablePlanFor,
      readBackOf(updateToOneNull.rule, sendClear),
    ),
};

// ---------------------------------------------------------------------------
// POST: append
// ---------------------------------------------------------------------------

const sendAppend: Send = toManyOnly((ctx, plan, id) =>
  Effect.gen(function* () {
    const { endpoint, sample } = plan;
    const readUrl = readUrlOf(plan, id);
    if (Result.isFailure(readUrl)) return Result.fail(readUrl.failure);
    const before = yield* readLinkage(ctx, readUrl.success, "before the POST", Option.none());
    if (Result.isFailure(before)) return Result.fail(before.failure);
    const answer = yield* sendLinkage(ctx, endpoint, pathFor(endpoint, id), [sample]);
    return Result.succeed({
      answer,
      requests: 2,
      expected: Arr.dedupe([...before.success, label(sample)]),
      what: `adding ${label(sample)} to ${shown(before.success)}`,
    });
  }),
);

const addAppends: RuleImpl = {
  creates: true,
  rule: rule(
    "spec/relationships/add-appends",
    "crud-updating-to-many-relationships",
    "If a client makes a POST request to a URL from a relationship link, the server MUST add the specified members to the relationship unless they are already present.",
  ),
  run: (ctx) =>
    overRelationshipWrites(
      ctx,
      addAppends.rule,
      ofMethod("POST"),
      "POST relationship endpoint",
      planFor,
      readBackOf(addAppends.rule, sendAppend),
    ),
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
    const url = readUrlOf(plan, id);
    if (Result.isFailure(url)) return Result.fail(url.failure);
    const readUrl = url.success;
    const read = (what: string) => readLinkage(ctx, readUrl, what, Option.none());
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
    const linkUrl = pathFor(linker.value, id);
    const sent = yield* write(ctx, linker.value, id, [plan.sample]);
    if (Result.isFailure(sent)) return Result.fail(sent.failure);
    const second = yield* read(`after ${linker.value.method} ${linkUrl}`);
    if (Result.isFailure(second)) return Result.fail(second.failure);
    return second.success.includes(wanted)
      ? Result.succeed({ linked: second.success, requests: 3 })
      : Result.fail(
          undecided(
            `${linker.value.method} ${linkUrl} did not link ${wanted} to remove — see spec/relationships/${linker.value.method === "POST" ? "add-appends" : "update-replaces"}`,
          ),
        );
  });

const sendRemove: Send = toManyOnly((ctx, plan, id) =>
  Effect.gen(function* () {
    const before = yield* linkedBefore(ctx, plan, id);
    if (Result.isFailure(before)) return Result.fail(before.failure);
    const { linked, requests } = before.success;
    const { endpoint, sample } = plan;
    const answer = yield* sendLinkage(ctx, endpoint, pathFor(endpoint, id), [sample]);
    return Result.succeed({
      answer,
      requests: requests + 1,
      expected: linked.filter((member) => member !== label(sample)),
      what: `removing ${label(sample)} from ${shown(linked)}`,
    });
  }),
);

const removeDeletes: RuleImpl = {
  creates: true,
  rule: rule(
    "spec/relationships/remove-deletes",
    "crud-updating-to-many-relationships",
    "If the client makes a DELETE request to a URL from a relationship link the server MUST delete the specified members from the relationship or return a 403 Forbidden response.",
  ),
  run: (ctx) =>
    overRelationshipWrites(
      ctx,
      removeDeletes.rule,
      ofMethod("DELETE"),
      "DELETE relationship endpoint",
      planFor,
      readBackOf(removeDeletes.rule, sendRemove),
    ),
};

// ---------------------------------------------------------------------------
// The answer to a successful write
// ---------------------------------------------------------------------------

/** The write a relationship write endpoint of `method` is sent, if the kit sends one. */
const sendFor = (method: string): Option.Option<Send> =>
  Match.value(method).pipe(
    Match.when("PATCH", () => Option.some(sendReplace)),
    Match.when("POST", () => Option.some(sendAppend)),
    Match.when("DELETE", () => Option.some(sendRemove)),
    Match.orElse(() => Option.none()),
  );

const RESPONSES =
  "202, 204 with no document, or 200 with the linkage as it now stands (or with top-level `meta` alone)";

/**
 * What is wrong with a 200 answering a relationship write, if anything: its
 * document's primary data must be resource linkage, the same as the
 * relationship now reads back — or, with no relationship GET to read it
 * through, as the write leaves it; or, without primary data, it carries a
 * top-level `meta` object and no `errors`.
 */
const judge200 = (
  ctx: Context,
  impl: Rule,
  plan: Plan,
  id: string,
  { answer, requests, expected }: Sent,
): Effect.Effect<Verdict> => {
  const broken = (detail: string, observed = describe(answer)): Verdict =>
    decided(requests, [
      finding(impl, { detail, expected: RESPONSES, observed, probe: answer.probe }),
    ]);
  const the200 = `the 200 to ${answer.probe.method} ${answer.probe.url}`;
  const document = documentOf(answer.body);
  if (Option.isNone(document)) return Effect.succeed(broken(`${the200} carried no document`));
  const body = document.value;
  if ("errors" in body)
    return Effect.succeed(
      broken(`${the200} carries \`errors\` — an error document is no answer to a successful write`),
    );
  if (!("data" in body))
    return Effect.succeed(
      isJsonObject(body["meta"])
        ? decided(requests, [])
        : broken(
            `${the200} carries neither the relationship's linkage nor a top-level \`meta\` object`,
          ),
    );
  const answered = labelsOf(body["data"]);
  if (Option.isNone(answered))
    return Effect.succeed(broken(`${the200} carries primary data that is not resource linkage`));
  const carries = `${the200} carries ${shown(answered.value)}`;
  const against = (read: ReadonlyArray<string>, extra: number, but: string): Verdict =>
    read.join("\n") === answered.value.join("\n")
      ? decided(requests + extra, [])
      : plusRequests(broken(`${carries}, but ${but}`, shown(answered.value)), extra);
  return Option.match(plan.read, {
    onNone: () => {
      const leaves = Arr.sort(expected, Order.String);
      return Effect.succeed(against(leaves, 0, `the write leaves ${shown(leaves)}`));
    },
    onSome: (read) => {
      const url = pathFor(read, id);
      return readLinkage(ctx, url, "afterwards", Option.none()).pipe(
        Effect.map(
          Result.match({
            onFailure: (verdict) => verdict,
            onSuccess: (linkage) => against(linkage, 1, `${url} then reads back ${shown(linkage)}`),
          }),
        ),
      );
    },
  });
};

/** The verdict on what a relationship write answered, once the server accepted it. */
const judgeResponse = (
  ctx: Context,
  impl: Rule,
  plan: Plan,
  id: string,
  sent: Sent,
): Effect.Effect<Verdict> => {
  const { answer, requests } = sent;
  const url = pathFor(plan.endpoint, id);
  if (!succeeded(answer))
    return Effect.succeed(
      undecided(
        `the server did not accept ${plan.endpoint.method} ${url}, on the resource the kit had just created (${describe(answer)})`,
      ),
    );
  if (answer.status === 202) return Effect.succeed(decided(requests, []));
  if (answer.status === 200) return judge200(ctx, impl, plan, id, sent);
  const detail =
    answer.status === 204
      ? `a 204 to ${plan.endpoint.method} ${url} carried a body`
      : `${plan.endpoint.method} ${url} answered ${answer.status}`;
  return Effect.succeed(
    decided(
      requests,
      answer.status === 204 && answer.text === ""
        ? []
        : [
            finding(impl, {
              detail,
              expected: RESPONSES,
              observed: describe(answer),
              probe: answer.probe,
            }),
          ],
    ),
  );
};

const respond: Probe<Plan> = (ctx, plan, id) =>
  Option.match(sendFor(plan.endpoint.method), {
    onNone: () =>
      Effect.succeed(undecided(`the kit sends no ${plan.endpoint.method} to a relationship`)),
    onSome: (send) =>
      send(ctx, plan, id).pipe(
        Effect.flatMap(
          Result.match({
            onFailure: Effect.succeed,
            onSuccess: (sent) => judgeResponse(ctx, writeResponse.rule, plan, id, sent),
          }),
        ),
      ),
  });

const writeResponse: RuleImpl = {
  creates: true,
  rule: rule(
    "spec/relationships/write-response",
    "crud-updating-relationship-responses",
    "A successful relationship update is answered 202 Accepted when its processing has not completed; 204 No Content when it is successful and the relationship matches the request; or 200 OK with a document whose primary data is the updated relationship — or, when the client's current data remain up to date, a document with only top-level meta data.",
  ),
  run: (ctx) =>
    overRelationshipWrites(
      ctx,
      writeResponse.rule,
      (endpoint) => Option.isSome(sendFor(endpoint.method)),
      "relationship write endpoint",
      (ctx, target) => planOf(ctx, target, true),
      respond,
    ),
};

// ---------------------------------------------------------------------------
// 404 for a related resource that does not exist
// ---------------------------------------------------------------------------

/** What the 404 probe needs beside the resource it creates: an identifier no resource holds. */
interface AbsentPlan {
  readonly endpoint: Discovered;
  readonly absent: Identity;
}

/** The plan for linking `target`'s relationship to an absent resource, or why there is none. */
const absentPlanFor = (ctx: Context, target: WriteTarget): Result.Result<AbsentPlan, string> => {
  const { endpoint } = target;
  if (endpoint.linkage === "unshown")
    return Result.fail(
      `the payload of ${endpoint.method} ${endpoint.path} declares neither a to-one nor a to-many relationship`,
    );
  return Result.fromOption(
    Option.map(Arr.head(endpoint.linkageTypes), (type) => ({
      endpoint,
      absent: { type, id: ctx.options.absentId },
    })),
    () => `the payload of ${endpoint.method} ${endpoint.path} names no resource type to link to`,
  );
};

const linkAbsent: Probe<AbsentPlan> = (ctx, { endpoint, absent }, id) => {
  const url = pathFor(endpoint, id);
  return sendLinkage(ctx, endpoint, url, endpoint.linkage === "one" ? absent : [absent]).pipe(
    Effect.map((answer) => {
      if (answer.status === 404) return decided(1, []);
      if (answer.status === 403)
        return undecided(
          `${endpoint.method} ${url} answered 403 Forbidden — the server does not permit the write at all (${describe(answer)})`,
        );
      if (answer.status === 0 || answer.status >= 500)
        return undecided(
          `${endpoint.method} ${url} answered ${statusOf(answer)} (${describe(answer)})`,
        );
      return decided(1, [
        finding(absentLinked404.rule, {
          detail: `${endpoint.method} ${url} linking ${label(absent)}, which does not exist, answered ${answer.status}`,
          expected: "404 Not Found",
          observed: describe(answer),
          probe: answer.probe,
        }),
      ]);
    }),
  );
};

const absentLinked404: RuleImpl = {
  creates: true,
  rule: rule(
    "spec/relationships/absent-related-404",
    "crud-updating-relationship-responses-404",
    "A server MUST return 404 Not Found when processing a request that references a related resource that does not exist.",
  ),
  run: (ctx) =>
    overRelationshipWrites(
      ctx,
      absentLinked404.rule,
      (endpoint) => endpoint.method === "PATCH" || endpoint.method === "POST",
      "PATCH or POST relationship endpoint",
      absentPlanFor,
      linkAbsent,
    ),
};

// ---------------------------------------------------------------------------
// DELETE naming a resource that does not exist
// ---------------------------------------------------------------------------

/**
 * The plan for removing an absent resource from `target`'s relationship, or
 * why there is none: {@link absentPlanFor}'s identifier as the sample, and the
 * relationship GET a 200's linkage is compared with, if there is one.
 */
const absentRemovePlanFor = (ctx: Context, target: WriteTarget): Result.Result<Plan, string> =>
  Result.map(absentPlanFor(ctx, target), ({ endpoint, absent }) => ({
    endpoint,
    read: readFor(ctx, endpoint),
    sample: absent,
  }));

/**
 * Removes the plan's absent identifier. `expected` goes unused: a 200 carrying
 * linkage is judged against the relationship as it then reads back, and with
 * no relationship GET to read it through is set aside (see
 * {@link judgeRemoveAbsent}).
 */
const sendRemoveAbsent: Send = toManyOnly((ctx, { endpoint, sample }, id) =>
  sendLinkage(ctx, endpoint, pathFor(endpoint, id), [sample]).pipe(
    Effect.map((answer) =>
      Result.succeed({
        answer,
        requests: 1,
        expected: [],
        what: `removing ${label(sample)}, which does not exist`,
      }),
    ),
  ),
);

/**
 * The verdict on a removal naming a resource that does not exist: it must
 * succeed, answered as {@link judgeResponse} judges any relationship write. A
 * `403` decides nothing — the server does not permit the removal at all — nor
 * does a request that got no answer; a `404`, or any other error, is a finding.
 */
const judgeRemoveAbsent = (
  ctx: Context,
  plan: Plan,
  id: string,
  sent: Sent,
): Effect.Effect<Verdict> => {
  const { answer, requests } = sent;
  const removing = `DELETE ${pathFor(plan.endpoint, id)} removing ${label(plan.sample)}, which does not exist,`;
  if (answer.status === 403)
    return Effect.succeed(
      undecided(
        `${removing} answered 403 Forbidden — the server does not permit the removal at all (${describe(answer)})`,
      ),
    );
  if (answer.status === 0)
    return Effect.succeed(undecided(`${removing} got no answer (${statusOf(answer)})`));
  if (!succeeded(answer))
    return Effect.succeed(
      decided(requests, [
        finding(removeAbsentSucceeds.rule, {
          detail: `${removing} answered ${answer.status}: the resource is already missing from the relationship, so the removal succeeds`,
          expected: RESPONSES,
          observed: describe(answer),
          probe: answer.probe,
        }),
      ]),
    );
  if (
    answer.status === 200 &&
    Option.isNone(plan.read) &&
    Option.exists(documentOf(answer.body), (document) => "data" in document)
  )
    return Effect.succeed(
      undecided(
        `${removing} answered 200 with linkage, and there is no GET ${plan.endpoint.path} to compare it with`,
      ),
    );
  return judgeResponse(ctx, removeAbsentSucceeds.rule, plan, id, sent);
};

const removeAbsent: Probe<Plan> = (ctx, plan, id) =>
  sendRemoveAbsent(ctx, plan, id).pipe(
    Effect.flatMap(
      Result.match({
        onFailure: Effect.succeed,
        onSuccess: (sent) => judgeRemoveAbsent(ctx, plan, id, sent),
      }),
    ),
  );

const removeAbsentSucceeds: RuleImpl = {
  creates: true,
  rule: rule(
    "spec/relationships/remove-absent-succeeds",
    "crud-updating-to-many-relationships",
    "If all of the specified resources are able to be removed from, or are already missing from, the relationship then the server MUST return a successful response — so a DELETE to a URL from a relationship link naming a resource that does not exist, which is already missing from the relationship, succeeds (or is refused with 403 Forbidden).",
  ),
  run: (ctx) =>
    overRelationshipWrites(
      ctx,
      removeAbsentSucceeds.rule,
      ofMethod("DELETE"),
      "DELETE relationship endpoint",
      absentRemovePlanFor,
      removeAbsent,
    ),
};

/**
 * The relationship mutation rules, in report order.
 *
 * @internal
 */
export const relationshipRules: ReadonlyArray<RuleImpl> = [
  updateReplaces,
  updateToOneNull,
  addAppends,
  removeDeletes,
  writeResponse,
  absentLinked404,
  removeAbsentSucceeds,
];
