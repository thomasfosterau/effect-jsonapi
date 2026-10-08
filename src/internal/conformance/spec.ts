/**
 * The JSON:API v1.1 rules: content negotiation, document structure, error
 * objects, query parameters, status codes and the atomic operations extension.
 *
 * Each rule is one normative sentence with its section and a probe that decides
 * it. Rules that would change the target's state are gated behind
 * `mutating: true` and report `Skipped` otherwise, and act only on resources
 * they created themselves from the caller's `writes` fixture (`./write.ts`) —
 * never on a sample id, nor on an id a create response names for anything but
 * what the kit sent; rules whose shape this api has no endpoint for report
 * `Skipped` naming what was missing. Nothing here silently passes.
 *
 * @since 0.15.0
 * @internal
 */
import { Array as Arr, Effect, Match, Option, Predicate, Result, Schema } from "effect";
import { MEDIA_TYPE } from "../media.js";
import {
  atomicMediaType,
  type Context,
  describe,
  errorObjectsOf,
  finding,
  type Finding,
  identity,
  isRecord,
  jsonApiAccept,
  linkageOf,
  coverageNote,
  noProbeReason,
  type Observation,
  parseMediaType,
  probeable,
  resourcesOf,
  type Rule,
  type RuleImpl,
  settle,
  skip,
  withQuery,
  type Outcome,
  type Payload,
} from "./core.js";
import {
  type Accepted,
  atomicIdentity,
  atomicTargets,
  buildUpdate,
  decided,
  onAccepted,
  overTargets,
  ownId,
  pathFor,
  primaryIdentity,
  type Target,
  targets,
  undecided,
  type Verdict,
  viaCreateEndpoint,
  withCreated,
  writeHeaders,
} from "./write.js";

const SPEC = "https://jsonapi.org/format/1.1";
const ATOMIC = "https://jsonapi.org/ext/atomic";

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

/** Every endpoint whose successful response is a JSON:API document. */
const readable = (ctx: Context) =>
  probeable(ctx, ["collection", "resource", "related", "relationship"]);

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
      if (resolved.length === 0)
        return skip(responseMediaType.rule, noProbeReason("JSON:API read endpoint", unresolved));
      const findings: Array<Finding> = [];
      for (const { path } of resolved) {
        const observation = yield* ctx.request({ url: path, headers: jsonApiAccept });
        if (observation.status < 200 || observation.status >= 300) continue;
        if (observation.text === "") continue;
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
          continue;
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
          continue;
        }
        const illegal = parameters.filter(([name]) => name !== "ext" && name !== "profile");
        if (illegal.length > 0) {
          findings.push(
            finding(responseMediaType.rule, {
              detail: `${path} answered with the media type parameter(s) ${illegal.map(([n]) => n).join(", ")}`,
              expected: `${MEDIA_TYPE} with only \`ext\` / \`profile\` parameters`,
              observed: describe(observation),
              probe: observation.probe,
            }),
          );
        }
      }
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
      const { resolved, unresolved } = probeable(ctx, ["create", "update", "relationshipWrite"]);
      // The create endpoint first: of the three it is the one whose URL names
      // no existing resource, so even a server that ignores the media type has
      // nothing of the caller's to change.
      const target = resolved.find(({ endpoint }) => endpoint.role === "create") ?? resolved[0];
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
      for (const [accept, description] of accepts) {
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
      }
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
const includableOf = (body: unknown): ReadonlyArray<string> => {
  if (!isRecord(body)) return [];
  const data = body["data"];
  const first = Array.isArray(data) ? data.find(isRecord) : isRecord(data) ? data : undefined;
  if (first === undefined) return [];
  const relationships = first["relationships"];
  if (!isRecord(relationships)) return [];
  return Object.keys(relationships).filter((name) => {
    const relationship = relationships[name];
    return isRecord(relationship) && "data" in relationship;
  });
};

/**
 * Every document the api will hand the kit for its read endpoints: a bare probe
 * per endpoint, plus a compound probe wherever `include` is declared and a
 * relationship with inline linkage can be learned from the bare response.
 *
 * The compound probe is what gives the full-linkage and duplicate-resource rules
 * something to be true *about*; without it they would pass over documents that
 * never carry `included`, which is a pass that proves nothing.
 */
