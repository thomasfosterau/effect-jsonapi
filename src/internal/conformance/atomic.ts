/**
 * The atomic operations extension's rules (https://jsonapi.org/ext/atomic/):
 * the request document's shape, the media type of the answer, and how the
 * server processes the operations — `lid` resolution, all-or-nothing
 * application and the order of `atomic:results`.
 *
 * Every rule but the malformed-document one applies operations, so each is
 * gated behind `mutating: true` and builds its `add` operations from the
 * caller's `writes` fixture (`./write.ts`). What a request created is
 * recorded and disposed of, latest first, however the rule ends
 * (`withBatch`). Processing is judged by what the server stored, read back
 * afterwards, never by its answer alone:
 *
 *   - **`lid-resolution`** `add`s a resource under a `lid` and names it by
 *     that `lid` in a second operation — as linkage in another fixture's
 *     `add`, when that fixture's payload links to the first one's type, and as
 *     the target of an `update` carrying the fixture's patch, when there is
 *     one — then reads back what the second operation should have changed.
 *   - **`all-or-nothing`** sends an `add` followed by a `remove` naming a
 *     `lid` no operation assigned ({@link ABSENT_LID}): a reference every
 *     server must fail, and one valid against the operation schema, so it
 *     reaches processing rather than stopping at the decoder. The fixture
 *     supplies no invalid operation. The collection is listed before and
 *     after, and a resource that appeared in between with the fixture's
 *     attributes is one the server applied anyway: a finding, and disposed of.
 *   - **`results-order`** sends an `add` and then a `remove` of the same
 *     resource by `lid` — one operation with data and one without — so a
 *     result list out of order, or short of one, cannot pass.
 *   - **`remove-absent-succeeds`** `add`s a resource, then sends a `remove` on
 *     one of its to-many relationships naming `absentId`: a resource that does
 *     not exist is already missing from the relationship, so the request
 *     succeeds. It is judged by its answer alone — there is no change to read
 *     back.
 *
 * @since 0.17.0
 * @internal
 */
import { Array as Arr, Effect, Option, Predicate, Record as Rec, Result, Schema } from "effect";
import { MEDIA_TYPE } from "../media.js";
import {
  answeredFrom,
  budgeted,
  counted,
  Link,
  documentLink,
  listed,
  own,
  Step,
  stepTo,
  type Target as CrawlTarget,
} from "./crawl.js";
import {
  atomicMediaType,
  type Context,
  describe,
  type Discovered,
  errorObjectsOf,
  finding,
  type Finding,
  isJsonArray,
  isJsonObject,
  isRecord,
  jsonApiAccept,
  type Observation,
  parseMediaType,
  type Payload,
  resolvePath,
  type Rule,
  type RuleImpl,
  settle,
  skip,
  statusOf,
  succeeded,
  topLevel,
} from "./core.js";
import {
  type Adopt,
  asSent,
  atomicIdentity,
  type Batch,
  buildCreate,
  buildUpdate,
  decided,
  idempotencyHeaders,
  onAccepted,
  onOwnId,
  overTargets,
  overTargetsAll,
  pathFor,
  readBack,
  readBackDifferences,
  readEndpointFor,
  refusedOnKeyGrounds,
  atomicTargets,
  undecided,
  type Verdict,
  withBatch,
  withCreated,
  type WriteTarget,
} from "./write.js";

const SPEC = "https://jsonapi.org/format/1.1";
const ATOMIC = "https://jsonapi.org/ext/atomic";

const atomicRule = (
  id: string,
  section: string,
  level: Rule["level"],
  requirement: string,
): Rule => ({
  id,
  tier: "spec",
  section,
  reference: ATOMIC,
  level,
  requirement,
});

/** The request headers every atomic operations request sends, before any `Idempotency-Key`. */
const atomicHeaders = { accept: atomicMediaType, "content-type": atomicMediaType };

/**
 * The api's atomic operations endpoint, if it declares one.
 *
 * @internal
 */
export const operationsEndpoint = (ctx: Context) =>
  ctx.endpoints.find((endpoint) => endpoint.role === "operations");

