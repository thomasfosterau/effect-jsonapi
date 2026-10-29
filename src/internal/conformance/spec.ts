/**
 * The JSON:API v1.1 rules: content negotiation, document structure, error
 * objects, query parameters, status codes and — from `./atomic.ts` — the
 * atomic operations extension.
 *
 * Each rule is one normative sentence with its section and a probe that decides
 * it. Rules that would change the target's state are gated behind
 * `mutating: true` and report `Skipped` otherwise, and act on resources they
 * create themselves from the caller's `writes` fixture (`./write.ts`) — never
 * on a sample id, and never on an id the create response names that the kit
 * evidently did not create; rules whose shape this api has no endpoint for
 * report `Skipped` naming what was missing. Nothing here silently passes.
 *
 * @since 0.15.0
 * @internal
 */
import {
  Array as Arr,
  Effect,
  Match,
  Option,
  Predicate,
  Record as Rec,
  Result,
  Schema,
} from "effect";
import { declaresName } from "../declaredQuery.js";
import * as Linkage from "../linkage.js";
import { MEDIA_TYPE } from "../media.js";
import { counted, listed } from "./crawl.js";
import {
  relatedDereferences,
  relatedMatchesLinkage,
  relationshipSelfDereferences,
  relationshipSelfMatchesLinkage,
  resourceSelfDereferences,
  topLevelSelfDereferences,
  topLevelSelfMatchesDocument,
} from "./links.js";
import { linksEnumerateCollection } from "./pagination.js";
import { atomicRules } from "./atomic.js";
import { atomicClientIdRules, clientIdRules } from "./clientIds.js";
import { relationshipRules } from "./relationships.js";
import {
  type Context,
  describe,
  type Discovered,
  errorObjectsOf,
  finding,
  type Finding,
  HOP_CAP,
  documentOf,
  firstResourceOf,
  identity,
  isJsonArray,
  isJsonObject,
  isRecord,
  eachSuccessfulRead,
  jsonApiAccept,
  coverageNote,
  noProbeReason,
  objectIn,
  type Body,
  type Observation,
  parseMediaType,
  probeable,
  resourceLabel,
  resourceObjectsOf,
  resourcesOf,
  type Role,
  type Rule,
  type RuleImpl,
  settle,
  skip,
  sourceParametersOf,
  statusOf,
  succeeded,
  topLevel,
  withQuery,
  type Outcome,
  type Payload,
} from "./core.js";
import {
  type Accepted,
  asSent,
  Created,
  buildUpdate,
  decided,
  idempotencyHeaders,
  onAccepted,
  overTargets,
  ownId,
  pathFor,
  primaryIdentity,
  primaryResource,
  readBack,
  readEndpointFor,
  refusedForMissingKey,
  refusedOnKeyGrounds,
  sendUpdate,
  type WriteTarget as Target,
  targets,
  undecided,
  type Verdict,
  viaCreateEndpoint,
  withCreated,
} from "./write.js";

const SPEC = "https://jsonapi.org/format/1.1";

const rule = (
  id: string,
  section: string,
  anchor: string,
  level: Rule["level"],
  requirement: string,
): Rule => ({
  id,
  tier: "spec",
  section,
  reference: `${SPEC}/#${anchor}`,
  level,
  requirement,
});

/** The roles of every endpoint whose successful response is a JSON:API document. */
const READ_ROLES: ReadonlyArray<Role> = ["collection", "resource", "related", "relationship"];

/**
 * The roles of an endpoint that may respond with a resource collection — a
 * list, or a related endpoint, which does when its relationship is to-many.
 */
const COLLECTION_ROLES: ReadonlyArray<Role> = ["collection", "related"];

/** Every endpoint whose successful response is a JSON:API document. */
const readable = (ctx: Context) => probeable(ctx, READ_ROLES);

// ---------------------------------------------------------------------------
// Content negotiation
// ---------------------------------------------------------------------------

const responseMediaType: RuleImpl = {
  rule: rule(
    "spec/content-negotiation/response-media-type",
    "Content Negotiation",
    "content-negotiation-servers",
    "MUST",
    "Servers MUST send all JSON:API data in response documents with the header `Content-Type: application/vnd.api+json` without any media type parameters other than `ext` and `profile`.",
  ),
  run: (ctx) =>
    Effect.gen(function* () {
      const { resolved, unresolved } = readable(ctx);
      if (Arr.isReadonlyArrayEmpty(resolved))
        return skip(responseMediaType.rule, noProbeReason("JSON:API read endpoint", unresolved));
      const findings: Array<Finding> = [];
      yield* eachSuccessfulRead(ctx, resolved, (path, observation) => {
        if (observation.text === "") return;
        const header = observation.contentType;
        if (header === undefined) {
          findings.push(
            finding(responseMediaType.rule, {
              detail: `${path} answered a JSON:API document with no Content-Type`,
              expected: MEDIA_TYPE,
              observed: describe(observation),
              probe: observation.probe,
            }),
          );
          return;
        }
        const { base, parameters } = parseMediaType(header);
        if (base !== MEDIA_TYPE) {
          findings.push(
            finding(responseMediaType.rule, {
              detail: `${path} answered with a non-JSON:API media type`,
              expected: MEDIA_TYPE,
              observed: describe(observation),
              probe: observation.probe,
            }),
          );
          return;
        }
        const illegal = parameters.filter(([name]) => name !== "ext" && name !== "profile");
        if (Arr.isReadonlyArrayNonEmpty(illegal)) {
          findings.push(
            finding(responseMediaType.rule, {
              detail: `${path} answered with the media type parameter(s) ${illegal.map(([n]) => n).join(", ")}`,
              expected: `${MEDIA_TYPE} with only \`ext\` / \`profile\` parameters`,
              observed: describe(observation),
              probe: observation.probe,
            }),
          );
        }
      });
      return settle(responseMediaType.rule, resolved.length, findings, coverageNote(unresolved));
    }),
};

const contentTypeParameters: RuleImpl = {
  rule: rule(
    "spec/content-negotiation/request-content-type-parameters",
    "Content Negotiation",
    "content-negotiation-servers",
    "MUST",
    "Servers MUST respond with a 415 Unsupported Media Type status code if a request specifies the header `Content-Type: application/vnd.api+json` with any media type parameters other than `ext` or `profile`.",
  ),
  run: (ctx) =>
    Effect.gen(function* () {
      const roles = ["create", "update", "relationshipWrite"] as const;
      const { resolved, unresolved } = probeable(ctx, roles);
      // The create endpoint first: of the three it is the one whose URL names
      // no existing resource, so even a server that ignores the media type has
      // nothing of the caller's to change. Then an update, whose `{}` body
      // names no member to change, before a relationship write, whose URL is
      // a relationship of the caller's `ids` sample.
      const target = Arr.head(
        Arr.flatMap(roles, (role) =>
          Arr.filter(resolved, ({ endpoint }) => endpoint.role === role),
        ),
      ).pipe(Option.getOrUndefined);
      if (target === undefined) {
        return skip(contentTypeParameters.rule, noProbeReason("write endpoint", unresolved));
      }
      const findings: Array<Finding> = [];
      const observation = yield* ctx.request({
        method: target.endpoint.method,
        url: target.path,
        headers: { accept: MEDIA_TYPE, "content-type": `${MEDIA_TYPE};charset=utf-8` },
        // A body no endpoint can apply: the rule decides on the media type
        // alone, and this probe runs without `mutating: true`, so a server that
        // reads the body before the Content-Type must find nothing to write.
        body: {},
      });
      if (observation.status !== 415) {
        findings.push(
          finding(contentTypeParameters.rule, {
            detail: `a \`charset\` parameter on the request Content-Type was not rejected at ${target.endpoint.method} ${target.path}`,
            expected: "415 Unsupported Media Type",
            observed: describe(observation),
            probe: observation.probe,
          }),
        );
      }
      return settle(contentTypeParameters.rule, 1, findings);
    }),
};

const acceptParameters: RuleImpl = {
  rule: rule(
    "spec/content-negotiation/accept-parameters",
    "Content Negotiation",
    "content-negotiation-servers",
    "MUST",
    "Servers MUST respond with a 406 Not Acceptable status code if a request's `Accept` header contains the JSON:API media type and all instances of that media type are modified with media type parameters other than `ext` or `profile`.",
  ),
  run: (ctx) =>
    Effect.gen(function* () {
      const target = readable(ctx).resolved[0];
      if (target === undefined)
        return skip(acceptParameters.rule, noProbeReason("JSON:API read endpoint", []));
      const observation = yield* ctx.request({
        url: target.path,
        headers: { accept: `${MEDIA_TYPE};charset=utf-8` },
      });
      const findings =
        observation.status === 406
          ? []
          : [
              finding(acceptParameters.rule, {
                detail:
                  "an `Accept` whose only JSON:API instance carries a `charset` parameter was not rejected",
                expected: "406 Not Acceptable",
                observed: describe(observation),
                probe: observation.probe,
              }),
            ];
      return settle(acceptParameters.rule, 1, findings);
    }),
};

const acceptWeight: RuleImpl = {
  rule: rule(
    "spec/content-negotiation/accept-weight-is-not-a-parameter",
    "Content Negotiation (with RFC 9110 §12.4.2)",
    "content-negotiation-servers",
    "MUST NOT",
    "A `q` weight is an Accept-header parameter, not a media type parameter (RFC 9110 §12.4.2), so a JSON:API media type instance carrying only a non-zero `q` MUST NOT be counted as parameterised and MUST NOT be rejected with 406.",
  ),
  run: (ctx) =>
    Effect.gen(function* () {
      const target = readable(ctx).resolved[0];
      if (target === undefined)
        return skip(acceptWeight.rule, noProbeReason("JSON:API read endpoint", []));
      const accepts: ReadonlyArray<readonly [string, string]> = [
        [`${MEDIA_TYPE};q=0.9`, "a weight on the JSON:API instance"],
        [`${MEDIA_TYPE}; q=1`, "a weight with surrounding whitespace"],
        [`text/html;q=0.9, ${MEDIA_TYPE};q=0.8`, "a weighted preference between HTML and JSON:API"],
        [
          `${MEDIA_TYPE};profile="https://example.com/p";q=0.8`,
          "a media type parameter followed by a weight",
        ],
      ];
      const findings: Array<Finding> = [];
      yield* Effect.forEach(
        accepts,
        ([accept, description]) =>
          Effect.gen(function* () {
            const observation = yield* ctx.request({ url: target.path, headers: { accept } });
            if (observation.status === 406) {
              findings.push(
                finding(acceptWeight.rule, {
                  detail: `${description} was treated as a disallowed media type parameter`,
                  expected: "any status but 406 — the weight is not a media type parameter",
                  observed: describe(observation),
                  probe: observation.probe,
                }),
              );
            }
          }),
        { concurrency: 1, discard: true },
      );
      return settle(acceptWeight.rule, accepts.length, findings);
    }),
};

const acceptWeightZero: RuleImpl = {
  rule: rule(
    "spec/content-negotiation/accept-weight-zero-refuses",
    "Content Negotiation (with RFC 9110 §12.4.2)",
    "content-negotiation-servers",
    "MUST",
    "`q=0` on the only JSON:API instance in `Accept` is an explicit refusal of that representation (RFC 9110 §12.4.2), so a server that can only answer JSON:API MUST respond 406.",
  ),
  run: (ctx) =>
    Effect.gen(function* () {
      const target = readable(ctx).resolved[0];
      if (target === undefined)
        return skip(acceptWeightZero.rule, noProbeReason("JSON:API read endpoint", []));
      const observation = yield* ctx.request({
        url: target.path,
        headers: { accept: `${MEDIA_TYPE};q=0` },
      });
      const findings =
        observation.status === 406
          ? []
          : [
              finding(acceptWeightZero.rule, {
                detail: "`q=0` on the only JSON:API instance was not treated as a refusal",
                expected: "406 Not Acceptable",
                observed: describe(observation),
                probe: observation.probe,
              }),
            ];
      return settle(acceptWeightZero.rule, 1, findings);
    }),
};

const unknownProfileIgnored: RuleImpl = {
  rule: rule(
    "spec/content-negotiation/unknown-profile-ignored",
    "Profiles",
    "profiles",
    "MUST",
    "A server MUST ignore `profile` parameters naming profiles it does not support, rather than rejecting the request.",
  ),
  run: (ctx) =>
    Effect.gen(function* () {
      const target = readable(ctx).resolved[0];
      if (target === undefined)
        return skip(unknownProfileIgnored.rule, noProbeReason("JSON:API read endpoint", []));
      const observation = yield* ctx.request({
        url: target.path,
        headers: { accept: `${MEDIA_TYPE};profile="https://example.com/unrecognised-profile"` },
      });
      const findings =
        observation.status === 406 || observation.status === 415
          ? [
              finding(unknownProfileIgnored.rule, {
                detail: "an unrecognised `profile` in `Accept` was rejected instead of ignored",
                expected: "the profile ignored — any status but 406 / 415",
                observed: describe(observation),
                probe: observation.probe,
              }),
            ]
          : [];
      return settle(unknownProfileIgnored.rule, 1, findings);
    }),
};

