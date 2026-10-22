/**
 * This package's own profile rules — what a server must do *beyond* JSON:API
 * v1.1 to implement the conventions this library bakes in.
 *
 * Three groups:
 *
 *   - **The filter grammar profile** (`docs/filter-grammar.md`, published at
 *     `Filter.PROFILE_URI`). Its §2 surface syntax, §3 canonical encoding, §4
 *     closed operator core, §5 advertisement and §7 error pointers are all
 *     normative today and mechanically checkable over the wire. Its
 *     *evaluation* semantics are not — they need an oracle over known data —
 *     and are declared as a coverage gap rather than silently omitted.
 *   - **The Idempotency-Key profile** (`docs/idempotency.md`, published at
 *     `Idempotency.PROFILE_URI`). Only its advertisement (§1) is checked, on
 *     the 2xx a create or update probe gets from the `writes` fixture; delete
 *     and atomic writes, and what a *retried* write does, are declared as a
 *     coverage gap.
 *   - **Library conventions** that the spec leaves optional but this package
 *     takes a position on: advertising `jsonapi`, and accepting the
 *     repeated-key spelling of every comma-separated query family.
 *
 * Kept in a separate suite so a consumer can run the spec tier without
 * adopting any of it.
 *
 * @since 0.15.0
 * @internal
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { PROFILE_URI } from "../../Filter.js";
import { PROFILE_URI as IDEMPOTENCY_PROFILE_URI } from "../../Idempotency.js";
import {
  type Context,
  coverageNote,
  describe,
  type Discovered,
  finding,
  type Finding,
  isRecord,
  jsonApiAccept,
  noProbeReason,
  type Observation,
  parseMediaType,
  probeable,
  type Rule,
  type RuleImpl,
  settle,
  skip,
  sourceParametersOf,
  withQuery,
} from "./core.js";
import {
  accepted,
  buildUpdate,
  decided,
  onAccepted,
  overTargetsAll,
  ownId,
  sendUpdate,
  type Targets,
  targets,
  undecided,
  type Verdict,
  viaCreateEndpoint,
  withCreated,
  type WriteTarget,
} from "./write.js";
import { quote } from "./crawl.js";

const GRAMMAR =
  "https://github.com/thomasfosterau/effect-jsonapi/blob/trunk/docs/filter-grammar.md";

const filterRule = (
  id: string,
  section: string,
  anchor: string,
  level: Rule["level"],
  requirement: string,
): Rule => ({
  id,
  tier: "profile",
  section: `filter-grammar/v1 ${section}`,
  reference: `${GRAMMAR}#${anchor}`,
  level,
  requirement,
});

const conventionRule = (
  id: string,
  section: string,
  level: Rule["level"],
  requirement: string,
): Rule => ({
  id,
  tier: "profile",
  section,
  reference: "https://github.com/thomasfosterau/effect-jsonapi#readme",
  level,
  requirement,
});

const readable = (ctx: Context) =>
  probeable(ctx, ["collection", "resource", "related", "relationship"]);

/**
 * Endpoints that speak the filter grammar — `filter: true`, which admits
 * arbitrary `filter[…]` keys. An endpoint using the per-key escape hatch
 * (`filter: { q: Schema.String }`) does **not** implement the profile, so the
 * grammar rules skip rather than fail against it.
 */
const grammarEndpoints = (
  ctx: Context,
): ReadonlyArray<{ readonly endpoint: Discovered; readonly path: string }> =>
  readable(ctx).resolved.filter(({ endpoint }) => endpoint.filterGrammar);

const NO_GRAMMAR =
  "no endpoint declares the filter grammar (`filter: true`); endpoints using the per-key `filter: { … }` escape hatch do not implement the profile";

/**
 * A field name the target is known to accept in a filter position, learned from
 * the attributes it actually returns. Guessing would make every rejection rule
 * pass for the wrong reason (an undeclared field is also a 400).
 */
const learnField = (ctx: Context, path: string) =>
  Effect.gen(function* () {
    const observation = yield* ctx.request({ url: path, headers: jsonApiAccept });
    const body = observation.body;
    if (!isRecord(body)) return undefined;
    const data = body["data"];
    const first = Array.isArray(data) ? data.find(isRecord) : isRecord(data) ? data : undefined;
    if (first === undefined) return undefined;
    const attributes = first["attributes"];
    if (!isRecord(attributes)) return undefined;
    const keys = Object.keys(attributes);
    return keys.length === 0 ? undefined : { field: keys[0]!, value: attributes[keys[0]!] };
  });