const atomicMalformedRejected: RuleImpl = {
  rule: atomicRule(
    "spec/atomic/malformed-operations-rejected",
    "Atomic Operations — Request Document",
    "MUST",
    "An atomic operations request document's `atomic:operations` member MUST be an array of operation objects, so a server MUST reject a document whose `atomic:operations` is not an array.",
  ),
  run: (ctx) =>
    Effect.gen(function* () {
      const endpoint = operationsEndpoint(ctx);
      if (endpoint === undefined)
        return skip(atomicMalformedRejected.rule, "no atomic operations endpoint");
      // Keyed when the endpoint requires a key, so its 4xx is about the
      // malformed document, not the refusal of a write without one.
      const key = yield* idempotencyHeaders(endpoint);
      const observation = yield* ctx.request({
        method: endpoint.method,
        url: endpoint.path,
        headers: { ...atomicHeaders, ...key },
        body: { "atomic:operations": "not an array" },
      });
      // Sent no key, the endpoint may refuse it over the key — for missing it,
      // or with a 409 or 422 — which says nothing of whether the document was
      // examined. Any such 4xx leaves the rule undecided; the delete rule,
      // which judges the answer itself, sets aside only the missing-key 400.
      if (refusedOnKeyGrounds(endpoint, key, observation))
        return skip(
          atomicMalformedRejected.rule,
          `the malformed document answered ${observation.status} from ${endpoint.path}, which declares \`Idempotency-Key\` without plainly requiring it, so the kit sent no key, and the error names that header as its source (${describe(observation)})`,
        );
      const findings =
        observation.status >= 400 && observation.status < 500
          ? []
          : [
              finding(atomicMalformedRejected.rule, {
                detail: "a non-array `atomic:operations` was not rejected",
                expected: "a 4xx status",
                observed: describe(observation),
                probe: observation.probe,
              }),
            ];
      return settle(atomicMalformedRejected.rule, 1, findings);
    }),
};

const atomicResponseExt: RuleImpl = {
  creates: true,
  rule: {
    id: "spec/atomic/response-ext-parameter",
    tier: "spec",
    section:
      "Content Negotiation — Universal Responsibilities (with the Atomic Operations extension)",
    reference: `${SPEC}/#content-negotiation-all`,
    level: "MUST",
    requirement:
      "Clients and servers MUST specify the `ext` media type parameter in the `Content-Type` header when they have applied one or more extensions to a JSON:API document — so a response to an atomic operations request, which applies that extension, names its URI in `ext`.",
  },
  run: (ctx) => {
    const endpoint = operationsEndpoint(ctx);
    if (endpoint === undefined)
      return Effect.succeed(skip(atomicResponseExt.rule, "no atomic operations endpoint"));
    const send = (payload: Payload) =>
      idempotencyHeaders(endpoint).pipe(
        Effect.flatMap((key) =>
          ctx.request({
            method: endpoint.method,
            url: endpoint.path,
            headers: { ...atomicHeaders, ...key },
            body: { "atomic:operations": [{ op: "add", data: payload }] },
          }),
        ),
      );
    return overTargets(
      ctx,
      atomicResponseExt.rule,
      atomicTargets(ctx, endpoint),
      "atomic operations endpoint",
      (target) =>
        withCreated(
          ctx,
          atomicResponseExt.rule,
          target,
          { send, identify: atomicIdentity },
          onAccepted(target, ({ observation }) =>
            Effect.succeed(judgeAtomicMediaType(target, observation)),
          ),
        ),
    );
  },
};

const judgeAtomicMediaType = (target: WriteTarget, observation: Observation): Verdict => {
  const header = observation.contentType;
  if (observation.text === "" || header === undefined)
    return undecided(
      `an \`add\` of a "${target.key}" resource answered ${observation.status} with no document, so there was no media type to check`,
    );
  const { base, parameters } = parseMediaType(header);
  const ext = parameters.find(([name]) => name === "ext")?.[1] ?? "";
  return decided(
    1,
    base === MEDIA_TYPE && ext.split(/\s+/).includes(ATOMIC)
      ? []
      : [
          finding(atomicResponseExt.rule, {
            detail: `the response to an atomic \`add\` of a "${target.key}" resource does not name the extension`,
            expected: atomicMediaType,
            observed: describe(observation),
            probe: observation.probe,
          }),
        ],
  );
};
// ---------------------------------------------------------------------------
// Sending operations
// ---------------------------------------------------------------------------

/** The `lid` a probe's `add` assigns, which a later operation of the same request names. */
const LID = "conformance-lid";

/**
 * The `lid` the all-or-nothing probe's last operation names, which no
 * operation of its request assigns. Every server must fail that operation —
 * a `lid` names a resource only once an earlier operation of the same request
 * has assigned it — and, unlike a payload the operation schema rejects, it
 * fails while the operations are processed rather than when the document is
 * decoded, so it tests the extension's processing rather than the codec.
 */
const ABSENT_LID = "conformance-absent-lid";

/**
 * Sends `operations` as one atomic request, keyed when the endpoint requires a key.
 *
 * @internal
 */
export const sendOperations = (
  ctx: Context,
  endpoint: Discovered,
  operations: ReadonlyArray<unknown>,
): Effect.Effect<Observation> =>
  idempotencyHeaders(endpoint).pipe(
    Effect.flatMap((key) =>
      ctx.request({
        method: endpoint.method,
        url: endpoint.path,
        headers: { ...atomicHeaders, ...key },
        body: { "atomic:operations": operations },
      }),
    ),
  );

/** An `add` operation of `payload`, under `lid` when one is given. */
const add = (payload: Payload, lid?: string) => ({
  op: "add",
  data: lid === undefined ? payload : { ...payload, lid },
});

/** A `remove` operation of the `type` resource that `lid` names. */
const removeByLid = (type: string, lid: string) => ({ op: "remove", ref: { type, lid } });