const unsupportedExtension: RuleImpl = {
  rule: rule(
    "spec/content-negotiation/unsupported-extension",
    "Extensions",
    "extensions",
    "MUST",
    "A server MUST respond with 406 Not Acceptable when every JSON:API instance in `Accept` names an `ext` extension URI it does not support.",
  ),
  run: (ctx) =>
    Effect.gen(function* () {
      const target = readable(ctx).resolved[0];
      if (target === undefined)
        return skip(unsupportedExtension.rule, noProbeReason("JSON:API read endpoint", []));
      const observation = yield* ctx.request({
        url: target.path,
        headers: { accept: `${MEDIA_TYPE};ext="https://example.com/unsupported-extension"` },
      });
      const findings =
        observation.status === 406
          ? []
          : [
              finding(unsupportedExtension.rule, {
                detail: "an unsupported `ext` URI in `Accept` was not rejected",
                expected: "406 Not Acceptable",
                observed: describe(observation),
                probe: observation.probe,
              }),
            ];
      return settle(unsupportedExtension.rule, 1, findings);
    }),
};

// ---------------------------------------------------------------------------
// Document structure
// ---------------------------------------------------------------------------

/**
 * The relationship names a resource object carries inline linkage for — the
 * ones `?include=` can actually bring in. A paginated relationship is links-only
 * and including it is a legitimate 400, so guessing would turn a compound-document
 * probe into a spurious finding.
 */
const includableOf = (body: Body): ReadonlyArray<string> =>
  Option.match(firstResourceOf(body), {
    onNone: () => [],
    onSome: (first) => {
      const relationships = first["relationships"];
      if (!isJsonObject(relationships)) return [];
      return Object.keys(relationships).filter((name) => {
        const relationship = relationships[name];
        return isJsonObject(relationship) && "data" in relationship;
      });
    },
  });

/**
 * The include path a relationship endpoint's compound probe asks for: its
 * relationship's name, the last segment of its path (JSON:API 1.1: `GET
 * /articles/1/relationships/comments?include=comments`). Its primary data is
 * resource linkage, which carries no relationships to learn a path from.
 */
const relationshipIncludable = (path: string): ReadonlyArray<string> =>
  Arr.fromNullishOr(/\/relationships\/([^/:][^/]*)$/.exec(path)?.[1]);

/**
 * The include paths an endpoint's compound probe asks for: its own
 * relationship on a relationship endpoint ({@link relationshipIncludable}),
 * else the relationships with inline linkage its bare response shows
 * ({@link includableOf}).
 */
const compoundIncludable = (
  endpoint: { readonly role: string; readonly path: string },
  bare: Observation,
): ReadonlyArray<string> =>
  endpoint.role === "relationship"
    ? relationshipIncludable(endpoint.path)
    : includableOf(bare.body);

/**
 * Every document the api will hand the kit for its read endpoints: a bare probe
 * per endpoint, plus a compound probe wherever `include` is declared and a
 * relationship with inline linkage can be learned from the bare response — or,
 * on a relationship endpoint, the relationship itself.
 *
 * The compound probe is what gives the full-linkage and duplicate-resource rules
 * something to be true *about*; without it they would pass over documents that
 * never carry `included`, which is a pass that proves nothing.
 */
const documentProbes = (ctx: Context) =>
  Effect.gen(function* () {
    const out: Array<{ readonly where: string; readonly observation: Observation }> = [];
    yield* Effect.forEach(
      readable(ctx).resolved,
      ({ endpoint, path }) =>
        Effect.gen(function* () {
          const bare = yield* ctx.request({ url: path, headers: jsonApiAccept });
          out.push({ where: path, observation: bare });
          if (!endpoint.queryKeys.includes("include")) return;
          const includable = compoundIncludable(endpoint, bare);
          if (Arr.isReadonlyArrayEmpty(includable)) return;
          const url = withQuery(path, [["include", includable.join(",")]]);
          const compound = yield* ctx.request({ url, headers: jsonApiAccept });
          if (compound.status >= 200 && compound.status < 300)
            out.push({ where: url, observation: compound });
        }),
      { concurrency: 1, discard: true },
    );
    return out;
  });

/**
 * Runs one document-level predicate over every document the api returns.
 *
 * `applicable` is what keeps a conditional rule honest: a rule about compound
 * documents that never saw one reports `Skipped` with `inapplicable`, not a
 * pass. Vacuous passes are the failure mode a conformance kit exists to avoid.
 */
const overDocuments =
  (
    impl: Rule,
    options: {
      readonly applicable?: ((body: Schema.Json) => boolean) | undefined;
      readonly inapplicable?: string | undefined;
      readonly check: (
        body: Schema.Json,
        observation: Observation,
        where: string,
      ) => ReadonlyArray<Finding>;
    },
  ): RuleImpl["run"] =>
  (ctx) =>
    Effect.gen(function* () {
      const { resolved, unresolved } = readable(ctx);
      if (Arr.isReadonlyArrayEmpty(resolved))
        return skip(impl, noProbeReason("JSON:API read endpoint", unresolved));
      const documents = yield* documentProbes(ctx);
      const note = coverageNote(unresolved);
      const findings: Array<Finding> = [];
      let evaluated = 0;
      for (const { observation, where } of documents) {
        if (Option.isNone(observation.body)) continue;
        const body = observation.body.value;
        if (options.applicable !== undefined && !options.applicable(body)) continue;
        evaluated += 1;
        findings.push(...options.check(body, observation, where));
      }
      if (evaluated === 0) {
        return skip(
          impl,
          options.inapplicable ?? "no endpoint returned a document this rule applies to",
        );
      }
      return settle(impl, evaluated, findings, note);
    });

const topLevelMembers: RuleImpl = {
  rule: rule(
    "spec/document/top-level-members",
    "Document Structure",
    "document-top-level",
    "MUST",
    "A JSON:API document MUST contain at least one of the top-level members `data`, `errors` or `meta`.",
  ),
  run: (ctx) =>
    overDocuments(topLevelMembers.rule, {
      check: (body, observation, where) => {
        if (!isRecord(body)) {
          return [
            finding(topLevelMembers.rule, {
              detail: `${where} answered a body that is not a JSON object`,
              expected: "a JSON:API document object",
              observed: describe(observation),
              probe: observation.probe,
            }),
          ];
        }
        const has = ["data", "errors", "meta"].filter((member) => member in body);
        return Arr.isReadonlyArrayNonEmpty(has)
          ? []
          : [
              finding(topLevelMembers.rule, {
                detail: `${where} answered a document with none of \`data\`, \`errors\`, \`meta\``,
                expected: "at least one of `data`, `errors`, `meta`",
                observed: `top-level members: ${Object.keys(body).join(", ") || "(none)"}`,
                probe: observation.probe,
              }),
            ];
      },
    })(ctx),
};

const dataAndErrorsExclusive: RuleImpl = {
  rule: rule(
    "spec/document/data-and-errors-exclusive",
    "Document Structure",
    "document-top-level",
    "MUST NOT",
    "The members `data` and `errors` MUST NOT coexist in the same document.",
  ),
  run: (ctx) =>
    overDocuments(dataAndErrorsExclusive.rule, {
      check: (body, observation, where) => {
        if (!isRecord(body)) return [];
        return "data" in body && "errors" in body
          ? [
              finding(dataAndErrorsExclusive.rule, {
                detail: `${where} answered a document carrying both \`data\` and \`errors\``,
                expected: "one of `data` / `errors`, never both",
                observed: `top-level members: ${Object.keys(body).join(", ")}`,
                probe: observation.probe,
              }),
            ]
          : [];
      },
    })(ctx),
};

const includedRequiresData: RuleImpl = {
  rule: rule(
    "spec/document/included-requires-data",
    "Document Structure",
    "document-top-level",
    "MUST NOT",
    "If a document does not contain a top-level `data` key, the `included` member MUST NOT be present.",
  ),
  run: (ctx) =>
    overDocuments(includedRequiresData.rule, {
      check: (body, observation, where) => {
        if (!isRecord(body)) return [];
        return "included" in body && !("data" in body)
          ? [
              finding(includedRequiresData.rule, {
                detail: `${where} answered \`included\` with no top-level \`data\``,
                expected: "`included` only alongside `data`",
                observed: `top-level members: ${Object.keys(body).join(", ")}`,
                probe: observation.probe,
              }),
            ]
          : [];
      },
    })(ctx),
};

const fullLinkage: RuleImpl = {
  rule: rule(
    "spec/document/full-linkage",
    "Compound Documents",
    "document-compound-documents",
    "MUST NOT",
    "A compound document MUST NOT include resources that cannot be linked to the primary data: every resource in `included` must be identified by a resource identifier object reachable from the primary data or from another included resource — unless relationship fields that would otherwise contain that linkage are excluded by the request's sparse fieldsets.",
  ),
  run: (ctx) =>
    overDocuments(fullLinkage.rule, {
      applicable: (body) =>
        isRecord(body) &&
        Array.isArray(body["included"]) &&
        Arr.isReadonlyArrayNonEmpty(body["included"]),
      inapplicable:
        "no endpoint returned a compound document — either none declares `include`, or no resource it returned carries inline relationship linkage to include",
      check: (body, observation, where) => {
        // The request's `fields[TYPE]` carry the spec's one exemption (#494).
        const fields = Linkage.requestedFieldsets(new URLSearchParams(where.split("?")[1] ?? ""));
        const orphans = isJsonObject(body) ? Linkage.unlinkedIncluded(body, fields) : [];
        return Arr.isReadonlyArrayEmpty(orphans)
          ? []
          : [
              finding(fullLinkage.rule, {
                detail: `${where} answered ${orphans.length} included resource(s) unreachable from the primary data`,
                expected: "every `included` resource reachable through resource linkage",
                observed: orphans.map(resourceLabel).join(", "),
                probe: observation.probe,
              }),
            ];
      },
    })(ctx),
};

const noDuplicateResources: RuleImpl = {
  rule: rule(
    "spec/document/no-duplicate-resources",
    "Compound Documents",
    "document-compound-documents",
    "MUST NOT",
    "A compound document MUST NOT include more than one resource object for each `type` and `id` pair.",
  ),
  run: (ctx) =>
    overDocuments(noDuplicateResources.rule, {
      applicable: (body) => resourceObjectsOf(Option.some(body)).length > 1,
      inapplicable: "no endpoint returned a document carrying more than one resource object",
      check: (body, observation, where) => {
        const resources = resourceObjectsOf(Option.some(body));
        const seen = new Map<string, string>();
        const duplicates: Array<string> = [];
        for (const { pointer, resource } of resources) {
          const key = identity(resource);
          if (key === undefined) continue;
          const first = seen.get(key);
          if (first === undefined) seen.set(key, pointer);
          else duplicates.push(`${resourceLabel(resource)} at ${first} and ${pointer}`);
        }
        return Arr.isReadonlyArrayEmpty(duplicates)
          ? []
          : [
              finding(noDuplicateResources.rule, {
                detail: `${where} answered the same (type, id) more than once`,
                expected: "one resource object per (type, id)",
                observed: duplicates.join("; "),
                probe: observation.probe,
              }),
            ];
      },
    })(ctx),
};

/** Whether a probe's URL supplies `include`, whatever its value — presence is the signal. */
const suppliesInclude = (url: string): boolean =>
  new URLSearchParams(url.split("?")[1] ?? "").has("include");

/**
 * The documents the api answered to a request carrying `include`: the compound
 * probes `documentProbes` sends, plus a bare `?include=` to every endpoint that
 * declares `include`. The bare one asks for no related resources at all, so
 * it is the probe whose `included` must be the empty array, where a compound
 * probe's has members anyway.
 */
const includedOnInclude: RuleImpl = {
  rule: rule(
    "spec/document/included-on-include",
    "Inclusion of Related Resources",
    "fetching-includes",
    "MUST",
    "If an endpoint supports the `include` parameter and a client supplies it, the server's response MUST be a compound document with an `included` key — even if that `included` key holds an empty array.",
  ),
  run: (ctx) =>
    Effect.gen(function* () {
      const { resolved, unresolved } = readable(ctx);
      const including = Arr.filter(resolved, ({ endpoint }) =>
        endpoint.queryKeys.includes("include"),
      );
      if (Arr.isReadonlyArrayEmpty(including))
        return skip(
          includedOnInclude.rule,
          noProbeReason("read endpoint declaring `include`", unresolved),
        );
      const compound = Arr.filter(yield* documentProbes(ctx), ({ where }) =>
        suppliesInclude(where),
      );
      const empty = yield* Effect.forEach(
        Arr.filter(including, ({ path }) => !suppliesInclude(path)),
        ({ path }) => {
          const url = withQuery(path, [["include", ""]]);
          return Effect.map(ctx.request({ url, headers: jsonApiAccept }), (observation) => ({
            where: url,
            observation,
          }));
        },
        { concurrency: 1 },
      );
      const answered = Arr.filter([...compound, ...empty], ({ observation }) =>
        succeeded(observation),
      );
      const findings = Arr.flatMap(answered, ({ observation, where }) => {
        const document = documentOf(observation.body);
        if (Option.exists(document, (body) => isJsonArray(body["included"]))) return [];
        return [
          finding(includedOnInclude.rule, {
            detail: `${where} answered a request carrying \`include\` with no top-level \`included\` array`,
            expected: "a top-level `included` array, `[]` when nothing is included",
            observed: Option.match(document, {
              onNone: () => describe(observation),
              onSome: (body) =>
                `top-level members: ${Rec.keys({ ...body }).join(", ") || "(none)"}`,
            }),
            probe: observation.probe,
          }),
        ];
      });
      return Arr.match(answered, {
        onEmpty: () =>
          skip(
            includedOnInclude.rule,
            "no endpoint declaring `include` answered a request carrying it with a 2xx",
          ),
        onNonEmpty: (documents) =>
          settle(includedOnInclude.rule, documents.length, findings, coverageNote(unresolved)),
      });
    }),
};