// ---------------------------------------------------------------------------
// The filter grammar profile
// ---------------------------------------------------------------------------

const advertisesProfile: RuleImpl = {
  rule: filterRule(
    "profile/filter/advertises-profile-uri",
    "§5 Profile URI",
    "5-profile-uri",
    "MUST",
    `A server implementing the filter grammar MUST advertise it on the media type of responses from the endpoints that implement it: \`profile="${PROFILE_URI}"\`.`,
  ),
  run: (ctx) =>
    Effect.gen(function* () {
      const targets = grammarEndpoints(ctx);
      if (targets.length === 0) return skip(advertisesProfile.rule, NO_GRAMMAR);
      const findings: Array<Finding> = [];
      for (const { path } of targets) {
        const observation = yield* ctx.request({ url: path, headers: jsonApiAccept });
        if (observation.status < 200 || observation.status >= 300) continue;
        const header = observation.contentType;
        const profiles =
          header === undefined
            ? []
            : parseMediaType(header)
                .parameters.filter(([name]) => name === "profile")
                .flatMap(([, value]) => value.split(" "));
        if (!profiles.includes(PROFILE_URI)) {
          findings.push(
            finding(advertisesProfile.rule, {
              detail: `${path} speaks the filter grammar but does not advertise the profile`,
              expected: `a \`profile\` parameter containing ${PROFILE_URI}`,
              observed: header === undefined ? "no Content-Type" : header,
              probe: observation.probe,
            }),
          );
        }
      }
      return settle(advertisesProfile.rule, targets.length, findings);
    }),
};

/**
 * The three distinct rejections §2 requires, each probed against a field the
 * target is known to accept, and each checked for the `source.parameter` §7
 * mandates.
 */
const rejections: RuleImpl = {
  rule: filterRule(
    "profile/filter/rejections",
    "§2 Surface syntax, §4 Closed operator core, §7 Error pointers",
    "2-surface-syntax",
    "MUST",
    "An operator outside the closed core, an undeclared field, a malformed key depth, a repeated `filter[…]` key and a literal that fails the attribute's codec MUST each be rejected with 400 Bad Request and one error object whose `source.parameter` names the offending flat key.",
  ),
  run: (ctx) =>
    Effect.gen(function* () {
      const target = grammarEndpoints(ctx)[0];
      if (target === undefined) return skip(rejections.rule, NO_GRAMMAR);
      const learned = yield* learnField(ctx, target.path);
      if (learned === undefined) {
        return skip(
          rejections.rule,
          `${target.path} returned no resource with attributes, so no field is known to be declared filterable`,
        );
      }
      const probes: ReadonlyArray<{
        readonly key: string;
        readonly value: string;
        readonly why: string;
        readonly repeat?: boolean;
      }> = [
        {
          key: `filter[${learned.field}][definitelyNotAnOperator]`,
          value: "1",
          why: "an operator outside the core",
        },
        { key: "filter[definitelyNotAField]", value: "1", why: "an undeclared field" },
        {
          key: `filter[${learned.field}][gt][extra]`,
          value: "1",
          why: "a key deeper than the grammar admits",
        },
        { key: `filter[${learned.field}]`, value: "a", why: "a repeated filter key", repeat: true },
      ];
      const findings: Array<Finding> = [];
      for (const probe of probes) {
        const pairs: ReadonlyArray<readonly [string, string]> =
          probe.repeat === true
            ? [
                [probe.key, probe.value],
                [probe.key, "b"],
              ]
            : [[probe.key, probe.value]];
        const observation = yield* ctx.request({
          url: withQuery(target.path, pairs),
          headers: jsonApiAccept,
        });
        if (observation.status !== 400) {
          findings.push(
            finding(rejections.rule, {
              detail: `${probe.why} (\`${probe.key}\`) was not rejected`,
              expected: "400 Bad Request",
              observed: describe(observation),
              probe: observation.probe,
            }),
          );
          continue;
        }
        const parameters = sourceParametersOf(observation);
        if (!parameters.includes(probe.key)) {
          findings.push(
            finding(rejections.rule, {
              detail: `the 400 for ${probe.why} does not name \`${probe.key}\` in \`source.parameter\``,
              expected: `source: { parameter: "${probe.key}" }`,
              observed:
                parameters.length === 0
                  ? "no error object carried `source.parameter`"
                  : `source.parameter: ${parameters.map((p) => JSON.stringify(p)).join(", ")}`,
              probe: observation.probe,
            }),
          );
        }
      }
      return settle(rejections.rule, probes.length, findings);
    }),
};