/**
 * The id the server gave each resource a request `add`ed, in plan order, or
 * why there is none: the request was not accepted — operations the server
 * rejects prove nothing about how it processes them — or a result named no id
 * the kit may act on.
 */
const createdIds = (
  what: string,
  batch: Batch,
): Result.Result<Arr.NonEmptyReadonlyArray<string>, string> =>
  Option.match(batch.entries, {
    onNone: () =>
      Result.fail(
        `${what} was not accepted (${statusOf(batch.observation)}${
          batch.observation.text === "" ? "" : ` — ${batch.observation.text.slice(0, 160)}`
        }) — the rule needs operations the server accepts`,
      ),
    onSome: (entries) =>
      Option.match(
        Arr.findFirst(entries, (entry) => entry.id === undefined),
        {
          onSome: (entry) => Result.fail(entry.detail ?? "a result named no id"),
          onNone: () => Result.succeed(Arr.map(entries, (entry) => entry.id ?? "")),
        },
      ),
  });

// ---------------------------------------------------------------------------
// lid resolution
// ---------------------------------------------------------------------------

/**
 * Where a payload links to a resource of another fixture's type: the
 * relationship, that type, and the relationship object with that one
 * identifier replaced.
 */
/** A resource identifier object, by server-assigned `id` or by `lid`. */
type Identifier =
  | { readonly type: string; readonly id: string }
  | { readonly type: string; readonly lid: string };

interface Relink {
  readonly name: string;
  readonly type: string;
  /** `payload`'s relationships, with that identifier replaced by `identifier`. */
  readonly to: (identifier: Identifier) => NonNullable<Payload["relationships"]>;
}

const decodeIdentifierType = Schema.decodeUnknownOption(Schema.Struct({ type: Schema.String }));

/** The first relationship of `payload` whose linkage names a resource of one of `types`. */
const relinkFor = (payload: Payload, types: ReadonlyArray<string>): Option.Option<Relink> =>
  Arr.findFirst(Rec.toEntries(payload.relationships ?? {}), ([name, relationship]) => {
    if (!isRecord(relationship)) return Option.none();
    const data = relationship["data"];
    const items: ReadonlyArray<unknown> = Array.isArray(data) ? data : [data];
    return Arr.findFirst(items, (item, at) =>
      decodeIdentifierType(item).pipe(
        Option.filter(({ type }) => Arr.contains(types, type)),
        Option.map(({ type }): Relink => ({
          name,
          type,
          to: (identifier) => ({
            ...payload.relationships,
            [name]: {
              ...relationship,
              data: Array.isArray(data) ? Arr.replace(items, at, identifier) : identifier,
            },
          }),
        })),
      ),
    );
  });

/**
 * The probe through linkage: `add` the fixture `relink` names under a `lid`,
 * then `add` `target`'s payload linking to it by that `lid`; read the second
 * back, expecting its relationship to name the first by the id the server
 * gave it, and read the first back, expecting it to exist.
 */
const byLinkage = (
  ctx: Context,
  endpoint: Discovered,
  linked: WriteTarget,
  target: WriteTarget,
  payload: Payload,
  relink: Relink,
): Effect.Effect<ReadonlyArray<Verdict>> =>
  Result.match(Result.all({ get: readEndpointFor(ctx, target), first: buildCreate(linked) }), {
    onFailure: (reason) => Effect.succeed([undecided(reason)]),
    onSuccess: ({ get, first }) => {
      if (first.type !== relink.type)
        return Effect.succeed([
          undecided(
            `writes["${linked.key}"].create built a "${first.type}" resource, not the "${relink.type}" that writes["${target.key}"].create's \`${relink.name}\` links to`,
          ),
        ]);
      const second = {
        ...payload,
        relationships: relink.to({ type: relink.type, lid: LID }),
      };
      return withBatch(
        ctx,
        atomicLidResolution.rule,
        [
          { target: linked, payload: first },
          { target, payload },
        ],
        sendOperations(ctx, endpoint, [add(first, LID), add(second)]),
        (batch) =>
          Result.match(
            createdIds(
              `an \`add\` of a "${linked.key}" resource under a \`lid\`, then an \`add\` of a "${target.key}" resource linking to it by that \`lid\`,`,
              batch,
            ),
            {
              onFailure: (reason) => Effect.succeed([undecided(reason)]),
              onSuccess: (ids) =>
                Option.match(Arr.get(ids, 1), {
                  onNone: () => Effect.succeed([undecided("the second result named no id")]),
                  onSome: (id) =>
                    Effect.all(
                      [
                        readBack(
                          ctx,
                          atomicLidResolution.rule,
                          1,
                          get,
                          payload.type,
                          id,
                          `its \`add\` linked \`${relink.name}\`, by \`lid\`, to the ${relink.type} resource the request's first operation created`,
                          asSent({
                            relationships: {
                              [relink.name]: relink.to({ type: relink.type, id: ids[0] })[
                                relink.name
                              ],
                            },
                          }),
                        ),
                        Result.match(readEndpointFor(ctx, linked), {
                          onFailure: (reason) => Effect.succeed(undecided(reason)),
                          onSuccess: (getLinked) =>
                            readBack(
                              ctx,
                              atomicLidResolution.rule,
                              0,
                              getLinked,
                              first.type,
                              ids[0],
                              "the request's first operation created it under a `lid`",
                              {},
                            ),
                        }),
                      ],
                      { concurrency: 1 },
                    ),
                }),
            },
          ),
      );
    },
  });