const resourceIdentification: RuleImpl = {
  rule: rule(
    "spec/document/resource-identification",
    "Resource Objects",
    "document-resource-objects",
    "MUST",
    "Every resource object MUST contain `id` and `type` members, except when the resource object originates at the client and represents a new resource; the values of both MUST be strings.",
  ),
  run: (ctx) =>
    overDocuments(resourceIdentification.rule, {
      applicable: (body) => Arr.isReadonlyArrayNonEmpty(resourcesOf(Option.some(body))),
      inapplicable: "no endpoint returned a document carrying a resource object",
      check: (body, observation, where) => {
        const findings: Array<Finding> = [];
        for (const { pointer, resource } of resourcesOf(Option.some(body))) {
          const type = resource["type"];
          if (typeof type !== "string" || type === "") {
            findings.push(
              finding(resourceIdentification.rule, {
                detail: `${where} answered a resource object at ${pointer} with no string \`type\``,
                expected: "`type` present and a non-empty string",
                observed: `type: ${JSON.stringify(type)}`,
                probe: observation.probe,
              }),
            );
          }
          const id = resource["id"];
          if (typeof id !== "string" || id === "") {
            findings.push(
              finding(resourceIdentification.rule, {
                detail: `${where} answered a resource object at ${pointer} with no string \`id\``,
                expected: "`id` present and a non-empty string",
                observed: `id: ${JSON.stringify(id)}`,
                probe: observation.probe,
              }),
            );
          }
        }
        return findings;
      },
    })(ctx),
};

const jsonApiObject: RuleImpl = {
  rule: rule(
    "spec/document/jsonapi-object",
    "Document Structure",
    "document-jsonapi-object",
    "MUST",
    "If present, the top-level `jsonapi` member MUST be an object; its `version` member, if present, MUST be a string, and its `ext` / `profile` members, if present, MUST be arrays of strings.",
  ),
  run: (ctx) =>
    overDocuments(jsonApiObject.rule, {
      applicable: (body) => isRecord(body) && "jsonapi" in body,
      inapplicable: "no endpoint returned a document carrying a `jsonapi` member",
      check: (body, observation, where) => {
        if (!isRecord(body) || !("jsonapi" in body)) return [];
        const value = body["jsonapi"];
        if (!isRecord(value)) {
          return [
            finding(jsonApiObject.rule, {
              detail: `${where} answered a non-object \`jsonapi\` member`,
              expected: "a jsonapi object",
              observed: JSON.stringify(value),
              probe: observation.probe,
            }),
          ];
        }
        const findings: Array<Finding> = [];
        if ("version" in value && typeof value["version"] !== "string") {
          findings.push(
            finding(jsonApiObject.rule, {
              detail: `${where} answered a non-string \`jsonapi.version\``,
              expected: "a string",
              observed: JSON.stringify(value["version"]),
              probe: observation.probe,
            }),
          );
        }
        for (const member of ["ext", "profile"] as const) {
          if (!(member in value)) continue;
          const list = value[member];
          if (!Array.isArray(list) || list.some((uri) => typeof uri !== "string")) {
            findings.push(
              finding(jsonApiObject.rule, {
                detail: `${where} answered a \`jsonapi.${member}\` that is not an array of strings`,
                expected: "an array of URI strings",
                observed: JSON.stringify(list),
                probe: observation.probe,
              }),
            );
          }
        }
        return findings;
      },
    })(ctx),
};

// ---------------------------------------------------------------------------
// Error objects
// ---------------------------------------------------------------------------

/**
 * Collects the error responses the kit can provoke without mutating anything: a
 * 404 for an absent id, a 400 for an unknown query parameter, a 406 and a 415.
 */
const errorProbes = (ctx: Context) =>
  Effect.gen(function* () {
    const read = readable(ctx).resolved;
    const out: Array<Observation> = [];
    const resource = ctx.endpoints.find((endpoint) => endpoint.role === "resource");
    if (resource !== undefined && resource.segment !== undefined) {
      const path = resource.path.replace(
        `:${resource.params[0]}`,
        encodeURIComponent(ctx.options.absentId),
      );
      out.push(yield* ctx.request({ url: path, headers: jsonApiAccept }));
    }
    const first = read[0];
    if (first !== undefined) {
      out.push(
        yield* ctx.request({
          url: withQuery(first.path, [["unknown", "1"]]),
          headers: jsonApiAccept,
        }),
      );
      out.push(
        yield* ctx.request({ url: first.path, headers: { accept: `${MEDIA_TYPE};charset=utf-8` } }),
      );
    }
    return out.filter((observation) => observation.status >= 400);
  });

const errorDocumentStructure: RuleImpl = {
  rule: rule(
    "spec/errors/error-document-shape",
    "Errors",
    "errors",
    "MUST",
    "Error objects MUST be returned as an array keyed by `errors` in the top level of a JSON:API document.",
  ),
  run: (ctx) =>
    Effect.gen(function* () {
      const observations = yield* errorProbes(ctx);
      if (Arr.isReadonlyArrayEmpty(observations)) {
        return skip(
          errorDocumentStructure.rule,
          "no error response could be provoked without mutating the target",
        );
      }
      const findings: Array<Finding> = [];
      for (const observation of observations) {
        if (observation.status === 404 && observation.text === "") continue;
        const errors = topLevel(observation.body, "errors");
        if (
          !Option.exists(errors, (list) => isJsonArray(list) && Arr.isReadonlyArrayNonEmpty(list))
        ) {
          findings.push(
            finding(errorDocumentStructure.rule, {
              detail: `a ${observation.status} response was not a JSON:API error document`,
              expected: "`{ errors: [ … ] }` with at least one error object",
              observed: describe(observation),
              probe: observation.probe,
            }),
          );
        }
      }
      return settle(errorDocumentStructure.rule, observations.length, findings);
    }),
};

const errorMemberTypes: RuleImpl = {
  rule: rule(
    "spec/errors/error-member-types",
    "Error Objects",
    "error-objects",
    "MUST",
    "An error object's `id`, `status`, `code`, `title` and `detail` members MUST be strings, and `links`, `source` and `meta` MUST be objects.",
  ),
  run: (ctx) =>
    Effect.gen(function* () {
      const observations = yield* errorProbes(ctx);
      const errors = observations.flatMap((observation) =>
        errorObjectsOf(observation.body).map((error) => ({ error, observation })),
      );
      if (Arr.isReadonlyArrayEmpty(errors))
        return skip(errorMemberTypes.rule, "no error object could be provoked");
      const findings: Array<Finding> = [];
      for (const { error, observation } of errors) {
        for (const member of ["id", "status", "code", "title", "detail"] as const) {
          if (member in error && typeof error[member] !== "string") {
            findings.push(
              finding(errorMemberTypes.rule, {
                detail: `a ${observation.status} error object's \`${member}\` is not a string`,
                expected: "a string",
                observed: JSON.stringify(error[member]),
                probe: observation.probe,
              }),
            );
          }
        }
        for (const member of ["links", "source", "meta"] as const) {
          if (member in error && !isRecord(error[member])) {
            findings.push(
              finding(errorMemberTypes.rule, {
                detail: `a ${observation.status} error object's \`${member}\` is not an object`,
                expected: "an object",
                observed: JSON.stringify(error[member]),
                probe: observation.probe,
              }),
            );
          }
        }
      }
      return settle(errorMemberTypes.rule, errors.length, findings);
    }),
};

const errorSourceDiscrimination: RuleImpl = {
  rule: rule(
    "spec/errors/error-source-discrimination",
    "Error Objects",
    "error-objects",
    "MUST",
    "An error object's `source` member MUST contain only `pointer` (a JSON Pointer to the associated entity in the request document), `parameter` (a URI query parameter name) or `header` (a request header name).",
  ),
  run: (ctx) =>
    Effect.gen(function* () {
      const observations = yield* errorProbes(ctx);
      const sources = observations.flatMap((observation) =>
        errorObjectsOf(observation.body)
          .map((error) => error["source"])
          .filter(isJsonObject)
          .map((source) => ({ source, observation })),
      );
      if (Arr.isReadonlyArrayEmpty(sources)) {
        return skip(
          errorSourceDiscrimination.rule,
          "no provoked error object carried a `source` member",
        );
      }
      const findings: Array<Finding> = [];
      for (const { observation, source } of sources) {
        for (const key of Object.keys(source)) {
          if (key !== "pointer" && key !== "parameter" && key !== "header") {
            findings.push(
              finding(errorSourceDiscrimination.rule, {
                detail: `a ${observation.status} error object's \`source\` carries the member \`${key}\``,
                expected: "only `pointer`, `parameter` or `header`",
                observed: JSON.stringify(source),
                probe: observation.probe,
              }),
            );
            continue;
          }
          const value = source[key];
          if (typeof value !== "string") {
            findings.push(
              finding(errorSourceDiscrimination.rule, {
                detail: `a ${observation.status} error object's \`source.${key}\` is not a string`,
                expected: "a string",
                observed: JSON.stringify(value),
                probe: observation.probe,
              }),
            );
            continue;
          }
          if (key === "pointer" && value !== "" && !value.startsWith("/")) {
            findings.push(
              finding(errorSourceDiscrimination.rule, {
                detail: `a ${observation.status} error object's \`source.pointer\` is not a JSON Pointer`,
                expected: "the empty string or a value beginning with `/`",
                observed: JSON.stringify(value),
                probe: observation.probe,
              }),
            );
          }
        }
      }
      return settle(errorSourceDiscrimination.rule, sources.length, findings);
    }),
};

const errorStatusMatches: RuleImpl = {
  rule: rule(
    "spec/errors/error-status-matches-response",
    "Error Objects",
    "error-objects",
    "SHOULD",
    "An error object's `status` is the HTTP status code applicable to the problem, so in a single-error document it SHOULD equal the response's status code.",
  ),
  run: (ctx) =>
    Effect.gen(function* () {
      const observations = (yield* errorProbes(ctx)).filter(
        (observation) => errorObjectsOf(observation.body).length === 1,
      );
      if (Arr.isReadonlyArrayEmpty(observations))
        return skip(errorStatusMatches.rule, "no single-error document could be provoked");
      const findings: Array<Finding> = [];
      for (const observation of observations) {
        const error = errorObjectsOf(observation.body)[0]!;
        const status = error["status"];
        if (typeof status === "string" && status !== String(observation.status)) {
          findings.push(
            finding(errorStatusMatches.rule, {
              detail: "a single-error document's `status` disagrees with the response status",
              expected: `"${observation.status}"`,
              observed: JSON.stringify(status),
              probe: observation.probe,
            }),
          );
        }
      }
      return settle(errorStatusMatches.rule, observations.length, findings);
    }),
};

// ---------------------------------------------------------------------------
// Query parameters
// ---------------------------------------------------------------------------

const fieldsOf = (queryKeys: ReadonlyArray<string>): ReadonlyArray<string> =>
  queryKeys
    .filter((key) => key.startsWith("fields[") && key.endsWith("]"))
    .map((key) => key.slice("fields[".length, -1));

type Slot = "primary" | "included";

/** Whether the resource object at `pointer` sits in the document slot `where`. */
const inSlot = (pointer: string, where: Slot): boolean =>
  pointer.startsWith("/included") === (where === "included");

/**
 * The field names a resource object carries: its `attributes` keys, then its
 * `relationships` keys — the two are its "fields" together (§Resource Object
 * Fields, #494).
 */
const fieldNamesOf = (resource: Readonly<Record<string, unknown>>): ReadonlyArray<string> => {
  const attributes = resource["attributes"];
  const relationships = resource["relationships"];
  return [
    ...(isRecord(attributes) ? Object.keys(attributes) : []),
    ...(isRecord(relationships) ? Object.keys(relationships) : []),
  ];
};

/**
 * The field names of the first resource of each type in slot `where`: only
 * types that actually appear in the slot under test can decide a projection
 * rule; anything else would be a pass over an empty set.
 */