const spellingEquivalence: RuleImpl = {
  rule: filterRule(
    "profile/filter/spelling-equivalence",
    "§2.2 Shorthand, §3 Canonical encoding",
    "3-canonical-encoding",
    "MUST",
    "Shorthand is the desugared spelling of the group form and the canonical string is a function of the AST alone, so every URL that decodes to the same tree — whatever its key order, ids or `[eq]`/bare spelling — MUST produce the same response.",
  ),
  run: (ctx) =>
    Effect.gen(function* () {
      const target = grammarEndpoints(ctx)[0];
      if (target === undefined) return skip(spellingEquivalence.rule, NO_GRAMMAR);
      const learned = yield* learnField(ctx, target.path);
      if (learned === undefined || typeof learned.value !== "string") {
        return skip(
          spellingEquivalence.rule,
          `${target.path} returned no resource with a string attribute to build equivalent filters from`,
        );
      }
      const field = learned.field;
      const value = learned.value;
      const spellings: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, string]>]> =
        [
          ["bare shorthand", [[`filter[${field}]`, value]]],
          ["explicit `[eq]` shorthand", [[`filter[${field}][eq]`, value]]],
          [
            "group form",
            [
              [`filter[c0][condition][path]`, field],
              [`filter[c0][condition][operator]`, "eq"],
              [`filter[c0][condition][value]`, value],
            ],
          ],
          [
            "group form, keys permuted",
            [
              [`filter[x][condition][value]`, value],
              [`filter[x][condition][path]`, field],
              [`filter[x][condition][operator]`, "eq"],
            ],
          ],
        ];
      const findings: Array<Finding> = [];
      const observations: Array<{
        readonly label: string;
        readonly status: number;
        readonly body: string;
      }> = [];
      for (const [label, pairs] of spellings) {
        const observation = yield* ctx.request({
          url: withQuery(target.path, pairs),
          headers: jsonApiAccept,
        });
        observations.push({ label, status: observation.status, body: observation.text });
        if (observation.status !== 200) {
          findings.push(
            finding(spellingEquivalence.rule, {
              detail: `the ${label} spelling of \`${field} eq ${JSON.stringify(value)}\` was not accepted`,
              expected: "200 OK — every spelling decodes to the same tree",
              observed: describe(observation),
              probe: observation.probe,
            }),
          );
        }
      }
      const accepted = observations.filter((observation) => observation.status === 200);
      const reference = accepted[0];
      if (reference !== undefined) {
        for (const observation of accepted.slice(1)) {
          if (observation.body !== reference.body) {
            findings.push(
              finding(spellingEquivalence.rule, {
                detail: `the ${observation.label} spelling answered a different document from the ${reference.label}`,
                expected: "byte-identical responses for URLs that decode to the same tree",
                observed: `${reference.label}: ${reference.body.slice(0, 120)}… vs ${observation.label}: ${observation.body.slice(
                  0,
                  120,
                )}…`,
                probe: undefined,
              }),
            );
          }
        }
      }
      return settle(spellingEquivalence.rule, spellings.length, findings);
    }),
};

// ---------------------------------------------------------------------------
// The Idempotency-Key profile
// ---------------------------------------------------------------------------

const IDEMPOTENCY =
  "https://github.com/thomasfosterau/effect-jsonapi/blob/trunk/docs/idempotency.md";

const idempotencyRule = (
  id: string,
  section: string,
  anchor: string,
  level: Rule["level"],
  requirement: string,
): Rule => ({
  id,
  tier: "profile",
  section: `idempotency/v1 ${section}`,
  reference: `${IDEMPOTENCY}#${anchor}`,
  level,
  requirement,
});

const decodeJsonApiProfile = Schema.decodeUnknownOption(
  Schema.Struct({
    jsonapi: Schema.Struct({ profile: Schema.Array(Schema.Unknown) }),
  }),
);

/** The profile URIs an answer's top-level `jsonapi.profile` names. */
const documentProfiles = (observation: Observation): ReadonlyArray<string> =>
  Option.match(decodeJsonApiProfile(observation.body), {
    onNone: () => [],
    onSome: ({ jsonapi }) => Arr.filter(jsonapi.profile, Predicate.isString),
  });