/**
 * The probe through an `update`: `add` `target`'s payload under a `lid`, then
 * `update` the resource that `lid` names with the fixture's patch; read it
 * back by the id the server gave it, expecting the patch.
 */
const byUpdate = (
  ctx: Context,
  endpoint: Discovered,
  target: WriteTarget,
): Effect.Effect<Verdict> =>
  Result.match(
    Result.all({
      get: readEndpointFor(ctx, target),
      patch: buildUpdate(target),
      payload: buildCreate(target),
    }),
    {
      onFailure: (reason) => Effect.succeed(undecided(reason)),
      onSuccess: ({ get, patch, payload }) =>
        withBatch(
          ctx,
          atomicLidResolution.rule,
          [{ target, payload }],
          sendOperations(ctx, endpoint, [
            add(payload, LID),
            { op: "update", data: { ...patch, type: payload.type, lid: LID } },
          ]),
          (batch) =>
            Result.match(
              createdIds(
                `an \`add\` of a "${target.key}" resource under a \`lid\`, then an \`update\` naming it by that \`lid\`,`,
                batch,
              ),
              {
                onFailure: (reason) => Effect.succeed(undecided(reason)),
                onSuccess: (ids) =>
                  readBack(
                    ctx,
                    atomicLidResolution.rule,
                    1,
                    get,
                    payload.type,
                    ids[0],
                    "the `update` naming it by `lid` requested",
                    asSent(patch),
                  ),
              },
            ),
        ),
    },
  );

/**
 * Every lid probe `target` admits: through linkage, when its payload links to
 * another fixture's type, and through an `update`, when it has an update
 * fixture.
 */
const lidProbes = (
  ctx: Context,
  endpoint: Discovered,
  all: ReadonlyArray<WriteTarget>,
  target: WriteTarget,
): Effect.Effect<ReadonlyArray<Verdict>> => {
  const others = Arr.filter(all, (other) => other.key !== target.key);
  const linkage: Effect.Effect<ReadonlyArray<Verdict>> = Arr.isReadonlyArrayEmpty(others)
    ? Effect.succeed([])
    : Result.match(buildCreate(target), {
        onFailure: (reason) => Effect.succeed([undecided(reason)]),
        onSuccess: (payload) =>
          Option.match(
            relinkFor(
              payload,
              Arr.map(others, (other) => other.key),
            ),
            {
              onNone: () => Effect.succeed([]),
              onSome: (relink) =>
                Option.match(
                  Arr.findFirst(others, (other) => other.key === relink.type),
                  {
                    onNone: () => Effect.succeed([]),
                    onSome: (linked) => byLinkage(ctx, endpoint, linked, target, payload, relink),
                  },
                ),
            },
          ),
      });
  const update: Effect.Effect<ReadonlyArray<Verdict>> = Option.isSome(target.update)
    ? Effect.map(byUpdate(ctx, endpoint, target), Arr.of)
    : Effect.succeed([]);
  return Effect.map(Effect.all([linkage, update], { concurrency: 1 }), ([linked, updated]) =>
    Arr.match([...linked, ...updated], {
      onEmpty: () => [
        undecided(
          `writes["${target.key}"] has no update, and its create links to no other type with a create fixture — pass writes["${target.key}"].update, or a create fixture for a type its payload links to`,
        ),
      ],
      onNonEmpty: (verdicts) => verdicts,
    }),
  );
};

const atomicLidResolution: RuleImpl = {
  creates: true,
  rule: atomicRule(
    "spec/atomic/lid-resolution",
    "Atomic Operations — Local Identifiers",
    "MUST",
    "A `lid` assigned by one operation MUST be resolvable as a reference in every later operation of the same request — so a resource a later operation names by that `lid`, whether as linkage or as its target, is the one the earlier operation created, under the id the server gave it.",
  ),
  run: (ctx) => {
    const endpoint = operationsEndpoint(ctx);
    if (endpoint === undefined)
      return Effect.succeed(skip(atomicLidResolution.rule, "no atomic operations endpoint"));
    const found = atomicTargets(ctx, endpoint);
    return overTargetsAll(
      ctx,
      atomicLidResolution.rule,
      found,
      "atomic operations endpoint",
      (target) => lidProbes(ctx, endpoint, found.targets, target),
    );
  },
};

// ---------------------------------------------------------------------------
// All-or-nothing
// ---------------------------------------------------------------------------

/** The most requests one listing of a collection may make, its pages and redirects included. */
const LISTING_BUDGET = 20;

/** A resource object as a listing shows it — what {@link readBackDifferences} compares. */
type Listed = Parameters<typeof readBackDifferences>[1];