const fieldsByType = (body: Body, where: Slot): Map<string, ReadonlyArray<string>> => {
  const byType = new Map<string, ReadonlyArray<string>>();
  for (const { pointer, resource } of resourcesOf(body)) {
    if (!inSlot(pointer, where)) continue;
    const type = resource["type"];
    if (typeof type === "string" && !byType.has(type)) byType.set(type, fieldNamesOf(resource));
  }
  return byType;
};

// What a sparse-fieldset rule's probes of one endpoint add up to.
interface Tally {
  readonly findings: Array<Finding>;
  probes: number;
  evaluated: number;
}

/**
 * Runs a sparse-fieldset rule's `probe` over every read endpoint declaring
 * `fields[TYPE]`, one at a time, and settles the rule on what they tally:
 * skipped when no endpoint declares one, or when no probe evaluated anything
 * (`inapplicable` says why).
 */
const overFieldsetEndpoints = (
  ctx: Context,
  impl: Rule,
  inapplicable: string,
  probe: (
    target: ReturnType<typeof readable>["resolved"][number],
    tally: Tally,
  ) => Effect.Effect<void, never, never>,
) =>
  Effect.gen(function* () {
    const candidates = readable(ctx).resolved.filter(({ endpoint }) =>
      Arr.isReadonlyArrayNonEmpty(fieldsOf(endpoint.queryKeys)),
    );
    if (Arr.isReadonlyArrayEmpty(candidates))
      return skip(impl, "no endpoint declares `fields[TYPE]`");
    const tally: Tally = { findings: [], probes: 0, evaluated: 0 };
    yield* Effect.forEach(candidates, (target) => probe(target, tally), {
      concurrency: 1,
      discard: true,
    });
    if (tally.evaluated === 0) return skip(impl, inapplicable);
    return settle(impl, tally.probes, tally.findings);
  });

const sparseFieldsets = (where: Slot): RuleImpl => {
  const impl = rule(
    `spec/query/sparse-fieldsets-${where}`,
    "Sparse Fieldsets",
    "fetching-sparse-fieldsets",
    "MUST NOT",
    `If a client requests a restricted set of fields for a given resource type with \`fields[TYPE]\`, an endpoint MUST NOT include additional fields in resource objects of that type in its response${
      where === "included" ? " — including resource objects in `included`" : ""
    }.`,
  );
  return {
    rule: impl,
    run: (ctx) =>
      overFieldsetEndpoints(
        ctx,
        impl,
        where === "included"
          ? "no endpoint returned an `included` resource, of a type it declares `fields[TYPE]` for, carrying two or more fields to project"
          : "no endpoint returned a primary resource, of a type it declares `fields[TYPE]` for, carrying two or more fields to project",
        ({ endpoint, path }, tally) =>
          Effect.gen(function* () {
            // Learn the field names (attributes, then relationships, #494) this
            // endpoint actually emits, then ask for exactly the first one: a
            // projection rule needs a field set the server is known to be able
            // to return. The `included` variant needs a compound document, so
            // the baseline is taken with `include` on — on a relationship
            // endpoint, its own relationship (#485).
            const baseline = yield* ctx.request({ url: path, headers: jsonApiAccept });
            tally.probes += 1;
            let source = baseline;
            let base = path;
            if (where === "included") {
              if (!endpoint.queryKeys.includes("include")) return;
              const includable = compoundIncludable(endpoint, baseline);
              if (Arr.isReadonlyArrayEmpty(includable)) return;
              base = withQuery(path, [["include", includable.join(",")]]);
              source = yield* ctx.request({ url: base, headers: jsonApiAccept });
              tally.probes += 1;
              if (source.status < 200 || source.status >= 300) return;
            }
            const byType = fieldsByType(source.body, where);
            yield* Effect.forEach(
              fieldsOf(endpoint.queryKeys),
              (type) =>
                Effect.gen(function* () {
                  const fields = byType.get(type);
                  if (fields === undefined || fields.length < 2) return;
                  const requested = fields[0]!;
                  const url = withQuery(base, [[`fields[${type}]`, requested]]);
                  const observation = yield* ctx.request({ url, headers: jsonApiAccept });
                  tally.probes += 1;
                  if (observation.status < 200 || observation.status >= 300) return;
                  const subjects = resourcesOf(observation.body).filter(
                    ({ pointer, resource }) => inSlot(pointer, where) && resource["type"] === type,
                  );
                  // A projection request that returned no resource of that type in
                  // that slot proves nothing either way.
                  if (Arr.isReadonlyArrayEmpty(subjects)) return;
                  tally.evaluated += 1;
                  for (const { pointer, resource } of subjects) {
                    const extra = fieldNamesOf(resource).filter((key) => key !== requested);
                    if (Arr.isReadonlyArrayNonEmpty(extra)) {
                      tally.findings.push(
                        finding(impl, {
                          detail: `\`fields[${type}]=${requested}\` still returned other fields at ${pointer}`,
                          expected: `only \`${requested}\` among \`attributes\` and \`relationships\``,
                          observed: `also returned: ${extra.join(", ")}`,
                          probe: observation.probe,
                        }),
                      );
                    }
                  }
                }),
              { concurrency: 1, discard: true },
            );
          }),
      ),
  };
};

// §Sparse Fieldsets: "An empty value indicates that no fields should be
// returned" — `?fields[TYPE]=` is not the absent parameter, whose fields the
// server may choose (#488). Judged on `attributes` and `relationships`, as the
// two rules above are (#494): a resource object of that type in the answer
// carries neither.
const sparseFieldsetsEmpty: RuleImpl = {
  rule: rule(
    "spec/query/sparse-fieldsets-empty",
    "Sparse Fieldsets",
    "fetching-sparse-fieldsets",
    "MUST NOT",
    "An empty `fields[TYPE]` value indicates that no fields should be returned, so an endpoint MUST NOT include attributes or relationships in resource objects of that type in its response.",
  ),
  run: (ctx) =>
    overFieldsetEndpoints(
      ctx,
      sparseFieldsetsEmpty.rule,
      "no endpoint returned a resource, of a type it declares `fields[TYPE]` for, carrying a field to project away",
      ({ endpoint, path }, tally) =>
        Effect.gen(function* () {
          // Only a type the baseline answered with a field can show an empty
          // set honoured or ignored.
          const baseline = yield* ctx.request({ url: path, headers: jsonApiAccept });
          tally.probes += 1;
          const types = new Set(
            resourcesOf(baseline.body).flatMap(({ resource }) => {
              const type = resource["type"];
              return typeof type === "string" && Arr.isReadonlyArrayNonEmpty(fieldNamesOf(resource))
                ? [type]
                : [];
            }),
          );
          yield* Effect.forEach(
            fieldsOf(endpoint.queryKeys).filter((type) => types.has(type)),
            (type) =>
              Effect.gen(function* () {
                const observation = yield* ctx.request({
                  url: withQuery(path, [[`fields[${type}]`, ""]]),
                  headers: jsonApiAccept,
                });
                tally.probes += 1;
                if (observation.status < 200 || observation.status >= 300) return;
                const subjects = resourcesOf(observation.body).filter(
                  ({ resource }) => resource["type"] === type,
                );
                if (Arr.isReadonlyArrayEmpty(subjects)) return;
                tally.evaluated += 1;
                for (const { pointer, resource } of subjects) {
                  const names = fieldNamesOf(resource);
                  if (Arr.isReadonlyArrayNonEmpty(names)) {
                    tally.findings.push(
                      finding(sparseFieldsetsEmpty.rule, {
                        detail: `\`fields[${type}]=\` (no fields) still returned fields at ${pointer}`,
                        expected: "no `attributes` or `relationships` members",
                        observed: `returned: ${names.join(", ")}`,
                        probe: observation.probe,
                      }),
                    );
                  }
                }
              }),
            { concurrency: 1, discard: true },
          );
        }),
    ),
};

const unsupportedInclude: RuleImpl = {
  rule: rule(
    "spec/query/unsupported-include-path",
    "Inclusion of Related Resources",
    "fetching-includes",
    "MUST",
    "If a server is unable to identify a relationship path, or does not support inclusion of resources from a path, it MUST respond with 400 Bad Request.",
  ),
  run: (ctx) =>
    Effect.gen(function* () {
      const target = readable(ctx).resolved.find(({ endpoint }) =>
        endpoint.queryKeys.includes("include"),
      );
      if (target === undefined)
        return skip(unsupportedInclude.rule, "no endpoint declares `include`");
      const url = withQuery(target.path, [["include", "notARelationshipPath"]]);
      const observation = yield* ctx.request({ url, headers: jsonApiAccept });
      const findings =
        observation.status === 400
          ? []
          : [
              finding(unsupportedInclude.rule, {
                detail: "an unidentifiable relationship path in `include` was not rejected",
                expected: "400 Bad Request",
                observed: describe(observation),
                probe: observation.probe,
              }),
            ];
      return settle(unsupportedInclude.rule, 1, findings);
    }),
};

const unsupportedSort: RuleImpl = {
  rule: rule(
    "spec/query/unsupported-sort-field",
    "Sorting",
    "fetching-sorting",
    "MUST",
    "If the server does not support sorting as specified in the query parameter `sort`, it MUST respond with 400 Bad Request.",
  ),
  run: (ctx) =>
    Effect.gen(function* () {
      const target = readable(ctx).resolved.find(({ endpoint }) =>
        endpoint.queryKeys.includes("sort"),
      );
      if (target === undefined) return skip(unsupportedSort.rule, "no endpoint declares `sort`");
      const url = withQuery(target.path, [["sort", "notASortableField"]]);
      const observation = yield* ctx.request({ url, headers: jsonApiAccept });
      const findings =
        observation.status === 400
          ? []
          : [
              finding(unsupportedSort.rule, {
                detail: "an unsupported `sort` field was not rejected",
                expected: "400 Bad Request",
                observed: describe(observation),
                probe: observation.probe,
              }),
            ];
      return settle(unsupportedSort.rule, 1, findings);
    }),
};

// ---------------------------------------------------------------------------
// A query parameter the endpoint does not declare
//
// Each rule here sends one parameter an endpoint's discovered query does not
// declare, and holds it to the 400 that refuses it. The endpoints probed, and
// the parameter, are read off the api description: an endpoint whose query
// names discovery cannot enumerate is never probed, nor is a name the endpoint
// declares (`declaresName`, the check `Middleware` runs), so the kit never
// probes a parameter the middleware would let through to the endpoint.
// ---------------------------------------------------------------------------

/** Every name an endpoint's query declares: its keys and its open family prefixes. */
const declaredOf = (endpoint: Discovered): ReadonlyArray<string> => [
  ...endpoint.queryKeys,
  ...endpoint.queryPrefixes,
];

/** A parameter's family base name: everything before its first `[`. */
const baseNameOf = (name: string): string => {
  const bracket = name.indexOf("[");
  return bracket === -1 ? name : name.slice(0, bracket);
};

/** `true` when an endpoint declares any parameter of `family`, bare, bracketed or open. */
const declaresFamily = (endpoint: Discovered, family: string): boolean =>
  declaredOf(endpoint).some((name) => baseNameOf(name) === family);

/**
 * The endpoints of `roles` whose discovered query makes them `candidate`s —
 * typically, the ones that do not declare a family, and so must refuse it —
 * split as `probeable` splits them, and the paths of the ones whose query
 * names discovery cannot enumerate. What one of those declares is unknown
 * (`Middleware` stands aside for it), so none of them is probed.
 */
const candidatesOf = (
  ctx: Context,
  roles: ReadonlyArray<Role>,
  candidate: (endpoint: Discovered) => boolean,
) => ({
  ...probeable(
    {
      ...ctx,
      endpoints: ctx.endpoints.filter(
        (endpoint) => endpoint.queryEnumerable && candidate(endpoint),
      ),
    },
    roles,
  ),
  opaque: ctx.endpoints
    .filter(({ role, queryEnumerable }) => roles.includes(role) && !queryEnumerable)
    .map(({ path }) => path),
});

/** `true` when `probeable` found no endpoint at all, resolvable or not. */
const noEndpoint = (found: ReturnType<typeof probeable>): boolean =>
  Arr.isReadonlyArrayEmpty(found.resolved) && Arr.isReadonlyArrayEmpty(found.unresolved);

/**
 * The skip reason when no endpoint is a candidate because every one makes
 * `claim` true, or has a query whose names cannot be enumerated.
 */
const everyEndpoint = (claim: string, opaque: ReadonlyArray<string>): string =>
  Arr.isReadonlyArrayEmpty(opaque)
    ? `every ${claim}`
    : `every ${claim} or has a query whose parameter names cannot be enumerated (${opaque.join(", ")})`;

/** The skip reason when `candidatesOf` found no endpoint: each declares `family`, or cannot say. */
const everyDeclares = (what: string, family: string, opaque: ReadonlyArray<string>): string =>
  everyEndpoint(`${what} declares \`${family}\``, opaque);

/**
 * The skip reason when no endpoint is a candidate because none makes `claim`
 * true, naming the ones whose query names cannot be enumerated.
 */