/** The profile URIs an answer's `Content-Type` names in its `profile` parameter (space-separated). */
const mediaTypeProfiles = (observation: Observation): ReadonlyArray<string> =>
  Option.match(Option.fromUndefinedOr(observation.contentType), {
    onNone: () => [],
    onSome: (header) =>
      parseMediaType(header)
        .parameters.filter(([name]) => name === "profile")
        .flatMap(([, value]) => value.split(" ")),
  });

/** Whether an endpoint's headers declare `Idempotency-Key`, required or optional. */
const declaresKey = (endpoint: Discovered): boolean => endpoint.idempotencyKey !== "absent";

/**
 * What a write's 2xx answer says of the profile, over the `requests` it took
 * to get it. Either place naming it passes — a media type can, even on an
 * answer with no body — and only then is an empty body a reason not to
 * decide: with no document there is no `jsonapi` member that could have named
 * it.
 */
const advertisedOn = (
  rule: Rule,
  write: string,
  observation: Observation,
  requests = 1,
): Verdict => {
  const named = [...documentProfiles(observation), ...mediaTypeProfiles(observation)];
  if (named.includes(IDEMPOTENCY_PROFILE_URI)) return decided(requests, []);
  if (observation.text === "")
    return undecided(
      `${write} answered ${observation.status} with no document, and its media type does not name the profile, so no \`jsonapi\` member could`,
    );
  const jsonapi = isRecord(observation.body) ? observation.body["jsonapi"] : undefined;
  return decided(requests, [
    finding(rule, {
      detail: `the ${observation.status} ${write}, which accepts \`Idempotency-Key\`, does not advertise the profile`,
      expected: `\`jsonapi.profile\` or the media type's \`profile\` parameter naming ${IDEMPOTENCY_PROFILE_URI}`,
      observed: `jsonapi: ${jsonapi === undefined ? "(none)" : quote(jsonapi)} · Content-Type: ${
        observation.contentType === undefined ? "(none)" : quote(observation.contentType)
      }`,
      probe: observation.probe,
    }),
  ]);
};

const creating = (target: WriteTarget): string =>
  `creating a "${target.key}" resource through ${target.createEndpoint.path}`;

/**
 * The endpoints the rule probes: each create and update endpoint declaring
 * `Idempotency-Key`. A create endpoint whose type has such an update endpoint
 * is not probed on its own — the update's own create is judged along with it.
 * Each update endpoint is probed, so a type with several (a `PATCH` and a
 * `PUT`, say) gets one create and one update through each, as the spec tier's
 * update rule gives it.
 */
const idempotentTargets = (ctx: Context): Targets => {
  const creates = targets(ctx, "create", declaresKey);
  const updates = targets(ctx, "update", declaresKey);
  const updated = Arr.map(updates.targets, (target) => target.key);
  return {
    targets: [
      ...creates.targets.filter((target) => !Arr.contains(updated, target.key)),
      ...updates.targets,
    ],
    missing: [...creates.missing, ...updates.missing],
    candidates: creates.candidates + updates.candidates,
  };
};

/** One create through an endpoint declaring the header, judged on its answer. */
const probeCreate = (ctx: Context, rule: Rule, target: WriteTarget) =>
  withCreated(
    ctx,
    rule,
    target,
    viaCreateEndpoint(ctx, target),
    onAccepted(target, ({ observation }) =>
      Effect.succeed(advertisedOn(rule, creating(target), observation)),
    ),
  ).pipe(Effect.map(Arr.of));

/**
 * One create and one update of what it made, through an update endpoint
 * declaring the header: the update's answer is judged, and the create's too
 * when its endpoint declares the header. Either way the probe counts both
 * requests, as the spec tier's update rule does: the update's verdict counts
 * the create as well when the create is not judged on its own.
 */
const probeUpdate = (ctx: Context, rule: Rule, target: WriteTarget) =>
  withCreated(ctx, rule, target, viaCreateEndpoint(ctx, target), (created) =>
    Result.match(accepted(target, created), {
      onFailure: (reason) => Effect.succeed([undecided(reason)]),
      onSuccess: (made) => {
        const judgesCreate = declaresKey(target.createEndpoint);
        const onCreate = judgesCreate
          ? [advertisedOn(rule, creating(target), made.observation)]
          : [];
        return Result.match(Result.all({ id: ownId(made), patch: buildUpdate(target) }), {
          onFailure: (reason) => Effect.succeed([...onCreate, undecided(reason)]),
          onSuccess: ({ id, patch }) =>
            sendUpdate(ctx, target, made.payload.type, id, patch).pipe(
              Effect.map((observation) => [
                ...onCreate,
                observation.status >= 200 && observation.status < 300
                  ? advertisedOn(
                      rule,
                      `updating ${made.payload.type}:${id} through ${target.endpoint.path}`,
                      observation,
                      judgesCreate ? 1 : 2,
                    )
                  : undecided(
                      `the server did not accept writes["${target.key}"].update on the resource the kit had just created (${describe(observation)})`,
                    ),
              ]),
            ),
        });
      },
    }),
  );

