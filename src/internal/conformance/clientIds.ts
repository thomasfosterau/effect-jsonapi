/**
 * The client-generated id rules ([§Client-Generated IDs]
 * (https://jsonapi.org/format/1.1/#crud-creating-client-ids)): what a create
 * under a client-generated id answers where the server supports them, the
 * 409 for a second create under the same id, and the 403 where it does not —
 * each through the type's create endpoint and, where the api declares one,
 * through the atomic operations endpoint as an `add` operation, to which the
 * Atomic Operations extension applies the same rules (#471).
 *
 * The kit never makes up a client-generated id. Every probe here sends the id
 * the type's `writes[type].clientId` returns with its `create` payload, and
 * runs only for the case that fixture declares (`supported`), so a type
 * without one skips every rule here naming the key. What a create under a
 * client-generated id makes is the kit's like any other create's — vetted,
 * recorded and disposed of by `withCreated` (`./write.ts`); a 204 names no id,
 * nor does an `add` result with no `data`, so the kit takes the one it sent.
 * Each atomic probe is a request of one `add`, so a refused request — which,
 * all-or-nothing, applies nothing — is taken to have created nothing, and a
 * 2xx is recorded and disposed of whatever it answered.
 *
 * @since 0.18.0
 * @internal
 */
import { Array as Arr, Effect, Option, Predicate, Result, Schema } from "effect";
import { operationsEndpoint, sendOperations } from "./atomic.js";
import {
  type Context,
  describe,
  errorObjectsOf,
  finding,
  isRecord,
  type Observation,
  type Outcome,
  type Rule,
  type RuleImpl,
  skip,
  succeeded,
} from "./core.js";
import {
  type Accepted,
  atomicIdentity,
  atomicTargets,
  buildClientId,
  Created,
  decided,
  type Identity,
  onAccepted,
  overTargets,
  plusRequests,
  primaryIdentity,
  refusedOnKeyGrounds,
  targets,
  type Targets,
  undecided,
  type Verdict,
  type Via,
  viaClientId,
  withCreated,
  type WriteTarget,
} from "./write.js";

const SPEC = "https://jsonapi.org/format/1.1";

// ---------------------------------------------------------------------------
// Channels: through the create endpoint, or as an atomic `add`
// ---------------------------------------------------------------------------

/** How a client id probe creates, and what its accepted answer should be. */
interface Channel {
  /** The section the channel's rules cite. */
  readonly section: string;
  /** The targets to probe, or why the rule skips — the api declares no endpoint for it. */
  readonly found: (ctx: Context) => Result.Result<Targets, string>;
  /** The endpoints probed, for a skip reason. */
  readonly what: string;
  readonly via: (ctx: Context, target: WriteTarget, id: string) => Via;
  /** How a create under `id` reads in a finding. */
  readonly under: (target: WriteTarget, id: string) => string;
  /** The status an accepted create carrying a document answers. */
  readonly status: number;
  /** The resource that document carries, if it carries one. */
  readonly identity: (observation: Observation) => Option.Option<Identity>;
  /** Whether that document carries no resource, and need not — taken to have made the one asked for. */
  readonly bare: (observation: Observation) => boolean;
  readonly expected: (type: string, id: string) => string;
  /** Where that document carries the resource, for a finding. */
  readonly carries: string;
  /**
   * The JSON pointer of the probe's one operation, within which a refusal
   * over the `type` points; none through the create endpoint.
   */
  readonly operation: Option.Option<string>;
  /** The JSON pointer of the id the probe sends, which a 403's error object must name. */
  readonly idPointer: string;
  /** What that pointer names, for a finding. */
  readonly idNames: string;
}

const throughCreate: Channel = {
  section: "Creating Resources",
  found: (ctx) => Result.succeed(targets(ctx, "create")),
  what: "create endpoint",
  via: viaClientId,
  under: (target, id) =>
    `a POST to ${target.createPath} of writes["${target.key}"].create under the client-generated id "${id}"`,
  status: 201,
  identity: primaryIdentity,
  bare: () => false,
  expected: (type, id) =>
    `201 Created with a document whose \`data\` is the "${type}" resource "${id}", or 204 No Content`,
  carries: "the resource as primary data",
  operation: Option.none(),
  idPointer: "/data/id",
  idNames: "the resource's id",
};

const decodeFirstResult = Schema.decodeUnknownOption(
  Schema.Struct({ "atomic:results": Schema.NonEmptyArray(Schema.Unknown) }),
);

/** Whether the first `atomic:results` entry is a result object with no `data`. */
const firstResultBare = (observation: Observation): boolean =>
  Option.match(decodeFirstResult(observation.body), {
    onNone: () => false,
    onSome: (body) => {
      const first = body["atomic:results"][0];
      return isRecord(first) && !("data" in first);
    },
  });