const noEndpointWhere = (claim: string, opaque: ReadonlyArray<string>): string =>
  Arr.isReadonlyArrayEmpty(opaque)
    ? `no ${claim}`
    : `no ${claim}, and ${opaque.join(", ")} cannot say: ${opaque.length === 1 ? "its query's" : "their queries'"} parameter names cannot be enumerated`;

/** The attribute names the first resource object of a collection carries. */
const attributeNamesOf = (data: Schema.JsonArray): ReadonlyArray<string> =>
  Option.match(Arr.findFirst(data, isJsonObject), {
    onNone: () => [],
    onSome: (first) => Rec.keys(objectIn(first["attributes"])),
  });

/** The attribute names the first primary resource object of a response carries. */
const primaryAttributeNamesOf = (observation: Observation): ReadonlyArray<string> => {
  const data = Option.getOrNull(topLevel(observation.body, "data"));
  return attributeNamesOf(isJsonArray(data) ? data : [data]);
};

/**
 * `true` when `name` goes into a probe's parameter name as itself: a value a
 * server put in a document (a type, an attribute name) that `withQuery`,
 * which leaves keys unencoded, would otherwise send as something else.
 */
const keySafe = (name: string): boolean => name !== "" && encodeURIComponent(name) === name;

/**
 * Settles a rule on the answer to `?<parameter>=…` sent to an endpoint that
 * does not declare `parameter`. Only a 400 is the refusal; a 400 whose
 * `source.parameter` names other parameters but not this one refused something
 * else. JSON:API makes `source` a SHOULD, so a 400 naming no parameter at all
 * still passes — with a note saying the status alone decided it.
 */