/**
 * `docs/idempotency.md` §1: a server advertises the profile in `jsonapi.profile`
 * and MAY also name it on the media type, so either place passes. Only a write
 * shows it — the kit cannot read an endpoint's answer to a write without
 * making one — so the rule runs, on the `writes` fixture under
 * `mutating: true`, one create per create endpoint declaring the header and
 * one create plus one update per update endpoint declaring it (a create
 * endpoint is not probed again for a type an update endpoint covers). Delete
 * endpoints (usually a 204, with no document) and the atomic endpoint are not
 * probed. A key is sent only to an endpoint that requires one.
 */
const advertisesIdempotencyProfile: RuleImpl = {
  creates: true,
  rule: idempotencyRule(
    "profile/idempotency/advertises-profile-uri",
    "§1 What the profile is, and is not",
    "1-what-the-profile-is-and-is-not",
    "SHOULD",
    `A server implementing the Idempotency-Key profile SHOULD advertise it: the 2xx response to a create or an update on an endpoint that accepts the \`Idempotency-Key\` header names \`${IDEMPOTENCY_PROFILE_URI}\` in the top-level \`jsonapi.profile\` member (\`Idempotency.jsonapi\`) or in the \`profile\` parameter of its media type.`,
  ),
  run: (ctx) =>
    overTargetsAll(
      ctx,
      advertisesIdempotencyProfile.rule,
      idempotentTargets(ctx),
      "create or update endpoint declaring the `Idempotency-Key` header",
      (target) =>
        target.endpoint.role === "update"
          ? probeUpdate(ctx, advertisesIdempotencyProfile.rule, target)
          : probeCreate(ctx, advertisesIdempotencyProfile.rule, target),
    ),
};

// ---------------------------------------------------------------------------
// Library conventions
// ---------------------------------------------------------------------------

const jsonApiMember: RuleImpl = {
  rule: conventionRule(
    "profile/document/jsonapi-member",
    "Library convention — version advertisement",
    "SHOULD",
    'The spec makes the top-level `jsonapi` member optional, but a v1.1 server SHOULD advertise the version it implements: every response document carries `jsonapi: { version: "1.1" }`.',
  ),
  run: (ctx) =>
    Effect.gen(function* () {
      const { resolved, unresolved } = readable(ctx);
      if (resolved.length === 0)
        return skip(jsonApiMember.rule, noProbeReason("JSON:API read endpoint", unresolved));
      const findings: Array<Finding> = [];
      for (const { path } of resolved) {
        const observation = yield* ctx.request({ url: path, headers: jsonApiAccept });
        if (observation.status < 200 || observation.status >= 300) continue;
        const body = observation.body;
        if (!isRecord(body)) continue;
        const jsonapi = body["jsonapi"];
        if (!isRecord(jsonapi) || jsonapi["version"] !== "1.1") {
          findings.push(
            finding(jsonApiMember.rule, {
              detail: `${path} answered a document that does not advertise the JSON:API version`,
              expected: `jsonapi: { version: "1.1" }`,
              observed: jsonapi === undefined ? "no `jsonapi` member" : JSON.stringify(jsonapi),
              probe: observation.probe,
            }),
          );
        }
      }
      return settle(jsonApiMember.rule, resolved.length, findings, coverageNote(unresolved));
    }),
};

/**
 * JSON:API's comma grammar and the repeated-key spelling denote the same set.
 * The spec only defines the comma form, so this is the library's position, not
 * a spec MUST — and the two spellings must agree family by family.
 */