/** The pointer of the one operation an atomic probe sends. */
const OPERATION = "/atomic:operations/0";

const throughAtomic: Channel = {
  section: "Creating Resources (with the Atomic Operations extension)",
  found: (ctx) =>
    Option.match(Option.fromUndefinedOr(operationsEndpoint(ctx)), {
      onNone: () => Result.fail("no atomic operations endpoint"),
      onSome: (endpoint) => Result.succeed(atomicTargets(ctx, endpoint)),
    }),
  what: "atomic operations endpoint",
  via: (ctx, target, id) => ({
    send: (payload) =>
      sendOperations(ctx, target.createEndpoint, [{ op: "add", data: { ...payload, id } }]),
    identify: (observation, payload) =>
      Option.orElse(atomicIdentity(observation), () =>
        observation.status === 204 || firstResultBare(observation)
          ? Option.some({ type: payload.type, id })
          : Option.none(),
      ),
  }),
  under: (target, id) =>
    `an atomic \`add\` to ${target.createPath} of writes["${target.key}"].create under the client-generated id "${id}"`,
  status: 200,
  identity: atomicIdentity,
  bare: firstResultBare,
  expected: (type, id) =>
    `200 OK with \`atomic:results\` whose first result's \`data\` is the "${type}" resource "${id}", or carries no \`data\`; or 204 No Content`,
  carries: "the resource as its first result's `data`",
  operation: Option.some(OPERATION),
  idPointer: `${OPERATION}/data/id`,
  idNames: "the operation's id",
};

const rule = (channel: Channel, id: string, anchor: string, requirement: string): Rule => ({
  id,
  tier: "spec",
  section: channel.section,
  reference: `${SPEC}/#${anchor}`,
  level: "MUST",
  requirement,
});

/**
 * One probe per target whose type's fixture supplies a client id for the case
 * `supported` names; `probe` gets the id.
 */
const overClientIds = (
  ctx: Context,
  channel: Channel,
  impl: Rule,
  supported: boolean,
  probe: (target: WriteTarget, id: string) => Effect.Effect<Verdict>,
): Effect.Effect<Outcome> =>
  Result.match(channel.found(ctx), {
    onFailure: (reason) => Effect.succeed(skip(impl, reason)),
    onSuccess: (found) =>
      overTargets(ctx, impl, found, channel.what, (target) =>
        Result.match(buildClientId(target, supported), {
          onFailure: (reason) => Effect.succeed(undecided(reason)),
          onSuccess: (id) => probe(target, id),
        }),
      ),
  });

/**
 * The verdict on an answer that only `status` passes, after the answers that
 * decide nothing: none at all, and a refusal over `Idempotency-Key`.
 */
const judgeStatus = (
  impl: Rule,
  target: WriteTarget,
  observation: Observation,
  status: number,
  detail: string,
  made = "",
): Verdict => {
  if (observation.status === 0)
    return undecided(`${detail} got no answer (${describe(observation)})`);
  if (refusedOnKeyGrounds(target.createEndpoint, observation.probe.headers, observation))
    return undecided(
      `${detail} was refused over \`Idempotency-Key\` (${describe(observation)}), which says nothing of its id`,
    );
  if (observation.status === status) return decided(1, []);
  return decided(1, [
    finding(impl, {
      detail: `${detail} answered ${observation.status}${succeeded(observation) ? `, accepting it${made}` : ""}`,
      expected: status === 409 ? "409 Conflict" : "403 Forbidden",
      observed: describe(observation),
      probe: observation.probe,
    }),
  ]);
};

// ---------------------------------------------------------------------------
// Supported: the resource is made under the id
// ---------------------------------------------------------------------------

/** What a create under `id` the server accepted answered, judged. */
const judgeCreated = (
  channel: Channel,
  impl: Rule,
  target: WriteTarget,
  id: string,
  { observation, payload }: Accepted,
): Verdict => {
  const under = channel.under(target, id);
  const broken = (detail: string, expected: string): Verdict =>
    decided(1, [
      finding(impl, {
        detail,
        expected,
        observed: describe(observation),
        probe: observation.probe,
      }),
    ]);
  if (observation.status === 202)
    return undecided(
      `${under} answered 202 Accepted — the creation is deferred, so there is no created resource to check`,
    );
  if (observation.status === 204)
    return observation.text.trim() === ""
      ? decided(1, [])
      : broken(`the 204 to ${under} carries a body`, "204 No Content with no body");
  const expected = channel.expected(payload.type, id);
  if (observation.status !== channel.status)
    return broken(`${under} answered ${observation.status}`, expected);
  if (channel.bare(observation)) return decided(1, []);
  return Option.match(channel.identity(observation), {
    onNone: () =>
      broken(`the ${observation.status} to ${under} does not carry ${channel.carries}`, expected),
    onSome: (named) =>
      named.type === payload.type && named.id === id
        ? decided(1, [])
        : broken(
            `the ${observation.status} to ${under} carries \`${named.type}:${named.id}\` — the server created it under another id, or answered with another resource`,
            expected,
          ),
  });
};