const settleRefusal = (
  impl: Rule,
  probes: number,
  refusal: {
    readonly parameter: string;
    readonly where: string;
    readonly observation: Observation;
    /** What makes the parameter one to refuse, as the finding names it. */
    readonly why: string;
  },
): Outcome => {
  const { parameter, where, observation } = refusal;
  const sent = sentQuery(observation);
  if (observation.status !== 400) {
    return settle(impl, probes, [
      finding(impl, {
        detail: `${sent} on ${where}, ${refusal.why}, was not rejected`,
        expected: "400 Bad Request",
        observed: describe(observation),
        probe: observation.probe,
      }),
    ]);
  }
  return Arr.match(sourceParametersOf(observation), {
    onEmpty: () =>
      settle(
        impl,
        probes,
        [],
        Arr.isReadonlyArrayEmpty(errorObjectsOf(observation.body))
          ? `the 400 for ${sent} carried no JSON:API error objects, so its status alone decided this rule`
          : `the 400 for ${sent} named no \`source.parameter\` (optional in JSON:API), so its status alone decided this rule`,
      ),
    onNonEmpty: (parameters) =>
      settle(
        impl,
        probes,
        parameters.includes(parameter)
          ? []
          : [
              finding(impl, {
                detail: `the 400 for ${sent} on ${where} does not name \`${parameter}\` in \`source.parameter\`, so it refused something else`,
                expected: `source: { parameter: "${parameter}" }`,
                observed: `source.parameter: ${parameters.map((name) => `\`${name}\``).join(", ")}`,
                probe: observation.probe,
              }),
            ],
      ),
  });
};

/** A probe's query string, quoted as a finding or a note names it. */
const sentQuery = (observation: Observation): string =>
  `\`${observation.probe.url.slice(observation.probe.url.indexOf("?"))}\``;

/**
 * The most requests a refusal rule sends, the redirects it follows included:
 * a baseline per endpoint it tries, and the one probe. An api with more
 * candidates than that whose baselines are unusable skips the rule rather
 * than sending a request per endpoint it has.
 */
const REFUSAL_BUDGET = 20;

/** What `probeFirstUsable` sends, where, and what it reads off each baseline. */
interface UsableProbe {
  readonly targets: ReadonlyArray<{ readonly endpoint: Discovered; readonly path: string }>;
  /** The parameter and value to send, or why the endpoint is passed over. */
  readonly queryFrom: (
    baseline: Observation,
    endpoint: Discovered,
  ) => Result.Result<readonly [parameter: string, value: string], string>;
  /** The skip reason's head when every target is passed over. */
  readonly none: string;
  /** What makes `parameter` one to refuse, as a finding names it. */
  readonly why: (parameter: string) => string;
}

/**
 * `true` when a probe's answer says nothing of whether the server refuses the
 * parameter, and every refusal rule is left not decided on it: no response (a
 * lost one, or one the run's `requestTimeout` cut short), a rate limit (`429`)
 * or a request timeout (`408`). A server error is not one: a server that
 * answers 5xx to a parameter it does not support mishandled it, and the rule
 * fails (#352). The link and pagination rules draw the line elsewhere:
 * `crawl.ts`'s `unanswered` counts a server error among the answers that say
 * nothing of the links.
 */
const saysNothingOfRefusal = (observation: Observation): boolean =>
  observation.transportError !== undefined ||
  observation.status === 408 ||
  observation.status === 429;

/**
 * Probes `?<parameter>=<value>` on the first of `targets` whose baseline
 * response `queryFrom` accepts, and settles the rule on the answer. Every
 * target passed over is named in the skip reason, with why, when none was
 * usable; a rule {@link REFUSAL_BUDGET} cannot finish is skipped, never
 * passed.
 */
const probeFirstUsable = (
  ctx: Context,
  impl: Rule,
  probe: UsableProbe,
  passedOver: ReadonlyArray<string> = [],
  spent = 0,
): Effect.Effect<Outcome> =>
  Arr.matchLeft(probe.targets, {
    onEmpty: () => Effect.succeed(skip(impl, `${probe.none} (${passedOver.join("; ")})`)),
    onNonEmpty: ({ endpoint, path }, rest) =>
      // A baseline and its probe both need a request.
      REFUSAL_BUDGET - spent < 2
        ? Effect.succeed(
            skip(
              impl,
              `the rule's budget of ${REFUSAL_BUDGET} requests ran out with ${counted(rest.length + 1, "endpoint")} left untried (${passedOver.join("; ")})`,
            ),
          )
        : Effect.gen(function* () {
            const baseline = yield* ctx.request({
              url: path,
              headers: jsonApiAccept,
              requests: REFUSAL_BUDGET - spent - 1,
            });
            const afterBaseline = spent + 1 + baseline.redirects.length;
            const query = probe.queryFrom(baseline, endpoint);
            if (Result.isFailure(query)) {
              return yield* probeFirstUsable(
                ctx,
                impl,
                { ...probe, targets: rest },
                [...passedOver, `${path}: ${query.failure}`],
                afterBaseline,
              );
            }
            const observation = yield* ctx.request({
              url: withQuery(path, [query.success]),
              headers: jsonApiAccept,
              requests: REFUSAL_BUDGET - afterBaseline,
            });
            if (saysNothingOfRefusal(observation)) {
              return skip(
                impl,
                // A redirect the kit did not follow is no lost response: it is
                // named, and `runRule` says why it decides nothing.
                `not decided: ${sentQuery(observation)} on ${path} answered ${statusOf(observation)}${Option.isSome(observation.unfollowed) ? "" : ", and a rate limit, a request timeout or a lost response says nothing of whether the server refuses the parameter"}`,
              );
            }
            return settleRefusal(impl, passedOver.length + 2, {
              parameter: query.success[0],
              where: path,
              observation,
              why: probe.why(query.success[0]),
            });
          }),
  });

/** What a refusal rule probes, and how it explains having nothing to probe. */
interface Refusal {
  readonly rule: Rule;
  readonly roles: ReadonlyArray<Role>;
  /** What an endpoint of `roles` is, for the skip reason when the api has none. */
  readonly kind: string;
  /** Whether an endpoint, by the names its query declares, is one to probe. */
  readonly candidate: (endpoint: Discovered) => boolean;
  /** The skip reason when no endpoint of `roles` is a candidate. */
  readonly noCandidate: (opaque: ReadonlyArray<string>) => string;
  /** What a candidate is, for the skip reason when none has a resolvable URL. */
  readonly what: string;
  readonly queryFrom: UsableProbe["queryFrom"];
  readonly none: string;
}

/** Why a refusal rule's parameter is one to refuse: the endpoint does not declare it. */
const undeclared = (parameter: string): string => `which does not declare \`${parameter}\``;

/** A rule that sends a candidate endpoint a parameter it does not declare, and expects 400. */
const refusalRule = (refusal: Refusal): RuleImpl => ({
  rule: refusal.rule,
  run: (ctx) => {
    const impl = refusal.rule;
    if (noEndpoint(probeable(ctx, refusal.roles)))
      return Effect.succeed(skip(impl, noProbeReason(refusal.kind, [])));
    const candidates = candidatesOf(ctx, refusal.roles, refusal.candidate);
    if (noEndpoint(candidates))
      return Effect.succeed(skip(impl, refusal.noCandidate(candidates.opaque)));
    if (Arr.isReadonlyArrayEmpty(candidates.resolved))
      return Effect.succeed(skip(impl, noProbeReason(refusal.what, candidates.unresolved)));
    return probeFirstUsable(ctx, impl, {
      targets: candidates.resolved,
      queryFrom: refusal.queryFrom,
      none: refusal.none,
      why: undeclared,
    });
  },
});

/** `[parameter, value]` once the baseline succeeded; its status otherwise. */
const onSucceeded =
  (
    query: (
      baseline: Observation,
      endpoint: Discovered,
    ) => Result.Result<readonly [parameter: string, value: string], string>,
  ): UsableProbe["queryFrom"] =>
  (baseline, endpoint) =>
    succeeded(baseline) ? query(baseline, endpoint) : Result.fail(statusOf(baseline));

/**
 * A rule that sends a read endpoint one query parameter, `name=1`, whose name
 * alone requires a 400 whatever the endpoint declares. It probes as a refusal
 * rule does — a baseline first, the 400's `source.parameter` matched, a 429,
 * 408 or lost response left not decided (#438) — but over every read
 * endpoint, not only those whose query discovery can enumerate: no endpoint
 * can declare a name the specification forbids, so what it declares does not
 * pick the endpoint.
 */
const parameterNameRefused = (decides: Rule, name: string, why: string): RuleImpl => ({
  rule: decides,
  run: (ctx) => {
    const { resolved, unresolved } = readable(ctx);
    if (Arr.isReadonlyArrayEmpty(resolved))
      return Effect.succeed(skip(decides, noProbeReason("JSON:API read endpoint", unresolved)));
    return probeFirstUsable(ctx, decides, {
      targets: resolved,
      queryFrom: onSucceeded(() => Result.succeed([name, "1"])),
      none: "no JSON:API read endpoint answered its baseline request with 2xx",
      why: () => why,
    });
  },
});

const unknownQueryParameter: RuleImpl = parameterNameRefused(
  rule(
    "spec/query/unknown-query-parameter",
    "Query Parameters",
    "query-parameters-custom",
    "MUST",
    "Implementation-specific query parameters MUST contain at least one non a-z character, so a server MUST respond with 400 Bad Request to a query parameter named only with a-z that it does not recognise from the specification.",
  ),
  "unknown",
  "a name with no non a-z character that the specification does not define",
);

const includeUnsupportedEndpoint: RuleImpl = refusalRule({
  rule: rule(
    "spec/query/include-unsupported-endpoint",
    "Inclusion of Related Resources",
    "fetching-includes",
    "MUST",
    "If an endpoint does not support the `include` parameter, it MUST respond with 400 Bad Request to any requests that include it.",
  ),
  roles: READ_ROLES,
  kind: "JSON:API read endpoint",
  candidate: (endpoint) => !endpoint.queryKeys.includes("include"),
  noCandidate: (opaque) => everyDeclares("read endpoint", "include", opaque),
  what: "read endpoint without `include`",
  // A failed baseline would fail the probe for its own reason, not for
  // `include`. A relationship the resource carries inline linkage for is the
  // one an endpoint that did process `include` would visibly honour, so a
  // server that ignores the parameter is caught answering 200 with `included`.
  queryFrom: onSucceeded((baseline) =>
    Result.succeed([
      "include",
      Option.getOrElse(Arr.head(includableOf(baseline.body)), () => "notARelationshipPath"),
    ]),
  ),
  none: "no read endpoint without `include` answered its baseline request with 2xx",
});

const sortUnsupportedEndpoint: RuleImpl = refusalRule({
  rule: rule(
    "spec/query/sort-unsupported-endpoint",
    "Sorting",
    "fetching-sorting",
    "MUST",
    "If the server does not support sorting as specified in the query parameter `sort`, it MUST return 400 Bad Request; this applies to any endpoint that responds with a resource collection as primary data.",
  ),
  roles: COLLECTION_ROLES,
  kind: "list or related endpoint",
  candidate: (endpoint) => !endpoint.queryKeys.includes("sort"),
  noCandidate: (opaque) => everyDeclares("list and related endpoint", "sort", opaque),
  what: "list or related endpoint without `sort`",
  // Only an endpoint answering a resource collection as primary data is one
  // §Sorting covers; a to-one related endpoint answers a single resource, and
  // is passed over for the next candidate.
  queryFrom: (baseline) => {
    if (!succeeded(baseline)) return Result.fail(statusOf(baseline));
    const data = Option.getOrNull(topLevel(baseline.body, "data"));
    return isJsonArray(data)
      ? Result.succeed([
          "sort",
          Option.getOrElse(Arr.head(attributeNamesOf(data)), () => "notASortableField"),
        ])
      : Result.fail(`${baseline.status}, not a resource collection`);
  },
  none: "no list or related endpoint without `sort` answered with a resource collection as primary data",
});

/**
 * JSON:API 1.1 §Implementation-Specific Query Parameters, the rule every
 * parameter of a family the specification defines falls back on.
 */
const GENERAL_RULE =
  "If a server encounters a query parameter that does not follow the naming conventions above, or the server does not know how to process it as a query parameter from this specification, it MUST return 400 Bad Request.";

/** A rule that rests on {@link GENERAL_RULE}: a parameter the endpoint does not process. */
const generalRule = (id: string, applied: string): Rule =>
  rule(id, "Query Parameters", "query-parameters-custom", "MUST", `${GENERAL_RULE} ${applied}`);

// `!` is no member-name character, so the name follows none of the
// conventions; it is not `_`, the cache-buster a server may admit (#263).
const illegalParameterName: RuleImpl = parameterNameRefused(
  generalRule(
    "spec/query/illegal-parameter-name",
    "A base name that is not a legal member name, such as `foo!`, does not follow the naming conventions.",
  ),
  "foo!",
  "a base name that is not a legal member name",
);

// A legal extension base name (§Extension-Specific Query Parameters: an
// alphanumeric namespace, a colon, a-z), so only the extension is unknown.
const unsupportedExtensionParameter: RuleImpl = parameterNameRefused(
  generalRule(
    "spec/query/unsupported-extension-parameter",
    "A parameter of an extension the server does not support (`ns:param`, its namespace and a colon) is not one it knows how to process.",
  ),
  "unsupported:param",
  "a parameter of an extension the server does not support",
);

/**
 * The types of the resource objects a baseline shows, primary data first,
 * each paired with the attribute names of the first resource of it, keeping
 * only a type that goes into a parameter name as itself.
 */
const typesShown = (
  baseline: Observation,
): ReadonlyArray<{ readonly type: string; readonly attributes: ReadonlyArray<string> }> =>
  Arr.dedupeWith(
    Arr.filterMap(resourcesOf(baseline.body), ({ resource }) => {
      const type = resource["type"];
      return Predicate.isString(type) && keySafe(type)
        ? Result.succeed({ type, attributes: attributeNamesOf([resource]) })
        : Result.failVoid;
    }),
    (first, second) => first.type === second.type,
  );

const fieldsUnsupportedEndpoint: RuleImpl = refusalRule({
  rule: generalRule(
    "spec/query/fields-unsupported-endpoint",
    "An endpoint that does not declare `fields[TYPE]` for a type does not know how to process it; ignoring it would also break §Sparse Fieldsets, under which an endpoint MUST NOT include additional fields in resource objects of that type.",
  ),
  roles: READ_ROLES,
  kind: "JSON:API read endpoint",
  // A sparse fieldset is per type, so any endpoint may lack the one for a type
  // it shows — every one but an endpoint with an open `fields[` record.
  candidate: (endpoint) => !endpoint.queryPrefixes.includes("fields["),
  noCandidate: (opaque) =>
    everyEndpoint("read endpoint declares an open `fields[…]` record", opaque),
  what: "read endpoint",
  // The type is one the baseline shows, so an endpoint that did process
  // `fields[TYPE]` would visibly project it; never one the endpoint declares.
  queryFrom: onSucceeded((baseline, endpoint) => {
    const shown = typesShown(baseline);
    const declared = declaredOf(endpoint);
    return Option.match(
      Arr.findFirst(shown, ({ type }) => !declaresName(declared, `fields[${type}]`)),
      {
        onNone: () =>
          Result.fail(
            Arr.isReadonlyArrayEmpty(shown)
              ? `${baseline.status}, showing no resource object to name a type for`
              : `declares \`fields[TYPE]\` for every type its baseline shows (${shown.map(({ type }) => type).join(", ")})`,
          ),
        onSome: ({ type, attributes }) =>
          Result.succeed([
            `fields[${type}]`,
            Option.getOrElse(Arr.findFirst(attributes, keySafe), () => "notAField"),
          ]),
      },
    );
  }),
  none: "no read endpoint answered its baseline request with 2xx showing a type it does not declare `fields[TYPE]` for",
});

const pageUnsupportedEndpoint: RuleImpl = refusalRule({
  rule: generalRule(
    "spec/query/page-unsupported-endpoint",
    "An endpoint that declares no `page` parameter does not paginate, so it does not know how to process one.",
  ),
  roles: READ_ROLES,
  kind: "JSON:API read endpoint",
  candidate: (endpoint) => !declaresFamily(endpoint, "page"),
  noCandidate: (opaque) => everyEndpoint("read endpoint declares a `page` parameter", opaque),
  what: "read endpoint without `page`",
  queryFrom: onSucceeded(() => Result.succeed(["page[limit]", "1"])),
  none: "no read endpoint without `page` answered its baseline request with 2xx",
});

const filterUnsupportedEndpoint: RuleImpl = refusalRule({
  rule: generalRule(
    "spec/query/filter-unsupported-endpoint",
    "An endpoint that declares no `filter` parameter does not filter, so it does not know how to process one.",
  ),
  roles: READ_ROLES,
  kind: "JSON:API read endpoint",
  candidate: (endpoint) => !declaresFamily(endpoint, "filter"),
  noCandidate: (opaque) => everyEndpoint("read endpoint declares a `filter` parameter", opaque),
  what: "read endpoint without `filter`",
  // An attribute the baseline shows is what a server filtering on whatever it
  // is sent would act on.
  queryFrom: onSucceeded((baseline) =>
    Result.succeed([
      `filter[${Option.getOrElse(Arr.findFirst(primaryAttributeNamesOf(baseline), keySafe), () => "x")}]`,
      "1",
    ]),
  ),
  none: "no read endpoint without `filter` answered its baseline request with 2xx",
});

/**
 * The bracketed members of `family` an endpoint declares by name, when it
 * declares no open record of the family: the ones it supports, and nothing
 * else of the family. Empty for an endpoint with an open `family[` record
 * (`filter: true`'s grammar), which validates every suffix itself.
 */
const declaredMembers = (endpoint: Discovered, family: string): ReadonlyArray<string> =>
  endpoint.queryPrefixes.some((prefix) => baseNameOf(prefix) === family)
    ? []
    : endpoint.queryKeys.filter(
        (name) => baseNameOf(name) === family && name !== family && name.endsWith("]"),
      );

/**
 * A member of the family `member` belongs to that the endpoint does not
 * declare, derived from `member` so it cannot be another member the endpoint
 * does: its last bracketed name with `_x` appended (`page[size]` →
 * `page[size_x]`), again until no declared name admits it. A legal member
 * name, so the parameter is well-formed: only its being undeclared is wrong.
 */
const undeclaredBeside = (member: string, declared: ReadonlyArray<string>): string => {
  const open = member.slice(0, -1);
  // Each declared name blocks at most one spelling, so `tries` bounds the
  // search; a family prefix would block them all, and `declaredMembers`
  // leaves no member for an endpoint that declares one.
  const past = (name: string, tries: number): string =>
    tries > 0 && declaresName(declared, name) ? past(`${name.slice(0, -1)}_x]`, tries - 1) : name;
  return past(`${open}${open.endsWith("[") ? "x" : "_x"}]`, declared.length);
};

/** The undeclared-member rule for `family`: `page` or `filter` (#321). */
const undeclaredMember = (family: "page" | "filter", applied: string): RuleImpl =>
  refusalRule({
    rule: generalRule(`spec/query/${family}-undeclared-member`, applied),
    roles: READ_ROLES,
    kind: "JSON:API read endpoint",
    candidate: (endpoint) => Arr.isReadonlyArrayNonEmpty(declaredMembers(endpoint, family)),
    noCandidate: (opaque) =>
      noEndpointWhere(
        `read endpoint declares \`${family}[…]\` members by name without an open \`${family}[\` record`,
        opaque,
      ),
    what: `read endpoint declaring \`${family}[…]\` members by name`,
    queryFrom: onSucceeded((_, endpoint) =>
      Option.match(Arr.head(declaredMembers(endpoint, family)), {
        onNone: () => Result.fail(`declares no \`${family}[…]\` member by name`),
        onSome: (member) =>
          Result.succeed([undeclaredBeside(member, declaredOf(endpoint)), "1"] as const),
      }),
    ),
    none: `no read endpoint declaring \`${family}[…]\` members by name answered its baseline request with 2xx`,
  });

const pageUndeclaredMember: RuleImpl = undeclaredMember(
  "page",
  "An endpoint that declares its `page` members by name (`page[size]`, `page[number]`) does not know how to process another (`page[size_x]`).",
);

const filterUndeclaredMember: RuleImpl = undeclaredMember(
  "filter",
  "An endpoint that declares its `filter` members by name (`filter[status]`) does not know how to process another (`filter[status_x]`); an open `filter[…]` grammar, which validates every member itself, is not probed.",
);

/** The bracketed-member rule for `family`: `include` or `sort`, which JSON:API defines bare (#329). */
const bracketed = (
  family: "include" | "sort",
  value: (baseline: Observation) => string,
): RuleImpl =>
  refusalRule({
    rule: generalRule(
      `spec/query/${family}-bracketed`,
      `JSON:API defines only the bare \`${family}\` parameter, so an endpoint that supports it does not know how to process a bracketed \`${family}[]\`.`,
    ),
    roles: READ_ROLES,
    kind: "JSON:API read endpoint",
    candidate: (endpoint) =>
      endpoint.queryKeys.includes(family) && !declaresName(declaredOf(endpoint), `${family}[]`),
    noCandidate: (opaque) =>
      noEndpointWhere(
        `read endpoint declares the bare \`${family}\` and not \`${family}[]\``,
        opaque,
      ),
    what: `read endpoint declaring \`${family}\``,
    queryFrom: onSucceeded((baseline) => Result.succeed([`${family}[]`, value(baseline)])),
    none: `no read endpoint declaring \`${family}\` answered its baseline request with 2xx`,
  });

// The value is one the bare parameter would act on, so a server that reads
// `include[]` as `include` is caught answering it.
const includeBracketed: RuleImpl = bracketed("include", (baseline) =>
  Option.getOrElse(Arr.head(includableOf(baseline.body)), () => "notARelationshipPath"),
);

const sortBracketed: RuleImpl = bracketed("sort", (baseline) =>
  Option.getOrElse(
    Arr.findFirst(primaryAttributeNamesOf(baseline), keySafe),
    () => "notASortableField",
  ),
);

// ---------------------------------------------------------------------------
// Status codes
// ---------------------------------------------------------------------------

const resourceNotFound: RuleImpl = {
  rule: rule(
    "spec/status/resource-not-found",
    "Fetching Resources",
    "fetching-resources-responses-404",
    "MUST",
    "A server MUST respond with 404 Not Found when processing a request to fetch a single resource that does not exist.",
  ),
  run: (ctx) =>
    Effect.gen(function* () {
      const endpoint = ctx.endpoints.find((candidate) => candidate.role === "resource");
      if (endpoint === undefined || endpoint.params.length !== 1) {
        return skip(
          resourceNotFound.rule,
          "no single-resource GET endpoint with exactly one path parameter",
        );
      }
      const path = endpoint.path.replace(
        `:${endpoint.params[0]}`,
        encodeURIComponent(ctx.options.absentId),
      );
      const observation = yield* ctx.request({ url: path, headers: jsonApiAccept });
      const findings =
        observation.status === 404
          ? []
          : [
              finding(resourceNotFound.rule, {
                detail: `fetching the absent id "${ctx.options.absentId}" did not produce a 404`,
                expected: "404 Not Found",
                observed: describe(observation),
                probe: observation.probe,
              }),
            ];
      return settle(
        resourceNotFound.rule,
        1,
        findings,
        `probed with the absent id "${ctx.options.absentId}"`,
      );
    }),
};

// ---------------------------------------------------------------------------
// Writes
//
// Every write probe acts on a disposable target it created itself from the
// caller's `writes` fixture — never on a sample id, and never on an id the
// create response names for anything but the resource the kit sent — and
// `./write.ts` disposes of that target however the probe ends.
// ---------------------------------------------------------------------------

/** One create probe per type with a fixture, decided by `decide` on success. */
const overCreates = (
  ctx: Context,
  rule: Rule,
  decide: (target: Target, created: Accepted) => Verdict,
): Effect.Effect<Outcome> =>
  overTargets(ctx, rule, targets(ctx, "create"), "create endpoint", (target) =>
    withCreated(
      ctx,
      rule,
      target,
      viaCreateEndpoint(ctx, target),
      onAccepted(target, (created) => Effect.succeed(decide(target, created))),
    ),
  );

/** A create probe that answered something other than 201 decides no 201 rule. */
const not201 = (target: Target, observation: Observation): Verdict =>
  undecided(
    `creating a "${target.key}" resource answered ${observation.status}, not 201 — see spec/status/create-response-document`,
  );

const createResponseDocument: RuleImpl = {
  creates: true,
  rule: rule(
    "spec/status/create-response-document",
    "Creating Resources",
    "crud-creating-responses-201",
    "MUST",
    "If the requested resource has been created successfully and the server changes the resource in any way (for example, by assigning an id), the server MUST return a 201 Created response and a document that contains the resource as primary data.",
  ),
  run: (ctx) =>
    overCreates(ctx, createResponseDocument.rule, (target, { observation, payload }) => {
      if (observation.status === 202)
        return undecided(
          `creating a "${target.key}" resource answered 202 Accepted — the creation is deferred, so there is no created resource to check`,
        );
      if (observation.status !== 201)
        return decided(1, [
          finding(createResponseDocument.rule, {
            detail: `creating a "${target.key}" resource without a client-generated id — so the server assigned one — did not answer 201`,
            expected: "201 Created",
            observed: describe(observation),
            probe: observation.probe,
          }),
        ]);
      const carried = Option.exists(
        primaryIdentity(observation),
        (named) => named.type === payload.type,
      );
      return decided(
        1,
        carried
          ? []
          : [
              finding(createResponseDocument.rule, {
                detail: `the 201 creating a "${target.key}" resource does not carry it as primary data`,
                expected: `a document whose \`data\` is a "${payload.type}" resource object with a string \`id\``,
                observed: describe(observation),
                probe: observation.probe,
              }),
            ],
      );
    }),
};

/** The response's header names, for an `observed` line. */
const headerNames = (observation: Observation): string =>
  Arr.match(Arr.fromRecord(observation.headers), {
    onEmpty: () => "(none)",
    onNonEmpty: (headers) => headers.map(([name]) => name).join(", "),
  });

const createLocation: RuleImpl = {
  creates: true,
  rule: rule(
    "spec/status/create-location",
    "Creating Resources",
    "crud-creating-responses-201",
    "SHOULD",
    "The 201 Created response to a POST that did not include a client-generated id SHOULD include a `Location` header identifying the location of the newly created resource.",
  ),
  run: (ctx) =>
    overCreates(ctx, createLocation.rule, (target, { observation }) => {
      if (observation.status !== 201) return not201(target, observation);
      const located = Option.exists(
        Option.fromUndefinedOr(observation.headers["location"]),
        (location) => location !== "",
      );
      return decided(
        1,
        located
          ? []
          : [
              finding(createLocation.rule, {
                detail: `the 201 creating a "${target.key}" resource carried no \`Location\` header`,
                expected: "a `Location` header identifying the created resource",
                observed: `${describe(observation)} — headers: ${headerNames(observation)}`,
                probe: observation.probe,
              }),
            ],
      );
    }),
};

/** A link member, spelled as a URL string or as a link object. */
const Link = Schema.Union([Schema.String, Schema.Struct({ href: Schema.String })]);

const decodeSelfLink = Schema.decodeUnknownOption(
  Schema.Struct({ data: Schema.Struct({ links: Schema.Struct({ self: Link }) }) }),
);

/** The URL of the primary resource's `links.self`, whichever way it is spelled. */
const selfLink = (observation: Observation): Option.Option<string> =>
  Option.flatMap(observation.body, decodeSelfLink).pipe(
    Option.map(({ data }) =>
      Predicate.isString(data.links.self) ? data.links.self : data.links.self.href,
    ),
  );

/** A URL resolved against the target's origin, so a relative and an absolute spelling compare equal. */
const absolute = (url: string, base: string): string =>
  Result.try({ try: () => new URL(url, base).href, catch: () => url }).pipe(Result.merge);

const createLocationMatchesSelf: RuleImpl = {
  creates: true,
  rule: rule(
    "spec/status/create-location-matches-self",
    "Creating Resources",
    "crud-creating-responses-201",
    "MUST",
    "If the resource object returned by a 201 Created response contains a `self` key in its `links` member and a `Location` header is provided, the value of the `self` member MUST match the value of the `Location` header.",
  ),
  run: (ctx) =>
    overCreates(ctx, createLocationMatchesSelf.rule, (target, { observation }) => {
      if (observation.status !== 201) return not201(target, observation);
      const location = Option.fromUndefinedOr(observation.headers["location"]);
      const self = selfLink(observation);
      if (Option.isNone(location) || Option.isNone(self))
        return undecided(
          `the 201 creating a "${target.key}" resource carried ${Option.isNone(location) ? "no `Location` header" : "no `data.links.self`"}, so there was nothing to compare`,
        );
      const base = ctx.options.baseUrl;
      return decided(
        1,
        absolute(location.value, base) === absolute(self.value, base)
          ? []
          : [
              finding(createLocationMatchesSelf.rule, {
                detail: `the 201 creating a "${target.key}" resource names two different locations for it`,
                expected: `\`Location\` and \`data.links.self\` the same URL`,
                observed: `Location: ${location.value} · data.links.self: ${self.value}`,
                probe: observation.probe,
              }),
            ],
      );
    }),
};

const updateResponse: RuleImpl = {
  creates: true,
  rule: rule(
    "spec/status/update-response",
    "Updating Resources",
    "crud-updating-responses",
    "MUST",
    "A successful update is answered 202 Accepted when its processing has not completed; 200 OK and a document that contains the updated resource as primary data — or, when the server does not change the targeted resource in ways other than those specified by the request, a document that contains no primary data; or 204 No Content with no response document.",
  ),
  run: (ctx) =>
    overTargets(ctx, updateResponse.rule, targets(ctx, "update"), "update endpoint", (target) =>
      withCreated(
        ctx,
        updateResponse.rule,
        target,
        viaCreateEndpoint(ctx, target),
        onAccepted(target, (created) =>
          Result.match(Result.all({ id: ownId(created), patch: buildUpdate(target) }), {
            onFailure: (reason) => Effect.succeed(undecided(reason)),
            onSuccess: ({ id, patch }) =>
              sendUpdate(ctx, target, created.payload.type, id, patch).pipe(
                Effect.map((observation) =>
                  judgeUpdate(target, created.payload.type, id, observation),
                ),
              ),
          }),
        ),
      ),
    ),
};

const judgeUpdate = (
  target: Target,
  type: string,
  id: string,
  observation: Observation,
): Verdict =>
  observation.status < 200 || observation.status >= 300
    ? undecided(
        `the server did not accept writes["${target.key}"].update on the resource the kit had just created (${describe(observation)})`,
      )
    : decided(2, updateFindings(target, type, id, observation));

/** A finding of `rule` against `observation`, observed as `describe` renders it unless given. */
const against =
  (rule: Rule, observation: Observation) =>
  (detail: string, expected: string, observed = describe(observation)): ReadonlyArray<Finding> => [
    finding(rule, { detail, expected, observed, probe: observation.probe }),
  ];

/**
 * The 2xx answers an update and a delete share: 202 Accepted is always
 * conformant, a 204 must carry no body, a 200 is judged by `on200`, and any
 * other status is `otherwise`.
 */
const judgeWriteSuccess = (
  observation: Observation,
  write: string,
  broken: ReturnType<typeof against>,
  on200: () => ReadonlyArray<Finding>,
  otherwise: () => ReadonlyArray<Finding>,
): ReadonlyArray<Finding> =>
  Match.value(observation.status).pipe(
    Match.when(202, (): ReadonlyArray<Finding> => []),
    Match.when(204, () =>
      observation.text === ""
        ? []
        : broken(`a 204 ${write} response carried a body`, "an empty body"),
    ),
    Match.when(200, on200),
    Match.orElse(otherwise),
  );

/**
 * What is wrong with a 200 update document that carries no primary data, if
 * anything: it must carry a top-level `meta` object, and no `errors`.
 */
const withoutData = (body: Schema.JsonObject): Option.Option<string> => {
  if ("errors" in body)
    return Option.some("carries `errors` — an error document is no answer to a successful update");
  if (!("meta" in body)) return Option.some("carries neither primary data nor a top-level `meta`");
  if (!isJsonObject(body["meta"]))
    return Option.some("carries no primary data and a top-level `meta` that is not an object");
  return Option.none();
};

/** What is wrong with a 2xx answer to an update, if anything. */
const updateFindings = (
  target: Target,
  type: string,
  id: string,
  observation: Observation,
): ReadonlyArray<Finding> => {
  const broken = against(updateResponse.rule, observation);
  return judgeWriteSuccess(
    observation,
    "update",
    broken,
    () => {
      const document = documentOf(observation.body);
      if (Option.isNone(document))
        return broken(
          `the 200 updating ${type}:${id} carried no response document`,
          "a JSON:API document",
        );
      // JSON:API 1.1: a 200 MAY carry no primary data when the server changed
      // nothing beyond the request — a document that is then still a document,
      // so it carries `meta` (one of `data` / `errors` / `meta` is required, and
      // `errors` is no answer to a success); when it carries `data`, that is
      // the resource.
      if (!("data" in document.value))
        return Option.match(withoutData(document.value), {
          onNone: () => [],
          onSome: (problem) =>
            broken(
              `the 200 updating ${type}:${id} ${problem}`,
              "`data` that is the updated resource, or no primary data and a top-level `meta` object",
            ),
        });
      return Option.exists(
        primaryIdentity(observation),
        (named) => named.type === type && named.id === id,
      )
        ? []
        : broken(
            `the 200 updating ${type}:${id} carries primary data that is not the updated resource`,
            `no \`data\`, or \`data\` that is the "${type}" resource "${id}"`,
          );
    },
    () =>
      broken(
        `updating a "${target.key}" resource answered neither 200, 204 nor 202`,
        "200 with a document, 204, or 202",
      ),
  );
};

const deleteResponse: RuleImpl = {
  creates: true,
  rule: rule(
    "spec/status/delete-response",
    "Deleting Resources",
    "crud-deleting-responses",
    "MUST",
    "A server MUST respond to a successful DELETE with 204 No Content and an empty body, 200 OK with only top-level `meta`, or 202 Accepted.",
  ),
  run: (ctx) =>
    overTargets(
      ctx,
      deleteResponse.rule,
      targets(ctx, "delete"),
      "DELETE resource endpoint",
      (target) =>
        withCreated(
          ctx,
          deleteResponse.rule,
          target,
          viaCreateEndpoint(ctx, target),
          onAccepted(target, (created) =>
            Result.match(ownId(created), {
              onFailure: (reason) => Effect.succeed(undecided(reason)),
              onSuccess: (id) =>
                idempotencyHeaders(target.endpoint).pipe(
                  Effect.flatMap((key) =>
                    ctx
                      .request({
                        method: target.endpoint.method,
                        url: pathFor(target.endpoint, id),
                        headers: { ...jsonApiAccept, ...key },
                      })
                      .pipe(
                        // A completed deletion is the disposal; anything else still owes a cleanup.
                        Effect.tap((observation) =>
                          Effect.sync(() => {
                            if (observation.status === 200 || observation.status === 204)
                              created.entry.disposal = "deleted";
                          }),
                        ),
                        Effect.map((observation) =>
                          Option.getOrElse(unkeyedRefusal(target, key, observation), () =>
                            decided(2, judgeDelete(observation)),
                          ),
                        ),
                      ),
                  ),
                ),
            }),
          ),
        ),
    ),
};

/**
 * The refusal of a delete the kit sent no key with, for the missing key (see
 * {@link refusedForMissingKey}), decides nothing: it is no answer to the
 * delete. Any other 4xx from the same endpoint is, and is judged.
 */
const unkeyedRefusal = (
  target: Target,
  key: Readonly<Record<string, string>>,
  observation: Observation,
): Option.Option<Verdict> =>
  refusedForMissingKey(target.endpoint, key, observation)
    ? Option.some(
        undecided(
          `deleting the "${target.key}" resource the kit had just created answered ${observation.status} from ${target.endpoint.path}, which declares \`Idempotency-Key\` without plainly requiring it, so the kit sent no key, and the error names that header as its source (${describe(observation)})`,
        ),
      )
    : Option.none();

/** The top-level members a 200 DELETE may carry: `meta`, and the members every document may. */
const metaOnly = (member: string): boolean =>
  member === "meta" || member === "jsonapi" || member === "links";

const judgeDelete = (observation: Observation): ReadonlyArray<Finding> => {
  const broken = against(deleteResponse.rule, observation);
  return judgeWriteSuccess(
    observation,
    "DELETE",
    broken,
    () => {
      const document = documentOf(observation.body);
      const members = Option.match(document, {
        onNone: () => [],
        onSome: (body) => Arr.map(Arr.fromRecord({ ...body }), ([member]) => member),
      });
      return Option.isSome(document) && Arr.every(members, metaOnly)
        ? []
        : broken(
            "a 200 DELETE response carried members other than `meta`",
            "only top-level `meta`",
            `top-level members: ${Arr.match(members, {
              onEmpty: () => "(none)",
              onNonEmpty: (named) => named.join(", "),
            })}`,
          );
    },
    () =>
      broken(
        "deleting the resource the kit had just created produced neither 204, 200 nor 202",
        "204, 200 with only `meta`, or 202",
      ),
  );
};

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

/**
 * The `type` the conflict probe sends in place of the fixture's: one no
 * realistic api serves, so the create endpoint's collection cannot be made of
 * it.
 */
const UNSERVED_TYPE = "conformance-unserved-type";

/**
 * Sends the fixture's payload under {@link UNSERVED_TYPE} through the
 * target's create endpoint. A server that wrongly accepts it is still vetted
 * against the fixture's own type, so a resource it made of the fixture's
 * payload is the kit's, and is disposed of like any other.
 */
const viaUnservedType = (ctx: Context, target: Target) => {
  const via = viaCreateEndpoint(ctx, target);
  return { ...via, send: (payload: Payload) => via.send({ ...payload, type: UNSERVED_TYPE }) };
};

const createConflictType: RuleImpl = {
  creates: true,
  rule: rule(
    "spec/status/create-conflict-type",
    "Creating Resources",
    "crud-creating-responses-409",
    "MUST",
    "A server MUST return 409 Conflict when processing a POST request in which the resource object's `type` is not among the type(s) that constitute the collection represented by the endpoint.",
  ),
  run: (ctx) =>
    overTargets(ctx, createConflictType.rule, targets(ctx, "create"), "create endpoint", (target) =>
      withCreated(
        ctx,
        createConflictType.rule,
        target,
        viaUnservedType(ctx, target),
        (created): Effect.Effect<Verdict> =>
          Effect.succeed(
            Created.$match(created, {
              Unbuilt: ({ reason }) => undecided(reason),
              Sent: ({ payload, observation }) => judgeConflict(target, payload, observation),
            }),
          ),
      ),
    ),
};

const judgeConflict = (target: Target, payload: Payload, observation: Observation): Verdict => {
  if (observation.status === 0)
    return undecided(
      `the POST to ${target.createPath} with an unserved \`type\` got no answer (${describe(observation)})`,
    );
  if (refusedOnKeyGrounds(target.createEndpoint, observation.probe.headers, observation))
    return undecided(
      `the POST to ${target.createPath} with an unserved \`type\` was refused over \`Idempotency-Key\` (${describe(observation)}), which says nothing of its \`type\``,
    );
  if (observation.status === 409) return decided(1, []);
  return decided(1, [
    finding(createConflictType.rule, {
      detail: `a POST to ${target.createPath} of writes["${target.key}"].create with \`type\` "${UNSERVED_TYPE}" in place of "${payload.type}" — a type that endpoint does not serve — answered ${observation.status}${succeeded(observation) ? ", accepting it" : ""}`,
      expected: "409 Conflict",
      observed: describe(observation),
      probe: observation.probe,
    }),
  ]);
};

// ---------------------------------------------------------------------------
// Reading a write back
// ---------------------------------------------------------------------------

const createReadBack: RuleImpl = {
  creates: true,
  rule: rule(
    "spec/status/create-read-back",
    "Creating Resources",
    "crud-creating-responses-201",
    "MUST",
    "A 201 Created response MUST carry a document that contains the resource as primary data — so the created resource, fetched afterwards, shows the `attributes` and relationship linkage the 201 carried.",
  ),
  run: (ctx) =>
    overTargets(ctx, createReadBack.rule, targets(ctx, "create"), "create endpoint", (target) =>
      withCreated(
        ctx,
        createReadBack.rule,
        target,
        viaCreateEndpoint(ctx, target),
        onAccepted(target, (created) => {
          if (created.observation.status !== 201)
            return Effect.succeed(not201(target, created.observation));
          return Result.match(
            Result.all({
              id: ownId(created),
              get: readEndpointFor(ctx, target),
              answered: Result.fromOption(
                primaryResource(created.observation),
                () => `the 201 creating a "${target.key}" resource carried no resource object`,
              ),
            }),
            {
              onFailure: (reason) => Effect.succeed(undecided(reason)),
              onSuccess: ({ id, get, answered }) =>
                readBack(
                  ctx,
                  createReadBack.rule,
                  1,
                  get,
                  created.payload.type,
                  id,
                  "the 201 creating it answered",
                  answered,
                ),
            },
          );
        }),
      ),
    ),
};

/**
 * What an update answered the resource now is, or why the answer states none
 * to read back against: a 200 carrying the resource states it; a 204, or a 200
 * with no primary data — the server changed nothing beyond the request — states
 * the request's own members.
 */
const updateStated = (
  type: string,
  id: string,
  patch: Omit<Payload, "type">,
  observation: Observation,
): Result.Result<{ readonly what: string; readonly expected: Schema.JsonObject }, string> => {
  const request = {
    what: `the update requested (answered ${observation.status})`,
    expected: asSent(patch),
  };
  if (observation.status === 204) return Result.succeed(request);
  if (observation.status === 202)
    return Result.fail(
      `updating ${type}:${id} answered 202 Accepted — the update is deferred, so there is nothing stored to read back yet`,
    );
  if (observation.status !== 200)
    return Result.fail(
      `the server did not accept the update of ${type}:${id} (${describe(observation)}) — see spec/status/update-response`,
    );
  if (!Option.exists(documentOf(observation.body), (document) => "data" in document))
    return Result.succeed(request);
  return Result.fromOption(
    Option.filter(
      primaryResource(observation),
      (resource) => resource["type"] === type && resource["id"] === id,
    ).pipe(Option.map((expected) => ({ what: "the 200 updating it answered", expected }))),
    () =>
      `the 200 updating ${type}:${id} carries primary data that is not that resource — see spec/status/update-response`,
  );
};

const updateReadBack: RuleImpl = {
  creates: true,
  rule: rule(
    "spec/status/update-read-back",
    "Updating Resources",
    "crud-updating-responses",
    "MUST",
    "A 200 OK to an update MUST carry the updated resource as primary data, and a 204 No Content (or a 200 with no primary data) means the server changed nothing beyond the request — so the resource, fetched afterwards, shows what the 200 carried, or the request's `attributes` and relationship linkage.",
  ),
  run: (ctx) =>
    overTargets(ctx, updateReadBack.rule, targets(ctx, "update"), "update endpoint", (target) =>
      withCreated(
        ctx,
        updateReadBack.rule,
        target,
        viaCreateEndpoint(ctx, target),
        onAccepted(target, (created) =>
          Result.match(
            Result.all({
              id: ownId(created),
              patch: buildUpdate(target),
              get: readEndpointFor(ctx, target),
            }),
            {
              onFailure: (reason) => Effect.succeed(undecided(reason)),
              onSuccess: ({ id, patch, get }) => {
                const type = created.payload.type;
                return sendUpdate(ctx, target, type, id, patch).pipe(
                  Effect.flatMap((observation) =>
                    Result.match(updateStated(type, id, patch, observation), {
                      onFailure: (reason) => Effect.succeed(undecided(reason)),
                      onSuccess: ({ what, expected }) =>
                        readBack(ctx, updateReadBack.rule, 2, get, type, id, what, expected),
                    }),
                  ),
                );
              },
            },
          ),
        ),
      ),
    ),
};
// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

/**
 * What a caller does about the redirects that answered `redirected`, each
 * remedy once: a chain on the base URL's origin past {@link HOP_CAP} is not
 * cured by another `baseUrl`, nor is a transport that followed a redirect
 * itself or a `Location` the server got wrong.
 */
const remedies = (redirected: ReadonlyArray<Observation>): string =>
  Arr.dedupe(
    redirected.map(({ unfollowed }) => {
      const reason = Option.getOrUndefined(unfollowed)?.reason;
      if (reason === "cap") {
        return `shorten the redirect chain to at most ${HOP_CAP} hops, which the kit follows on the base URL's origin`;
      }
      if (reason === "transport") {
        return "hand the kit a client that does not follow redirects itself";
      }
      if (reason === "unparseable") {
        return "fix the server's `Location`, which is not a URL the kit can resolve";
      }
      return "point `baseUrl` at the URL that serves the api";
    }),
  ).join("; ");

/**
 * The one finding for the read endpoints a redirect the kit does not follow
 * answered, out of `probed`, or none when no endpoint was.
 */
const redirectedFinding = (
  impl: Rule,
  redirected: ReadonlyArray<Observation>,
  probed: number,
): ReadonlyArray<Finding> =>
  Arr.match(redirected, {
    onEmpty: () => [],
    onNonEmpty: ([first, ...rest]) => {
      const which = redirected.length === probed ? "every" : `${redirected.length} of ${probed}`;
      const them = redirected.length === 1 ? "it" : "them";
      const more = Arr.match(rest, {
        onEmpty: () => "",
        onNonEmpty: (others) =>
          `; and ${others.length} more (${listed(others.map(({ probe }) => probe.url))})`,
      });
      return [
        finding(impl, {
          detail: `${which} read endpoint${probed === 1 ? "" : "s"} the kit probed answered with a redirect it does not follow or read, so the rules that probe ${them} have no answer to decide on — ${remedies(redirected)}`,
          expected:
            "an answer from the base URL's origin, directly or through redirects that stay on it",
          observed: `${first.probe.url}: ${describe(first)}${more}`,
          probe: first.probe,
        }),
      ];
    },
  });

const reachable: RuleImpl = {
  rule: rule(
    "spec/target/reachable",
    "Conformance preconditions",
    "introduction",
    "MUST",
    "Every endpoint the kit probes must answer with an HTTP response — a kit cannot report conformance for a target it cannot reach. A redirect is followed only within the base URL's origin, so a read endpoint that redirects anywhere else has not answered.",
  ),
  // A read endpoint a redirect the kit does not follow answers is this rule's
  // to report, once, rather than every rule's to be not decided by silently.
  ownsRedirects: true,
  run: (ctx) =>
    Effect.gen(function* () {
      const { resolved, unresolved } = readable(ctx);
      if (Arr.isReadonlyArrayEmpty(resolved))
        return skip(reachable.rule, noProbeReason("JSON:API read endpoint", unresolved));
      const observations = yield* Effect.forEach(
        resolved,
        ({ path }) => ctx.request({ url: path, headers: jsonApiAccept }),
        { concurrency: 1 },
      );
      const redirected = observations.filter(({ unfollowed }) => Option.isSome(unfollowed));
      const lost = observations.filter(
        ({ status, unfollowed }) => status === 0 && Option.isNone(unfollowed),
      );
      const findings = [
        ...redirectedFinding(reachable.rule, redirected, resolved.length),
        ...lost.map((observation) =>
          finding(reachable.rule, {
            detail: `${observation.probe.url} produced no HTTP response`,
            expected: "any HTTP response",
            observed: describe(observation),
            probe: observation.probe,
          }),
        ),
      ];
      return settle(reachable.rule, resolved.length, findings, coverageNote(unresolved));
    }),
};

/**
 * The JSON:API v1.1 suite, in report order.
 *
 * A run does not send the rules' requests in this order: every rule marked
 * `creates` runs after every rule that is not, the profile tier's included.
 * That is load-bearing — a create response naming an id a read has shown is
 * refused (`vet` in `./write.ts`), and that check knows only what the reads
 * before it have shown (`Context.observed`). A rule that creates must carry
 * `creates: true`, or the reads after it cannot inform its vetting.
 *
 * @internal
 */
export const rules: ReadonlyArray<RuleImpl> = [
  reachable,
  responseMediaType,
  contentTypeParameters,
  acceptParameters,
  acceptWeight,
  acceptWeightZero,
  unknownProfileIgnored,
  unsupportedExtension,
  topLevelMembers,
  dataAndErrorsExclusive,
  includedRequiresData,
  fullLinkage,
  noDuplicateResources,
  includedOnInclude,
  resourceIdentification,
  jsonApiObject,
  errorDocumentStructure,
  errorMemberTypes,
  errorSourceDiscrimination,
  errorStatusMatches,
  sparseFieldsets("primary"),
  sparseFieldsets("included"),
  sparseFieldsetsEmpty,
  unknownQueryParameter,
  illegalParameterName,
  unsupportedExtensionParameter,
  unsupportedInclude,
  unsupportedSort,
  includeUnsupportedEndpoint,
  sortUnsupportedEndpoint,
  fieldsUnsupportedEndpoint,
  pageUnsupportedEndpoint,
  filterUnsupportedEndpoint,
  pageUndeclaredMember,
  filterUndeclaredMember,
  includeBracketed,
  sortBracketed,
  linksEnumerateCollection,
  resourceSelfDereferences,
  relatedDereferences,
  relatedMatchesLinkage,
  relationshipSelfDereferences,
  relationshipSelfMatchesLinkage,
  topLevelSelfDereferences,
  topLevelSelfMatchesDocument,
  resourceNotFound,
  createResponseDocument,
  createLocation,
  createLocationMatchesSelf,
  updateResponse,
  deleteResponse,
  createConflictType,
  createReadBack,
  updateReadBack,
  ...clientIdRules,
  ...relationshipRules,
  ...atomicRules,
  ...atomicClientIdRules,
];