/** A collection's resources of one type, each with its id, and the requests listing it took. */
interface Listing {
  readonly resources: ReadonlyArray<readonly [id: string, resource: Listed]>;
  readonly requests: number;
}

const decodeListed = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.String, id: Schema.String }),
);

/** The collection GET of `target`'s type, as a URL — or why there is none. */
const listPathFor = (ctx: Context, target: WriteTarget): Result.Result<string, string> =>
  Result.fromOption(
    Arr.findFirst(
      ctx.endpoints,
      (endpoint) =>
        endpoint.role === "collection" &&
        endpoint.segment === target.key &&
        Arr.isReadonlyArrayEmpty(endpoint.params),
    ),
    () =>
      `no collection GET endpoint for "${target.key}" to observe what the request stored through`,
  ).pipe(
    Result.flatMap((endpoint) => {
      const resolution = resolvePath(endpoint, ctx.options);
      return Predicate.isTagged(resolution, "Resolved")
        ? Result.succeed(resolution.path)
        : Result.fail(resolution.reason);
    }),
  );

/** The resources of `type` a page's `data` lists, each with its id. */
const pageResources = (data: Schema.JsonArray, type: string): Listing["resources"] =>
  Arr.filterMap(data, (item) =>
    isJsonObject(item)
      ? Option.match(
          Option.filter(decodeListed(item), (listed) => listed.type === type),
          {
            onNone: () => Result.failVoid,
            onSome: ({ id }) => Result.succeed([id, item] as const),
          },
        )
      : Result.failVoid,
  );

/**
 * Every resource of `type` the collection at `path` lists, following `next`
 * across its pages within {@link LISTING_BUDGET} requests — or why the listing
 * could not be finished: a page that is not a resource collection, a `next`
 * that is no link, leads off the origin or back to a page already listed, or
 * the budget. A partial listing is never answered: a resource it missed could
 * be the one the request left.
 */
const listing = (
  ctx: Context,
  path: string,
  type: string,
): Effect.Effect<Result.Result<Listing, string>> => {
  // A fresh transport: its cache would answer the second listing with the first.
  const io = budgeted(ctx, LISTING_BUDGET);
  const failed = (reason: string) => Effect.succeed(Result.fail(reason));
  const step = (
    target: CrawlTarget,
    found: Listing["resources"],
    visited: ReadonlyArray<string>,
  ): Effect.Effect<Result.Result<Listing, string>> =>
    Effect.flatMap(io.fetch(target), (answer) => {
      if (Option.isNone(answer))
        return failed(`listing ${path} took more than its budget of ${LISTING_BUDGET} requests`);
      const observation = answer.value;
      if (!succeeded(observation))
        return failed(
          `listing ${target.url} answered ${statusOf(observation)} (${describe(observation)})`,
        );
      const data = Option.filter(topLevel(observation.body, "data"), isJsonArray);
      if (Option.isNone(data)) return failed(`${target.url} did not answer a resource collection`);
      const resources = [...found, ...pageResources(data.value, type)];
      const seen = [...visited, target.href];
      return Link.$match(documentLink(observation.body, "next"), {
        Unavailable: () => Effect.succeed(Result.succeed({ resources, requests: io.spent() })),
        Malformed: () => failed(`the \`next\` link on ${target.url} is not a link`),
        Href: ({ href }) =>
          Step.$match(stepTo(href, answeredFrom(target, observation), ctx.options.baseUrl), {
            Follow: ({ target: next }) =>
              Arr.contains(seen, next.href)
                ? failed(`the \`next\` link on ${target.url} leads back to a page already listed`)
                : step(next, resources, seen),
            Unparseable: () => failed(`the \`next\` link on ${target.url} does not parse`),
            Offsite: ({ to }) => failed(`the \`next\` link on ${target.url} leads to ${to}`),
          }),
      });
    });
  return Option.match(own(path, ctx.options.baseUrl), {
    onNone: () => failed(`${path} is not a URL the kit can request`),
    onSome: (first) => step(first, [], []),
  });
};

/**
 * What the refused request left: each resource the second listing shows and
 * the first did not, whose attributes are the fixture's. A resource someone
 * else created meanwhile is told apart by its attributes, so it is neither
 * counted nor touched.
 */
const leftBehind = (payload: Payload, before: Listing, after: Listing): ReadonlyArray<string> =>
  Arr.filterMap(after.resources, ([id, stored]) =>
    !Arr.some(before.resources, ([held]) => held === id) &&
    Arr.isReadonlyArrayEmpty(
      readBackDifferences(asSent({ attributes: payload.attributes ?? {} }), stored),
    )
      ? Result.succeed(id)
      : Result.failVoid,
  );