const documentProbes = (ctx: Context) =>
  Effect.gen(function* () {
    const out: Array<{ readonly where: string; readonly observation: Observation }> = [];
    for (const { endpoint, path } of readable(ctx).resolved) {
      const bare = yield* ctx.request({ url: path, headers: jsonApiAccept });
      out.push({ where: path, observation: bare });
      if (!endpoint.queryKeys.includes("include")) continue;
      const includable = includableOf(bare.body);
      if (includable.length === 0) continue;
      const url = withQuery(path, [["include", includable.join(",")]]);
      const compound = yield* ctx.request({ url, headers: jsonApiAccept });
      if (compound.status >= 200 && compound.status < 300)
        out.push({ where: url, observation: compound });
    }
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
      readonly applicable?: ((body: unknown) => boolean) | undefined;
      readonly inapplicable?: string | undefined;
      readonly check: (
        body: unknown,
        observation: Observation,
        where: string,
      ) => ReadonlyArray<Finding>;
    },
  ): RuleImpl["run"] =>
  (ctx) =>
    Effect.gen(function* () {
      const { resolved, unresolved } = readable(ctx);
      if (resolved.length === 0)
        return skip(impl, noProbeReason("JSON:API read endpoint", unresolved));
      const documents = yield* documentProbes(ctx);
      const note = coverageNote(unresolved);
      const findings: Array<Finding> = [];
      let evaluated = 0;
      for (const { observation, where } of documents) {
        if (observation.body === undefined) continue;
        if (options.applicable !== undefined && !options.applicable(observation.body)) continue;
        evaluated += 1;
        findings.push(...options.check(observation.body, observation, where));
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
        return has.length > 0
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
    "A compound document MUST NOT include resources that cannot be linked to the primary data: every resource in `included` must be identified by a resource identifier object reachable from the primary data or from another included resource.",
  ),
  run: (ctx) =>
    overDocuments(fullLinkage.rule, {
      applicable: (body) =>
        isRecord(body) && Array.isArray(body["included"]) && body["included"].length > 0,
      inapplicable:
        "no endpoint returned a compound document — either none declares `include`, or no resource it returned carries inline relationship linkage to include",
      check: (body, observation, where) => {
        if (!isRecord(body)) return [];
        const included = body["included"];
        if (!Array.isArray(included) || included.length === 0) return [];
        const primary = body["data"];
        const primaries = Array.isArray(primary)
          ? primary.filter(isRecord)
          : isRecord(primary)
            ? [primary]
            : [];
        const includedRecords = included.filter(isRecord);
        const byIdentity = new Map<string, Readonly<Record<string, unknown>>>();
        for (const resource of includedRecords) {
          const key = identity(resource);
          if (key !== undefined) byIdentity.set(key, resource);
        }
        const reachable = new Set<string>();
        const frontier: Array<string> = [];
        const seed = (keys: ReadonlyArray<string>) => {
          for (const key of keys) {
            if (reachable.has(key)) continue;
            reachable.add(key);
            frontier.push(key);
          }
        };
        for (const resource of primaries) seed(linkageOf(resource));
        while (frontier.length > 0) {
          const key = frontier.pop()!;
          const resource = byIdentity.get(key);
          if (resource !== undefined) seed(linkageOf(resource));
        }
        const orphans = includedRecords.filter((resource) => {
          const key = identity(resource);
          return key === undefined || !reachable.has(key);
        });
        return orphans.length === 0
          ? []
          : [
              finding(fullLinkage.rule, {
                detail: `${where} answered ${orphans.length} included resource(s) unreachable from the primary data`,
                expected: "every `included` resource reachable through resource linkage",
                observed: orphans
                  .map(
                    (resource) =>
                      `${String(resource["type"])}:${String(resource["id"] ?? resource["lid"])}`,
                  )
                  .join(", "),
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
      applicable: (body) => resourcesOf(body).length > 1,
      inapplicable: "no endpoint returned a document carrying more than one resource object",
      check: (body, observation, where) => {
        const resources = resourcesOf(body);
        const seen = new Map<string, string>();
        const duplicates: Array<string> = [];
        for (const { pointer, resource } of resources) {
          const key = identity(resource);
          if (key === undefined) continue;
          const first = seen.get(key);
          if (first === undefined) seen.set(key, pointer);
          else
            duplicates.push(
              `${String(resource["type"])}:${String(resource["id"])} at ${first} and ${pointer}`,
            );
        }
        return duplicates.length === 0
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
      applicable: (body) => resourcesOf(body).length > 0,
      inapplicable: "no endpoint returned a document carrying a resource object",
      check: (body, observation, where) => {
        const findings: Array<Finding> = [];
        for (const { pointer, resource } of resourcesOf(body)) {
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

const errorDocumentShape: RuleImpl = {
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
      if (observations.length === 0) {
        return skip(
          errorDocumentShape.rule,
          "no error response could be provoked without mutating the target",
        );
      }
      const findings: Array<Finding> = [];
      for (const observation of observations) {
        if (observation.status === 404 && observation.text === "") continue;
        const body = observation.body;
        if (!isRecord(body) || !Array.isArray(body["errors"]) || body["errors"].length === 0) {
          findings.push(
            finding(errorDocumentShape.rule, {
              detail: `a ${observation.status} response was not a JSON:API error document`,
              expected: "`{ errors: [ … ] }` with at least one error object",
              observed: describe(observation),
              probe: observation.probe,
            }),
          );
        }
      }
      return settle(errorDocumentShape.rule, observations.length, findings);
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
      if (errors.length === 0)
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
          .filter(isRecord)
          .map((source) => ({ source, observation })),
      );
      if (sources.length === 0) {
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
      if (observations.length === 0)
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

const sparseFieldsets = (where: "primary" | "included"): RuleImpl => {
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
      Effect.gen(function* () {
        const candidates = readable(ctx).resolved.filter(
          ({ endpoint }) => fieldsOf(endpoint.queryKeys).length > 0,
        );
        if (candidates.length === 0) return skip(impl, "no endpoint declares `fields[TYPE]`");
        const findings: Array<Finding> = [];
        let probes = 0;
        let evaluated = 0;
        for (const { endpoint, path } of candidates) {
          // Learn the attribute names this endpoint actually emits, then ask for
          // exactly the first one: a projection rule needs a field set the
          // server is known to be able to return. The `included` variant needs a
          // compound document, so the baseline is taken with `include` on.
          const baseline = yield* ctx.request({ url: path, headers: jsonApiAccept });
          probes += 1;
          let source = baseline;
          let base = path;
          if (where === "included") {
            if (!endpoint.queryKeys.includes("include")) continue;
            const includable = includableOf(baseline.body);
            if (includable.length === 0) continue;
            base = withQuery(path, [["include", includable.join(",")]]);
            source = yield* ctx.request({ url: base, headers: jsonApiAccept });
            probes += 1;
            if (source.status < 200 || source.status >= 300) continue;
          }
          // Only types that actually appear in the slot under test can decide
          // this rule; anything else would be a pass over an empty set.
          const byType = new Map<string, ReadonlyArray<string>>();
          for (const { pointer, resource } of resourcesOf(source.body)) {
            const inIncluded = pointer.startsWith("/included");
            if (where === "included" ? !inIncluded : inIncluded) continue;
            const type = resource["type"];
            const attributes = resource["attributes"];
            if (typeof type === "string" && isRecord(attributes) && !byType.has(type)) {
              byType.set(type, Object.keys(attributes));
            }
          }
          for (const type of fieldsOf(endpoint.queryKeys)) {
            const attributes = byType.get(type);
            if (attributes === undefined || attributes.length < 2) continue;
            const requested = attributes[0]!;
            const url = withQuery(base, [[`fields[${type}]`, requested]]);
            const observation = yield* ctx.request({ url, headers: jsonApiAccept });
            probes += 1;
            if (observation.status < 200 || observation.status >= 300) continue;
            const subjects = resourcesOf(observation.body).filter(({ pointer, resource }) => {
              const inIncluded = pointer.startsWith("/included");
              return (where === "included" ? inIncluded : !inIncluded) && resource["type"] === type;
            });
            // A projection request that returned no resource of that type in
            // that slot proves nothing either way.
            if (subjects.length === 0) continue;
            evaluated += 1;
            for (const { pointer, resource } of subjects) {
              const emitted = resource["attributes"];
              if (!isRecord(emitted)) continue;
              const extra = Object.keys(emitted).filter((key) => key !== requested);
              if (extra.length > 0) {
                findings.push(
                  finding(impl, {
                    detail: `\`fields[${type}]=${requested}\` still returned other fields at ${pointer}`,
                    expected: `only \`${requested}\` in \`attributes\``,
                    observed: `also returned: ${extra.join(", ")}`,
                    probe: observation.probe,
                  }),
                );
              }
            }
          }
        }
        if (evaluated === 0) {
          return skip(
            impl,
            where === "included"
              ? "no endpoint returned an `included` resource, of a type it declares `fields[TYPE]` for, carrying two or more attributes to project"
              : "no endpoint returned a primary resource, of a type it declares `fields[TYPE]` for, carrying two or more attributes to project",
          );
        }
        return settle(impl, probes, findings);
      }),
  };
};

const unknownQueryParameter: RuleImpl = {
  rule: rule(
    "spec/query/unknown-query-parameter",
    "Query Parameters",
    "query-parameters-custom",
    "MUST",
    "Implementation-specific query parameters MUST contain at least one non a-z character, so a server MUST respond with 400 Bad Request to a query parameter named only with a-z that it does not recognise from the specification.",
  ),
  run: (ctx) =>
    Effect.gen(function* () {
      const target = readable(ctx).resolved[0];
      if (target === undefined)
        return skip(unknownQueryParameter.rule, noProbeReason("JSON:API read endpoint", []));
      const url = withQuery(target.path, [["unknown", "1"]]);
      const observation = yield* ctx.request({ url, headers: jsonApiAccept });
      const findings =
        observation.status === 400
          ? []
          : [
              finding(unknownQueryParameter.rule, {
                detail:
                  "`?unknown=1` — a name with no non a-z character, not reserved by the spec — was not rejected",
                expected: "400 Bad Request",
                observed: describe(observation),
                probe: observation.probe,
              }),
            ];
      return settle(unknownQueryParameter.rule, 1, findings);
    }),
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
  decodeSelfLink(observation.body).pipe(
    Option.map(({ data }) =>
      Predicate.isString(data.links.self) ? data.links.self : data.links.self.href,
    ),
  );

/** A URL resolved against the target's origin, so a relative and an absolute spelling compare equal. */
const absolute = (url: string, base: string): string =>
  Result.try({ try: () => new URL(url, base).href, catch: () => url }).pipe(Result.merge);

const createLocationMatchesSelf: RuleImpl = {
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
              ctx
                .request({
                  method: target.endpoint.method,
                  url: pathFor(target.endpoint, id),
                  headers: writeHeaders,
                  body: { data: { ...patch, type: created.payload.type, id } },
                })
                .pipe(
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
      if (!isRecord(observation.body))
        return broken(
          `the 200 updating ${type}:${id} carried no response document`,
          "a JSON:API document",
        );
      // JSON:API 1.1: a 200 MAY carry no primary data when the server changed
      // nothing beyond the request; when it carries `data`, that is the resource.
      if (!Predicate.hasProperty(observation.body, "data")) return [];
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
                ctx
                  .request({
                    method: target.endpoint.method,
                    url: pathFor(target.endpoint, id),
                    headers: jsonApiAccept,
                  })
                  .pipe(
                    // A completed deletion is the disposal; anything else still owes a cleanup.
                    Effect.tap((observation) =>
                      Effect.sync(() => {
                        if (observation.status === 200 || observation.status === 204)
                          created.entry.disposal = "deleted";
                      }),
                    ),
                    Effect.map((observation) => decided(2, judgeDelete(observation))),
                  ),
            }),
          ),
        ),
    ),
};

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
      const members = isRecord(observation.body)
        ? Arr.map(Arr.fromRecord(observation.body), ([member]) => member)
        : [];
      return isRecord(observation.body) && Arr.every(members, metaOnly)
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
// Atomic operations extension
// ---------------------------------------------------------------------------

const operationsEndpoint = (ctx: Context) =>
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
      const observation = yield* ctx.request({
        method: endpoint.method,
        url: endpoint.path,
        headers: { accept: atomicMediaType, "content-type": atomicMediaType },
        body: { "atomic:operations": "not an array" },
      });
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
  rule: rule(
    "spec/atomic/response-ext-parameter",
    "Content Negotiation — Universal Responsibilities (with the Atomic Operations extension)",
    "content-negotiation-all",
    "MUST",
    "Clients and servers MUST specify the `ext` media type parameter in the `Content-Type` header when they have applied one or more extensions to a JSON:API document — so a response to an atomic operations request, which applies that extension, names its URI in `ext`.",
  ),
  run: (ctx) => {
    const endpoint = operationsEndpoint(ctx);
    if (endpoint === undefined)
      return Effect.succeed(skip(atomicResponseExt.rule, "no atomic operations endpoint"));
    const send = (payload: Payload) =>
      ctx.request({
        method: endpoint.method,
        url: endpoint.path,
        headers: { accept: atomicMediaType, "content-type": atomicMediaType },
        body: { "atomic:operations": [{ op: "add", data: payload }] },
      });
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

const judgeAtomicMediaType = (target: Target, observation: Observation): Verdict => {
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

const atomicAllOrNothing: RuleImpl = {
  rule: atomicRule(
    "spec/atomic/all-or-nothing",
    "Atomic Operations — Processing",
    "MUST",
    "If an operation in an atomic operations request fails, the server MUST NOT apply any of the operations in that request, and MUST respond with an error document.",
  ),
  run: (ctx) =>
    Effect.succeed(
      operationsEndpoint(ctx) === undefined
        ? skip(atomicAllOrNothing.rule, "no atomic operations endpoint")
        : skip(
            atomicAllOrNothing.rule,
            "requires applying operations, then observing what was stored — not yet written (see the coverage gaps, #164)",
          ),
    ),
};

const atomicLidResolution: RuleImpl = {
  rule: atomicRule(
    "spec/atomic/lid-resolution",
    "Atomic Operations — Local Identifiers",
    "MUST",
    "A `lid` assigned by one operation MUST be resolvable as a reference in every later operation of the same request.",
  ),
  run: (ctx) =>
    Effect.succeed(
      operationsEndpoint(ctx) === undefined
        ? skip(atomicLidResolution.rule, "no atomic operations endpoint")
        : skip(
            atomicLidResolution.rule,
            "requires applying operations, then reading back what they stored — not yet written (see the coverage gaps, #164)",
          ),
    ),
};

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

const reachable: RuleImpl = {
  rule: rule(
    "spec/target/reachable",
    "Conformance preconditions",
    "introduction",
    "MUST",
    "Every endpoint the kit probes must answer with an HTTP response — a kit cannot report conformance for a target it cannot reach.",
  ),
  run: (ctx) =>
    Effect.gen(function* () {
      const { resolved, unresolved } = readable(ctx);
      if (resolved.length === 0)
        return skip(reachable.rule, noProbeReason("JSON:API read endpoint", unresolved));
      const findings: Array<Finding> = [];
      for (const { path } of resolved) {
        const observation = yield* ctx.request({ url: path, headers: jsonApiAccept });
        if (observation.status === 0) {
          findings.push(
            finding(reachable.rule, {
              detail: `${path} produced no HTTP response`,
              expected: "any HTTP response",
              observed: describe(observation),
              probe: observation.probe,
            }),
          );
        }
      }
      return settle(reachable.rule, resolved.length, findings, coverageNote(unresolved));
    }),
};

/**
 * The JSON:API v1.1 suite, in report order.
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
  resourceIdentification,
  jsonApiObject,
  errorDocumentShape,
  errorMemberTypes,
  errorSourceDiscrimination,
  errorStatusMatches,
  sparseFieldsets("primary"),
  sparseFieldsets("included"),
  unknownQueryParameter,
  unsupportedInclude,
  unsupportedSort,
  resourceNotFound,
  createResponseDocument,
  createLocation,
  createLocationMatchesSelf,
  updateResponse,
  deleteResponse,
  atomicMalformedRejected,
  atomicResponseExt,
  atomicAllOrNothing,
  atomicLidResolution,
];