const clientIdRule = (channel: Channel, impl: Rule): RuleImpl => ({
  creates: true,
  rule: impl,
  run: (ctx) =>
    overClientIds(ctx, channel, impl, true, (target, id) =>
      withCreated(
        ctx,
        impl,
        target,
        channel.via(ctx, target, id),
        onAccepted(target, (created) =>
          Effect.succeed(judgeCreated(channel, impl, target, id, created)),
        ),
      ),
    ),
});

// ---------------------------------------------------------------------------
// Supported: a duplicate is a 409
// ---------------------------------------------------------------------------

/** Why the first create under `id` gives the duplicate probe nothing to repeat, if it does not. */
const notHeldUnder = (
  under: string,
  id: string,
  first: Accepted,
  see: string,
): Option.Option<string> =>
  first.entry.id === id
    ? Option.none()
    : Option.some(
        `${under} ${
          first.entry.id === undefined
            ? `kept no id the kit may act on (${first.entry.detail ?? "it named none"})`
            : `made ${first.entry.type}:${first.entry.id}, not "${id}"`
        } — see ${see}`,
      );

const conflictIdRule = (channel: Channel, impl: Rule, see: string): RuleImpl => ({
  creates: true,
  rule: impl,
  run: (ctx) =>
    overClientIds(ctx, channel, impl, true, (target, id) => {
      const via = channel.via(ctx, target, id);
      const under = channel.under(target, id);
      return withCreated(
        ctx,
        impl,
        target,
        via,
        onAccepted(target, (first) =>
          Option.match(notHeldUnder(under, id, first, see), {
            onSome: (reason) => Effect.succeed(undecided(reason)),
            // A fresh payload under the same id, so a 409 is the id's and not
            // a uniqueness constraint on the fixture's attributes; anything a
            // wrong 2xx makes is vetted and disposed of like the first. Each
            // is a request of its own: the second, refused, applies nothing.
            onNone: () =>
              withCreated(ctx, impl, target, via, (second) =>
                Effect.succeed(
                  Created.$match(second, {
                    Unbuilt: ({ reason }) => undecided(reason),
                    Sent: ({ observation }) =>
                      judgeStatus(
                        impl,
                        target,
                        observation,
                        409,
                        `${under}, sent again while ${first.entry.type}:${id} the kit had just created holds that id,`,
                      ),
                  }),
                ),
              ).pipe(Effect.map((verdict) => plusRequests(verdict, 1))),
          }),
        ),
      );
    }),
});

// ---------------------------------------------------------------------------
// Unsupported: 403
// ---------------------------------------------------------------------------

/** The `source.pointer` of every error object a refusal carries that has one. */
const errorPointers = (observation: Observation): ReadonlyArray<string> =>
  Arr.filterMap(errorObjectsOf(observation.body), (error) => {
    const source = error["source"];
    return isRecord(source) && Predicate.isString(source["pointer"])
      ? Result.succeed(source["pointer"])
      : Result.failVoid;
  });

/**
 * The 403 refusing a client id, judged on its error objects'
 * `source.pointer`s: one must name the id sent — `/data/id` through the create
 * endpoint, `<operation>/data/id` through an atomic `add` (owner decisions on
 * #471). None at all, or only others — the atomic operation itself, say, or
 * `/data/id` in an atomic document, where it points at nothing — is a finding.
 */
const judgePointers = (
  channel: Channel,
  impl: Rule,
  observation: Observation,
  detail: string,
): Verdict => {
  const wanted = channel.idPointer;
  const pointers = errorPointers(observation);
  if (Arr.contains(pointers, wanted)) return decided(1, []);
  return decided(1, [
    finding(impl, {
      detail: `the 403 to ${detail} ${Arr.match(pointers, {
        onEmpty: () => "names no `source.pointer`",
        onNonEmpty: (named) =>
          `names \`source.pointer\` ${named.map((pointer) => `"${pointer}"`).join(", ")}, not ${channel.idNames}`,
      })}`,
      expected: `403 Forbidden with an error object whose \`source.pointer\` is ${wanted}`,
      observed: describe(observation),
      probe: observation.probe,
    }),
  ]);
};

/** Under what id a 2xx the server should have refused made its resource, for a finding. */
const madeUnder = (made: Option.Option<string>, id: string) =>
  Option.match(made, {
    onNone: () => "",
    onSome: (named) =>
      named === id
        ? ` under that id`
        : ` under the id "${named}" of its own, ignoring the one sent`,
  });