const repeatedKeySpelling: RuleImpl = {
  rule: conventionRule(
    "profile/query/repeated-key-spelling",
    "Library convention — comma-separated query families",
    "MUST",
    "Every comma-separated query family accepts both the comma spelling (`?include=a,b`) and the repeated-key spelling (`?include=a&include=b`), and the two denote the same set.",
  ),
  run: (ctx) =>
    Effect.gen(function* () {
      const { resolved, unresolved } = readable(ctx);
      if (resolved.length === 0) {
        return skip(repeatedKeySpelling.rule, noProbeReason("JSON:API read endpoint", unresolved));
      }
      const findings: Array<Finding> = [];
      let probes = 0;
      let evaluated = 0;
      for (const { endpoint, path } of resolved) {
        // Learn two accepted values per family from the target itself: a
        // repeated-key probe only means something for values the comma spelling
        // already accepts.
        const families = yield* learnFamilies(ctx, endpoint, path);
        for (const family of families) {
          const comma = withQuery(path, [[family.key, family.values.join(",")]]);
          const repeated = withQuery(
            path,
            family.values.map((value) => [family.key, value] as const),
          );
          const commaObservation = yield* ctx.request({ url: comma, headers: jsonApiAccept });
          probes += 1;
          if (commaObservation.status !== 200) continue;
          const repeatedObservation = yield* ctx.request({ url: repeated, headers: jsonApiAccept });
          probes += 1;
          evaluated += 1;
          if (repeatedObservation.status !== 200) {
            findings.push(
              finding(repeatedKeySpelling.rule, {
                detail: `\`?${family.key}=${family.values.join(",")}\` is accepted but the repeated-key spelling of the same set is not`,
                expected: "200 OK — the two spellings denote the same set",
                observed: describe(repeatedObservation),
                probe: repeatedObservation.probe,
              }),
            );
          } else if (repeatedObservation.text !== commaObservation.text) {
            findings.push(
              finding(repeatedKeySpelling.rule, {
                detail: `the comma and repeated-key spellings of \`${family.key}\` answered different documents`,
                expected: "byte-identical responses",
                observed: `comma: ${commaObservation.text.slice(0, 120)}… vs repeated: ${repeatedObservation.text.slice(
                  0,
                  120,
                )}…`,
                probe: repeatedObservation.probe,
              }),
            );
          }
        }
      }
      if (evaluated === 0) {
        return skip(
          repeatedKeySpelling.rule,
          "no endpoint accepted a two-value comma spelling to compare the repeated-key spelling against",
        );
      }
      return settle(repeatedKeySpelling.rule, probes, findings);
    }),
};

/**
 * Two accepted values for each comma-separated family this endpoint declares,
 * learned from the documents it returns: `fields[TYPE]` from the attributes it
 * emits, `sort` from the same, `include` only when a relationship name can be
 * read off a returned resource.
 */
const learnFamilies = (ctx: Context, endpoint: Discovered, path: string) =>
  Effect.gen(function* () {
    const observation = yield* ctx.request({ url: path, headers: jsonApiAccept });
    const body = observation.body;
    const out: Array<{ readonly key: string; readonly values: ReadonlyArray<string> }> = [];
    if (!isRecord(body)) return out;
    const data = body["data"];
    const first = Array.isArray(data) ? data.find(isRecord) : isRecord(data) ? data : undefined;
    if (first === undefined) return out;
    const attributes = first["attributes"];
    const attributeKeys = isRecord(attributes) ? Object.keys(attributes) : [];
    const type = first["type"];
    if (
      typeof type === "string" &&
      endpoint.queryKeys.includes(`fields[${type}]`) &&
      attributeKeys.length >= 2
    ) {
      out.push({ key: `fields[${type}]`, values: [attributeKeys[0]!, attributeKeys[1]!] });
    }
    if (endpoint.queryKeys.includes("sort") && attributeKeys.length >= 2) {
      out.push({ key: "sort", values: [attributeKeys[0]!, attributeKeys[1]!] });
    }
    const relationships = first["relationships"];
    if (endpoint.queryKeys.includes("include") && isRecord(relationships)) {
      // Only relationships carrying inline linkage are includable; a paginated
      // relationship is links-only and `?include=` of it is a legitimate 400.
      const includable = Object.keys(relationships).filter((name) => {
        const relationship = relationships[name];
        return isRecord(relationship) && "data" in relationship;
      });
      if (includable.length >= 2)
        out.push({ key: "include", values: [includable[0]!, includable[1]!] });
    }
    return out;
  });

/**
 * The profile suite, in report order.
 *
 * @internal
 */
export const rules: ReadonlyArray<RuleImpl> = [
  advertisesProfile,
  rejections,
  spellingEquivalence,
  advertisesIdempotencyProfile,
  jsonApiMember,
  repeatedKeySpelling,
];