/** Judges the answer to the all-or-nothing request, and what the collection shows after it. */
const judgeAllOrNothing = (
  ctx: Context,
  endpoint: Discovered,
  target: WriteTarget,
  payload: Payload,
  path: string,
  before: Listing,
  batch: Batch,
  adopt: Adopt,
): Effect.Effect<Verdict> => {
  const { observation } = batch;
  const sent = `an \`add\` of a "${target.key}" resource followed by a \`remove\` naming a \`lid\` no operation assigned`;
  if (observation.status === 0)
    return Effect.succeed(undecided(`${sent} got no answer (${describe(observation)})`));
  if (succeeded(observation))
    return Effect.succeed(
      undecided(
        `${sent} was answered ${observation.status}: the server failed no operation, so the request shows nothing of what it does when one fails (what the request created is disposed of)`,
      ),
    );
  if (refusedOnKeyGrounds(endpoint, observation.probe.headers, observation))
    return Effect.succeed(
      undecided(
        `${sent} was refused over \`Idempotency-Key\` (${describe(observation)}), so no operation was processed`,
      ),
    );
  const errorDocument: ReadonlyArray<Finding> = Arr.isReadonlyArrayEmpty(
    errorObjectsOf(observation.body),
  )
    ? [
        finding(atomicAllOrNothing.rule, {
          detail: `${sent} was refused without an error document`,
          expected: "an error document — a top-level `errors` array",
          observed: describe(observation),
          probe: observation.probe,
        }),
      ]
    : [];
  return Effect.flatMap(listing(ctx, path, payload.type), (after) =>
    Result.match(after, {
      onFailure: (reason) =>
        Effect.succeed(
          Arr.match(errorDocument, {
            onEmpty: () => undecided(`after ${sent} was refused, ${reason}`),
            onNonEmpty: (findings) => decided(before.requests + 1, findings),
          }),
        ),
      onSuccess: (after) => {
        const left = leftBehind(payload, before, after);
        const adopted = Effect.forEach(
          left,
          (id) => Effect.sync(() => adopt(target, payload, id, "the refused request left")),
          { concurrency: 1, discard: true },
        );
        const applied: ReadonlyArray<Finding> = Arr.isReadonlyArrayEmpty(left)
          ? []
          : [
              finding(atomicAllOrNothing.rule, {
                detail: `${sent} was refused, yet its \`add\` was applied: ${listed(
                  left.map((id) => `${payload.type}:${id}`),
                )} appeared in ${path}, with the fixture's attributes`,
                expected: `nothing applied — ${path} as it was before the request`,
                observed: `${describe(observation)}; then ${path} lists ${listed(
                  left.map((id) => `${payload.type}:${id}`),
                )}`,
                probe: observation.probe,
              }),
            ];
        return Effect.as(
          adopted,
          decided(before.requests + 1 + after.requests, [...applied, ...errorDocument]),
        );
      },
    }),
  );
};

const allOrNothingProbe = (
  ctx: Context,
  endpoint: Discovered,
  target: WriteTarget,
): Effect.Effect<Verdict> =>
  Result.match(Result.all({ path: listPathFor(ctx, target), payload: buildCreate(target) }), {
    onFailure: (reason) => Effect.succeed(undecided(reason)),
    onSuccess: ({ path, payload }) =>
      Effect.flatMap(listing(ctx, path, payload.type), (before) =>
        Result.match(before, {
          onFailure: (reason) => Effect.succeed(undecided(`before the request, ${reason}`)),
          onSuccess: (before) =>
            withBatch(
              ctx,
              atomicAllOrNothing.rule,
              [{ target, payload }],
              sendOperations(ctx, endpoint, [add(payload), removeByLid(payload.type, ABSENT_LID)]),
              (batch, adopt) =>
                judgeAllOrNothing(ctx, endpoint, target, payload, path, before, batch, adopt),
            ),
        }),
      ),
  });

const atomicAllOrNothing: RuleImpl = {
  creates: true,
  rule: atomicRule(
    "spec/atomic/all-or-nothing",
    "Atomic Operations — Processing",
    "MUST",
    "If an operation in an atomic operations request fails, the server MUST NOT apply any of the operations in that request, and MUST respond with an error document — so a request whose last operation names a `lid` no operation assigned leaves the collection as it was.",
  ),
  run: (ctx) => {
    const endpoint = operationsEndpoint(ctx);
    if (endpoint === undefined)
      return Effect.succeed(skip(atomicAllOrNothing.rule, "no atomic operations endpoint"));
    return overTargets(
      ctx,
      atomicAllOrNothing.rule,
      atomicTargets(ctx, endpoint),
      "atomic operations endpoint",
      (target) => allOrNothingProbe(ctx, endpoint, target),
    );
  },
};

// ---------------------------------------------------------------------------
// atomic:results ordering
// ---------------------------------------------------------------------------

const decodeResults = Schema.decodeUnknownOption(
  Schema.Struct({ "atomic:results": Schema.Array(Schema.Unknown) }),
);
const decodeCarried = Schema.decodeUnknownOption(
  Schema.Struct({ data: Schema.Struct({ type: Schema.String }) }),
);

/**
 * Each `atomic:results` entry as the `type` of the resource object it carries
 * as `data`, or none; none at all when the document carries no such array.
 */