const judgeUnsupported = (
  channel: Channel,
  impl: Rule,
  target: WriteTarget,
  id: string,
  observation: Observation,
  made: string,
): Verdict => {
  const detail = `${channel.under(target, id)} — which writes["${target.key}"].clientId declares the server does not support —`;
  // The operations endpoint may not take every type with a fixture: a
  // refusal of the `type` says nothing of the id.
  if (
    Option.isSome(channel.operation) &&
    observation.status !== 403 &&
    !succeeded(observation) &&
    Arr.contains(errorPointers(observation), `${channel.operation.value}/data/type`)
  )
    return undecided(
      `${channel.under(target, id)} was refused over its \`type\` (${describe(observation)}), which says nothing of its id`,
    );
  const verdict = judgeStatus(impl, target, observation, 403, detail, made);
  return observation.status === 403 && Predicate.isTagged(verdict, "Decided")
    ? judgePointers(channel, impl, observation, channel.under(target, id))
    : verdict;
};

const unsupportedRule = (channel: Channel, impl: Rule): RuleImpl => ({
  creates: true,
  rule: impl,
  run: (ctx) =>
    overClientIds(ctx, channel, impl, false, (target, id) =>
      withCreated(ctx, impl, target, channel.via(ctx, target, id), (created) =>
        Effect.succeed(
          Created.$match(created, {
            Unbuilt: ({ reason }) => undecided(reason),
            Sent: ({ observation, entry }) =>
              judgeUnsupported(
                channel,
                impl,
                target,
                id,
                observation,
                madeUnder(
                  Option.flatMap(entry, ({ id: made }) => Option.fromUndefinedOr(made)),
                  id,
                ),
              ),
          }),
        ),
      ),
    ),
});

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

const createClientId = clientIdRule(
  throughCreate,
  rule(
    throughCreate,
    "spec/status/create-client-id",
    "crud-creating-responses-204",
    "If a POST request did include a Client-Generated ID and the requested resource has been created successfully, the server MUST return either a 201 Created status code and response document (as described above) or a 204 No Content status code with no response document.",
  ),
);

const createConflictId = conflictIdRule(
  throughCreate,
  rule(
    throughCreate,
    "spec/status/create-conflict-id",
    "crud-creating-responses-409",
    "A server MUST return 409 Conflict when processing a POST request to create a resource with a client-generated ID that already exists.",
  ),
  "spec/status/create-client-id",
);

const createClientIdUnsupported = unsupportedRule(
  throughCreate,
  rule(
    throughCreate,
    "spec/status/create-client-id-unsupported",
    "crud-creating-client-ids",
    "A server MUST return 403 Forbidden in response to an unsupported request to create a resource with a client-generated ID; its error object's `source.pointer` names the value in the request document that caused it, so the refusal names the resource object's id, `/data/id`.",
  ),
);

const addClientId = clientIdRule(
  throughAtomic,
  rule(
    throughAtomic,
    "spec/atomic/add-client-id",
    "crud-creating-client-ids",
    "An atomic `add` operation creates a resource as a POST does, so where the server supports Client-Generated IDs, an `add` whose resource object includes one and succeeds MUST create the resource under that ID: its result carries the resource, under that ID, as `data` — or carries no `data`, or the request is answered 204 No Content.",
  ),
);

const addConflictId = conflictIdRule(
  throughAtomic,
  rule(
    throughAtomic,
    "spec/atomic/add-conflict-id",
    "crud-creating-responses-409",
    "A server MUST return 409 Conflict when processing an atomic `add` operation that creates a resource with a client-generated ID that already exists.",
  ),
  "spec/atomic/add-client-id",
);

const addClientIdUnsupported = unsupportedRule(
  throughAtomic,
  rule(
    throughAtomic,
    "spec/atomic/add-client-id-unsupported",
    "crud-creating-client-ids",
    "A server MUST return 403 Forbidden in response to an atomic `add` operation that creates a resource with an unsupported client-generated ID; its error object's `source.pointer` names the value in the request document that caused it, so the refusal names the operation's id, `/atomic:operations/N/data/id` (N the operation's index).",
  ),
);

/**
 * The client-generated id rules through the create endpoint, in report order.
 *
 * @internal
 */
export const clientIdRules: ReadonlyArray<RuleImpl> = [
  createClientId,
  createConflictId,
  createClientIdUnsupported,
];

/**
 * The client-generated id rules through the atomic operations endpoint, in
 * report order.
 *
 * @internal
 */
export const atomicClientIdRules: ReadonlyArray<RuleImpl> = [
  addClientId,
  addConflictId,
  addClientIdUnsupported,
];
