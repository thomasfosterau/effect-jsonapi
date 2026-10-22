/**
 * The client-generated id rules ([§Client-Generated IDs]
 * (https://jsonapi.org/format/1.1/#crud-creating-client-ids)): what a create
 * under a client-generated id answers where the server supports them, the
 * 409 for a second create under the same id, and the 403 where it does not.
 *
 * The kit never makes up a client-generated id. Every probe here sends the id
 * the type's `writes[type].clientId` returns with its `create` payload, and
 * runs only for the case that fixture declares (`supported`), so a type
 * without one skips every rule here naming the key. What a create under a
 * client-generated id makes is the kit's like any other create's — vetted,
 * recorded and disposed of by `withCreated` (`./write.ts`); a 204 names no id,
 * so the kit takes the one it sent.
 *
 * @since 0.18.0
 * @internal
 */
import { Effect, Option, Result } from "effect";
import {
  type Context,
  describe,
  finding,
  type Observation,
  type Outcome,
  type Rule,
  type RuleImpl,
  succeeded,
} from "./core.js";
import {
  type Accepted,
  buildClientId,
  Created,
  decided,
  onAccepted,
  overTargets,
  plusRequests,
  primaryIdentity,
  refusedOnKeyGrounds,
  targets,
  undecided,
  type Verdict,
  viaClientId,
  withCreated,
  type WriteTarget,
} from "./write.js";

const SPEC = "https://jsonapi.org/format/1.1";

const rule = (id: string, anchor: string, requirement: string): Rule => ({
  id,
  tier: "spec",
  section: "Creating Resources",
  reference: `${SPEC}/#${anchor}`,
  level: "MUST",
  requirement,
});

/**
 * One probe per create endpoint whose type's fixture supplies a client id for
 * the case `supported` names; `probe` gets the id.
 */
const overClientIds = (
  ctx: Context,
  impl: Rule,
  supported: boolean,
  probe: (target: WriteTarget, id: string) => Effect.Effect<Verdict>,
): Effect.Effect<Outcome> =>
  overTargets(ctx, impl, targets(ctx, "create"), "create endpoint", (target) =>
    Result.match(buildClientId(target, supported), {
      onFailure: (reason) => Effect.succeed(undecided(reason)),
      onSuccess: (id) => probe(target, id),
    }),
  );

/** How a create under `id` reads in a finding. */
const under = (target: WriteTarget, id: string): string =>
  `a POST to ${target.createPath} of writes["${target.key}"].create under the client-generated id "${id}"`;

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
// Supported: 201 or 204
// ---------------------------------------------------------------------------

/** What a create under `id` the server accepted answered, judged. */
const judgeCreated = (
  impl: Rule,
  target: WriteTarget,
  id: string,
  { observation, payload }: Accepted,
): Verdict => {
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
      `${under(target, id)} answered 202 Accepted — the creation is deferred, so there is no created resource to check`,
    );
  if (observation.status === 204)
    return observation.text.trim() === ""
      ? decided(1, [])
      : broken(`the 204 to ${under(target, id)} carries a body`, "204 No Content with no body");
  const expected = `201 Created with a document whose \`data\` is the "${payload.type}" resource "${id}", or 204 No Content`;
  if (observation.status !== 201)
    return broken(`${under(target, id)} answered ${observation.status}`, expected);
  return Option.match(primaryIdentity(observation), {
    onNone: () =>
      broken(
        `the 201 to ${under(target, id)} does not carry the resource as primary data`,
        expected,
      ),
    onSome: (named) =>
      named.type === payload.type && named.id === id
        ? decided(1, [])
        : broken(
            `the 201 to ${under(target, id)} carries \`${named.type}:${named.id}\` — the server created it under another id, or answered with another resource`,
            expected,
          ),
  });
};