const resultTypes = (
  observation: Observation,
): Option.Option<ReadonlyArray<Option.Option<string>>> =>
  Option.map(Option.flatMap(observation.body, decodeResults), (body) =>
    Arr.map(body["atomic:results"], (result) =>
      Option.map(decodeCarried(result), ({ data }) => data.type),
    ),
  );

/** Judges the results of an `add` then a `remove` of the same resource: the first carries it, the second nothing. */
const judgeOrder = (target: WriteTarget, payload: Payload, batch: Batch): Verdict => {
  const { observation } = batch;
  const sent = `an \`add\` of a "${target.key}" resource under a \`lid\`, then a \`remove\` of it by that \`lid\`,`;
  if (Option.isNone(batch.entries))
    return undecided(
      `${sent} was not accepted (${describe(observation)}) — the rule needs operations the server accepts`,
    );
  if (observation.status === 204)
    return undecided(`${sent} was answered 204 No Content, with no \`atomic:results\` to order`);
  const broken = (detail: string) =>
    decided(1, [
      finding(atomicResultsOrder.rule, {
        detail,
        expected:
          "`atomic:results` holding two result objects in request order: the `add`'s, carrying the created resource as `data`, then the `remove`'s, carrying none",
        observed: describe(observation),
        probe: observation.probe,
      }),
    ]);
  return Option.match(resultTypes(observation), {
    onNone: () =>
      broken(`${sent} was answered ${observation.status} with no \`atomic:results\` array`),
    onSome: (results) => judgeTwo(sent, payload.type, results, broken),
  });
};

/**
 * Judges the two results of an `add` then a `remove` of a `type` resource, by
 * which of them carry one: the first alone passes, the second alone is out of
 * order, and both or neither cannot be told apart.
 */
const judgeTwo = (
  sent: string,
  type: string,
  results: ReadonlyArray<Option.Option<string>>,
  broken: (detail: string) => Verdict,
): Verdict => {
  if (results.length !== 2)
    return broken(
      `${sent} was answered with ${counted(results.length, "result object")} for its two operations`,
    );
  const carrying = Arr.filterMap(results, (result, index) =>
    Option.contains(result, type) ? Result.succeed(index) : Result.failVoid,
  ).join(",");
  if (carrying === "0") return decided(1, []);
  if (carrying === "1")
    return broken(
      `${sent} was answered with its results out of order: the created "${type}" resource is in the second result, the \`remove\`'s, and not the first, the \`add\`'s`,
    );
  return undecided(
    `${sent} was answered with ${carrying === "" ? "neither result" : "both results"} carrying a "${type}" resource, so their order cannot be told`,
  );
};

/**
 * Reads the resource the order probe added and removed back, recording it as
 * deleted when it is gone (`404` or `410`) — the request's own `remove` was
 * its disposal — and answering the requests that took.
 */
const confirmRemoved = (ctx: Context, target: WriteTarget, batch: Batch): Effect.Effect<number> =>
  Option.match(
    Option.flatMap(batch.entries, (entries) =>
      Option.filter(Arr.head(entries), (entry) => entry.id !== undefined),
    ),
    {
      onNone: () => Effect.succeed(0),
      onSome: (entry) =>
        Result.match(readEndpointFor(ctx, target), {
          onFailure: () => Effect.succeed(0),
          onSuccess: (get) =>
            ctx.request({ url: pathFor(get, entry.id ?? ""), headers: jsonApiAccept }).pipe(
              Effect.map((observation) => {
                if (observation.status === 404 || observation.status === 410)
                  entry.disposal = "deleted";
                return 1;
              }),
            ),
        }),
    },
  );

const orderProbe = (
  ctx: Context,
  endpoint: Discovered,
  target: WriteTarget,
): Effect.Effect<Verdict> =>
  Result.match(buildCreate(target), {
    onFailure: (reason) => Effect.succeed(undecided(reason)),
    onSuccess: (payload) =>
      withBatch(
        ctx,
        atomicResultsOrder.rule,
        [{ target, payload }],
        sendOperations(ctx, endpoint, [add(payload, LID), removeByLid(payload.type, LID)]),
        (batch) =>
          Effect.map(confirmRemoved(ctx, target, batch), (requests) => {
            const verdict = judgeOrder(target, payload, batch);
            return Predicate.isTagged(verdict, "Decided")
              ? decided(verdict.requests + requests, verdict.findings)
              : verdict;
          }),
      ),
  });

const atomicResultsOrder: RuleImpl = {
  creates: true,
  rule: atomicRule(
    "spec/atomic/results-order",
    "Atomic Operations — Responses",
    "MUST",
    "A server that processes every operation of an atomic request successfully MUST answer with `atomic:results`, one result object per operation in the same order as the operations — the result of an operation that produces no data carrying no `data` — so a client can match each result to its operation by position.",
  ),
  run: (ctx) => {
    const endpoint = operationsEndpoint(ctx);
    if (endpoint === undefined)
      return Effect.succeed(skip(atomicResultsOrder.rule, "no atomic operations endpoint"));
    return overTargets(
      ctx,
      atomicResultsOrder.rule,
      atomicTargets(ctx, endpoint),
      "atomic operations endpoint",
      (target) => orderProbe(ctx, endpoint, target),
    );
  },
};