const createClientId: RuleImpl = {
  creates: true,
  rule: rule(
    "spec/status/create-client-id",
    "crud-creating-responses-204",
    "If a POST request did include a Client-Generated ID and the requested resource has been created successfully, the server MUST return either a 201 Created status code and response document (as described above) or a 204 No Content status code with no response document.",
  ),
  run: (ctx) =>
    overClientIds(ctx, createClientId.rule, true, (target, id) =>
      withCreated(
        ctx,
        createClientId.rule,
        target,
        viaClientId(ctx, target, id),
        onAccepted(target, (created) =>
          Effect.succeed(judgeCreated(createClientId.rule, target, id, created)),
        ),
      ),
    ),
};

// ---------------------------------------------------------------------------
// Supported: a duplicate is a 409
// ---------------------------------------------------------------------------

/** Why the first create under `id` gives the duplicate probe nothing to repeat, if it does not. */
const notHeldUnder = (target: WriteTarget, id: string, first: Accepted): Option.Option<string> =>
  first.entry.id === id
    ? Option.none()
    : Option.some(
        `${under(target, id)} ${
          first.entry.id === undefined
            ? `kept no id the kit may act on (${first.entry.detail ?? "it named none"})`
            : `made ${first.entry.type}:${first.entry.id}, not "${id}"`
        } — see spec/status/create-client-id`,
      );

const createConflictId: RuleImpl = {
  creates: true,
  rule: rule(
    "spec/status/create-conflict-id",
    "crud-creating-responses-409",
    "A server MUST return 409 Conflict when processing a POST request to create a resource with a client-generated ID that already exists.",
  ),
  run: (ctx) =>
    overClientIds(ctx, createConflictId.rule, true, (target, id) => {
      const via = viaClientId(ctx, target, id);
      return withCreated(
        ctx,
        createConflictId.rule,
        target,
        via,
        onAccepted(target, (first) =>
          Option.match(notHeldUnder(target, id, first), {
            onSome: (reason) => Effect.succeed(undecided(reason)),
            // A fresh payload under the same id, so a 409 is the id's and not
            // a uniqueness constraint on the fixture's attributes; anything a
            // wrong 2xx makes is vetted and disposed of like the first.
            onNone: () =>
              withCreated(ctx, createConflictId.rule, target, via, (second) =>
                Effect.succeed(
                  Created.$match(second, {
                    Unbuilt: ({ reason }) => undecided(reason),
                    Sent: ({ observation }) =>
                      judgeStatus(
                        createConflictId.rule,
                        target,
                        observation,
                        409,
                        `${under(target, id)}, sent again while ${first.entry.type}:${id} the kit had just created holds that id,`,
                      ),
                  }),
                ),
              ).pipe(Effect.map((verdict) => plusRequests(verdict, 1))),
          }),
        ),
      );
    }),
};

// ---------------------------------------------------------------------------
// Unsupported: 403
// ---------------------------------------------------------------------------

const createClientIdUnsupported: RuleImpl = {
  creates: true,
  rule: rule(
    "spec/status/create-client-id-unsupported",
    "crud-creating-client-ids",
    "A server MUST return 403 Forbidden in response to an unsupported request to create a resource with a client-generated ID.",
  ),
  run: (ctx) =>
    overClientIds(ctx, createClientIdUnsupported.rule, false, (target, id) =>
      withCreated(
        ctx,
        createClientIdUnsupported.rule,
        target,
        viaClientId(ctx, target, id),
        (created) =>
          Effect.succeed(
            Created.$match(created, {
              Unbuilt: ({ reason }) => undecided(reason),
              Sent: ({ observation, entry }) =>
                judgeStatus(
                  createClientIdUnsupported.rule,
                  target,
                  observation,
                  403,
                  `${under(target, id)} — which writes["${target.key}"].clientId declares the server does not support —`,
                  Option.match(
                    Option.flatMap(entry, ({ id: made }) => Option.fromUndefinedOr(made)),
                    {
                      onNone: () => "",
                      onSome: (made) =>
                        made === id
                          ? ` under that id`
                          : ` under the id "${made}" of its own, ignoring the one sent`,
                    },
                  ),
                ),
            }),
          ),
      ),
    ),
};

/**
 * The client-generated id rules, in report order.
 *
 * @internal
 */
export const clientIdRules: ReadonlyArray<RuleImpl> = [
  createClientId,
  createConflictId,
  createClientIdUnsupported,
];