// ---------------------------------------------------------------------------
// remove naming a resource that does not exist
// ---------------------------------------------------------------------------

/** A to-many relationship of a type, by name, and a type its linkage admits. */
interface ToMany {
  readonly name: string;
  readonly type: string;
}

const RELATIONSHIP_PATH = /\/relationships\/([^/]+)$/;

/**
 * The first to-many relationship of `target`'s type that a relationship write
 * endpoint shows — its name, from the endpoint's path, and the first type its
 * payload admits. Which relationships the operations endpoint accepts is not
 * discoverable, so the `/relationships/…` endpoints stand in for it.
 */
const toManyOf = (ctx: Context, target: WriteTarget): Result.Result<ToMany, string> =>
  Result.fromOption(
    Arr.findFirst(ctx.endpoints, (endpoint) =>
      endpoint.role === "relationshipWrite" &&
      endpoint.segment === target.key &&
      endpoint.linkage === "many"
        ? Option.flatMap(Option.fromNullishOr(RELATIONSHIP_PATH.exec(endpoint.path)?.[1]), (name) =>
            Option.map(Arr.head(endpoint.linkageTypes), (type) => ({ name, type })),
          )
        : Option.none(),
    ),
    () =>
      `no relationship write endpoint shows a to-many relationship of "${target.key}" (with a resource type its payload names) for a \`remove\` to name`,
  );

/** Judges the answer to a `remove` naming a resource that does not exist: it must succeed. */
const judgeRemoveAbsent = (
  endpoint: Discovered,
  sent: string,
  observation: Observation,
): Verdict => {
  if (observation.status === 0)
    return undecided(`${sent} got no answer (${describe(observation)})`);
  if (refusedOnKeyGrounds(endpoint, observation.probe.headers, observation))
    return undecided(
      `${sent} was refused over \`Idempotency-Key\` (${describe(observation)}), so no operation was processed`,
    );
  if (observation.status === 403)
    return undecided(
      `${sent} answered 403 Forbidden — the server does not permit the removal at all (${describe(observation)})`,
    );
  return decided(
    2,
    observation.status === 200 || observation.status === 204
      ? []
      : [
          finding(atomicRemoveAbsent.rule, {
            detail: `${sent} answered ${observation.status}: the resource is already missing from the relationship, so the operation succeeds`,
            expected: "200 OK with `atomic:results`, or 204 No Content",
            observed: describe(observation),
            probe: observation.probe,
          }),
        ],
  );
};

const removeAbsentProbe = (
  ctx: Context,
  endpoint: Discovered,
  target: WriteTarget,
): Effect.Effect<Verdict> =>
  Result.match(toManyOf(ctx, target), {
    onFailure: (reason) => Effect.succeed(undecided(reason)),
    onSuccess: (relationship) =>
      withCreated(
        ctx,
        atomicRemoveAbsent.rule,
        target,
        {
          send: (payload) => sendOperations(ctx, endpoint, [add(payload)]),
          identify: atomicIdentity,
        },
        onOwnId(target, ({ payload }, id) => {
          const absent = { type: relationship.type, id: ctx.options.absentId };
          return Effect.map(
            sendOperations(ctx, endpoint, [
              {
                op: "remove",
                ref: { type: payload.type, id, relationship: relationship.name },
                data: [absent],
              },
            ]),
            (observation) =>
              judgeRemoveAbsent(
                endpoint,
                `a \`remove\` from the \`${relationship.name}\` of ${payload.type}:${id} naming ${absent.type}:${absent.id}, which does not exist,`,
                observation,
              ),
          );
        }),
      ),
  });

const atomicRemoveAbsent: RuleImpl = {
  creates: true,
  rule: atomicRule(
    "spec/atomic/remove-absent-succeeds",
    "Atomic Operations — Processing",
    "MUST",
    "A `remove` operation on a to-many relationship removes the members its `data` names, as a DELETE to the relationship's URL does; if the server is able to update the relationship it MUST return a result with no `data` — so a `remove` naming a resource that does not exist, which is already missing from the relationship, succeeds.",
  ),
  run: (ctx) => {
    const endpoint = operationsEndpoint(ctx);
    if (endpoint === undefined)
      return Effect.succeed(skip(atomicRemoveAbsent.rule, "no atomic operations endpoint"));
    return overTargets(
      ctx,
      atomicRemoveAbsent.rule,
      atomicTargets(ctx, endpoint),
      "atomic operations endpoint",
      (target) => removeAbsentProbe(ctx, endpoint, target),
    );
  },
};

/**
 * The atomic operations extension's rules, in report order.
 *
 * @internal
 */
export const atomicRules: ReadonlyArray<RuleImpl> = [
  atomicMalformedRejected,
  atomicResponseExt,
  atomicAllOrNothing,
  atomicLidResolution,
  atomicResultsOrder,
  atomicRemoveAbsent,
];
