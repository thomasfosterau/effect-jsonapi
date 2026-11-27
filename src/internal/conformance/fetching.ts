/**
 * Spec-tier rules on what a read answers beyond its own document: which
 * `included` members a request asked for, the 404s of a relationship or
 * related URL under an absent resource, a to-one related URL with no target,
 * the shape of a relationship endpoint's primary data, where pagination links
 * may appear, and the @-members a create must ignore.
 *
 * @internal
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as MutableHashSet from "effect/MutableHashSet";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import type * as Schema from "effect/Schema";
import {
  coverageNote,
  describe,
  type Discovered,
  documentOf,
  finding,
  type Finding,
  identity,
  isJsonArray,
  isJsonObject,
  jsonApiAccept,
  noProbeReason,
  type Observation,
  type Payload,
  probeable,
  resourceLabel,
  type Role,
  type Rule,
  type RuleImpl,
  settle,
  skip,
  succeeded,
  withQuery,
} from "./core.js";
import {
  Created,
  decided,
  overTargets,
  refusedOnKeyGrounds,
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

const READ_ROLES: ReadonlyArray<Role> = ["collection", "resource", "related", "relationship"];

const keysOf = (object: R.ReadonlyRecord<string, Schema.Json>): ReadonlyArray<string> =>
  R.keys(object);

/** A document's primary data as the resource objects in it. */
const primaryObjects = (document: Schema.JsonObject): ReadonlyArray<Schema.JsonObject> => {
  const data = document["data"];
  if (data === undefined) return [];
  return Arr.filter(isJsonArray(data) ? data : [data], isJsonObject);
};

/** The identities resource linkage holds: one, `null`'s none, or an array's each. */
const linkageIdentities = (data: Schema.Json): ReadonlyArray<string> =>
  Arr.flatMap(isJsonArray(data) ? data : [data], (identifier) =>
    isJsonObject(identifier) ? Option.toArray(identity(identifier)) : [],
  );

/** The relationship name a related or relationship endpoint's path ends in. */
const relationshipName = (endpoint: Discovered): Option.Option<string> =>
  Option.fromNullishOr(/\/([^/:][^/]*)$/.exec(endpoint.path)?.[1]);

/** The endpoint's path with its one parameter set to `id`. */
const pathWith = (endpoint: Discovered, id: string): Option.Option<string> =>
  endpoint.params.length === 1
    ? Option.some(endpoint.path.replace(`:${endpoint.params[0]}`, encodeURIComponent(id)))
    : Option.none();

// ---------------------------------------------------------------------------
// Unrequested `included` members
// ---------------------------------------------------------------------------

const noUnrequestedIncluded: RuleImpl = {
  rule: rule(
    "spec/document/no-unrequested-included",
    "Inclusion of Related Resources",
    "fetching-includes",
    "MUST NOT",
    "The server MUST NOT include unrequested resource objects in the `included` section of the compound document.",
  ),
  run: (ctx) =>
    Effect.gen(function* () {
      const impl = noUnrequestedIncluded.rule;
      const { resolved, unresolved } = probeable(ctx, READ_ROLES);
      const including = Arr.filter(resolved, ({ endpoint }) =>
        endpoint.queryKeys.includes("include"),
      );
      if (Arr.isReadonlyArrayEmpty(including))
        return skip(impl, noProbeReason("read endpoint declaring `include`", unresolved));
      const findings: Array<Finding> = [];
      let probes = 0;
      let evaluated = 0;
      yield* Effect.forEach(
        including,
        ({ endpoint, path }) =>
          Effect.gen(function* () {
            // One relationship path, a single hop: the members it requests are
            // exactly the targets of that relationship's linkage in the primary
            // data (on a relationship endpoint, the primary data itself).
            const name =
              endpoint.role === "relationship"
                ? relationshipName(endpoint)
                : yield* Effect.map(ctx.request({ url: path, headers: jsonApiAccept }), (bare) => {
                    probes += 1;
                    return Option.flatMap(documentOf(bare.body), (document) =>
                      Arr.findFirst(primaryObjects(document), () => true).pipe(
                        Option.flatMap((first) => {
                          const relationships = first["relationships"];
                          return isJsonObject(relationships)
                            ? Arr.findFirst(keysOf(relationships), (candidate) => {
                                const relationship = relationships[candidate];
                                return isJsonObject(relationship) && "data" in relationship;
                              })
                            : Option.none();
                        }),
                      ),
                    );
                  });
            if (Option.isNone(name)) return;
            const url = withQuery(path, [["include", name.value]]);
            const observation = yield* ctx.request({ url, headers: jsonApiAccept });
            probes += 1;
            if (!succeeded(observation)) return;
            const document = documentOf(observation.body);
            if (Option.isNone(document)) return;
            const included = document.value["included"];
            if (!isJsonArray(included)) return;
            const requested = requestedIdentities(endpoint, document.value, name.value);
            if (Option.isNone(requested)) return;
            evaluated += 1;
            const allowed = MutableHashSet.fromIterable(requested.value);
            const extra = Arr.filter(
              Arr.filter(included, isJsonObject),
              (member) =>
                !Option.exists(identity(member), (key) => MutableHashSet.has(allowed, key)),
            );
            if (Arr.isReadonlyArrayNonEmpty(extra))
              findings.push(
                finding(impl, {
                  detail: `${url} included resources the path \`${name.value}\` does not reach from the primary data`,
                  expected: `only the targets of the primary data's \`${name.value}\` linkage in \`included\``,
                  observed: `also included: ${extra.map(resourceLabel).join(", ")}`,
                  probe: observation.probe,
                }),
              );
          }),
        { concurrency: 1, discard: true },
      );
      if (evaluated === 0)
        return skip(
          impl,
          "no endpoint declaring `include` answered a one-path include with a compound document whose primary data shows that relationship's linkage",
        );
      return settle(impl, probes, findings, coverageNote(unresolved));
    }),
};

// The identities a single-hop `include=name` requests, or `None` when the
// primary data does not show that relationship's linkage on every resource.
const requestedIdentities = (
  endpoint: Discovered,
  document: Schema.JsonObject,
  name: string,
): Option.Option<ReadonlyArray<string>> => {
  const data = document["data"];
  if (data === undefined) return Option.none();
  if (endpoint.role === "relationship") return Option.some(linkageIdentities(data));
  const linkages = Arr.map(primaryObjects(document), (resource) => {
    const relationships = resource["relationships"];
    const relationship = isJsonObject(relationships) ? relationships[name] : undefined;
    return relationship !== undefined && isJsonObject(relationship) && "data" in relationship
      ? Option.some(linkageIdentities(relationship["data"] ?? null))
      : Option.none();
  });
  return Option.map(Option.all(linkages), Arr.flatten);
};

// ---------------------------------------------------------------------------
// 404 under an absent resource
// ---------------------------------------------------------------------------

const underAbsent =
  (role: "relationship" | "related", impl: Rule, what: string): RuleImpl["run"] =>
  (ctx) =>
    Effect.gen(function* () {
      const paths = Arr.flatMap(
        Arr.filter(ctx.endpoints, (endpoint) => endpoint.role === role),
        (endpoint: Discovered) => Option.toArray(pathWith(endpoint, ctx.options.absentId)),
      );
      if (Arr.isReadonlyArrayEmpty(paths))
        return skip(impl, `no ${what} endpoint with exactly one path parameter`);
      const findings: Array<Finding> = [];
      yield* Effect.forEach(
        paths,
        (path) =>
          Effect.map(ctx.request({ url: path, headers: jsonApiAccept }), (observation) => {
            if (observation.status !== 404)
              findings.push(
                finding(impl, {
                  detail: `fetching ${path}, under the absent id "${ctx.options.absentId}", did not produce a 404`,
                  expected: "404 Not Found",
                  observed: describe(observation),
                  probe: observation.probe,
                }),
              );
          }),
        { concurrency: 1, discard: true },
      );
      return settle(
        impl,
        paths.length,
        findings,
        Option.some(`probed with the absent id "${ctx.options.absentId}"`),
      );
    });

const relationshipNotFound: RuleImpl = {
  rule: rule(
    "spec/status/relationship-not-found",
    "Fetching Relationships",
    "fetching-relationships-responses-404",
    "MUST",
    "A server MUST return 404 Not Found when processing a request to fetch a relationship link URL that does not exist.",
  ),
  run: (ctx) => underAbsent("relationship", relationshipNotFound.rule, "relationship")(ctx),
};

const relatedNotFound: RuleImpl = {
  rule: rule(
    "spec/status/related-not-found",
    "Fetching Resources",
    "fetching-resources-responses-404",
    "SHOULD",
    "A related resource link of a resource that does not exist does not exist either, so a request to fetch it SHOULD be answered with 404 Not Found, as a request for the resource itself MUST be.",
  ),
  run: (ctx) => underAbsent("related", relatedNotFound.rule, "related")(ctx),
};

// ---------------------------------------------------------------------------
// A to-one related URL with no target
// ---------------------------------------------------------------------------

// The id of a resource in `document`'s primary data whose `name` linkage is
// `null`: an empty to-one relationship.
const emptyToOne = (document: Schema.JsonObject, name: string): Option.Option<string> =>
  Arr.findFirst(primaryObjects(document), (resource) => {
    const relationships = resource["relationships"];
    const relationship = isJsonObject(relationships) ? relationships[name] : undefined;
    return (
      relationship !== undefined && isJsonObject(relationship) && relationship["data"] === null
    );
  }).pipe(Option.flatMap((resource) => Option.liftPredicate(resource["id"] ?? null, P.isString)));

const relatedToOneNull: RuleImpl = {
  rule: rule(
    "spec/status/related-to-one-null",
    "Fetching Resources",
    "fetching-resources-responses-200",
    "MUST",
    "`null` is the appropriate primary data when the requested URL might correspond to a single resource but doesn't currently, so the related resource URL of an empty to-one relationship MUST be answered with 200 OK and `data: null`.",
  ),
  run: (ctx) =>
    Effect.gen(function* () {
      const impl = relatedToOneNull.rule;
      const related = Arr.filter(ctx.endpoints, (endpoint) => endpoint.role === "related");
      if (Arr.isReadonlyArrayEmpty(related)) return skip(impl, "no related endpoint in this api");
      const { resolved } = probeable(ctx, ["collection", "resource"]);
      const findings: Array<Finding> = [];
      let probes = 0;
      let evaluated = 0;
      yield* Effect.forEach(
        related,
        (endpoint) =>
          Effect.gen(function* () {
            const name = relationshipName(endpoint);
            if (Option.isNone(name)) return;
            const parents = Arr.filter(
              resolved,
              ({ endpoint: parent }) =>
                Option.isSome(parent.segment) &&
                Option.getOrUndefined(parent.segment) === Option.getOrUndefined(endpoint.segment),
            );
            let empty = Option.none<string>();
            yield* Effect.forEach(
              parents,
              ({ path }) =>
                Option.isSome(empty)
                  ? Effect.void
                  : Effect.map(
                      ctx.request({ url: path, headers: jsonApiAccept }),
                      (observation) => {
                        probes += 1;
                        empty = Option.flatMap(documentOf(observation.body), (document) =>
                          emptyToOne(document, name.value),
                        );
                      },
                    ),
              { concurrency: 1, discard: true },
            );
            const url = Option.flatMap(empty, (id) => pathWith(endpoint, id));
            if (Option.isNone(url)) return;
            const observation = yield* ctx.request({ url: url.value, headers: jsonApiAccept });
            probes += 1;
            evaluated += 1;
            const answered =
              observation.status === 200 &&
              Option.exists(documentOf(observation.body), (document) => document["data"] === null);
            if (!answered)
              findings.push(
                finding(impl, {
                  detail: `${url.value}, the related URL of an empty to-one \`${name.value}\`, did not answer 200 with \`data: null\``,
                  expected: "200 OK with `data: null`",
                  observed: describe(observation),
                  probe: observation.probe,
                }),
              );
          }),
        { concurrency: 1, discard: true },
      );
      if (evaluated === 0)
        return skip(
          impl,
          "no readable resource showed an empty to-one relationship that has a related endpoint",
        );
      return settle(impl, probes, findings);
    }),
};

// ---------------------------------------------------------------------------
// A relationship endpoint's primary data
// ---------------------------------------------------------------------------

const IDENTIFIER_MEMBERS = MutableHashSet.fromIterable(["type", "id", "lid", "meta"]);

// What makes `identifier` not a resource identifier object, if anything.
const notAnIdentifier = (identifier: Schema.Json): Option.Option<string> => {
  if (!isJsonObject(identifier)) return Option.some("an entry that is not an object");
  const extra = Arr.filter(
    keysOf(identifier),
    (key) => !MutableHashSet.has(IDENTIFIER_MEMBERS, key),
  );
  if (Arr.isReadonlyArrayNonEmpty(extra))
    return Option.some(`${resourceLabel(identifier)} carrying ${extra.join(", ")}`);
  return Option.isNone(identity(identifier))
    ? Option.some(`${resourceLabel(identifier)} without a string \`type\` and \`id\``)
    : Option.none();
};

const relationshipDataIdentifiers: RuleImpl = {
  rule: rule(
    "spec/document/relationship-data-identifiers",
    "Fetching Relationships",
    "fetching-relationships-responses-200",
    "MUST",
    "The primary data in the response document MUST match the appropriate value for resource linkage: `null`, a resource identifier object, or an array of them, which carry only `type`, `id` (or `lid`) and `meta`.",
  ),
  run: (ctx) =>
    Effect.gen(function* () {
      const impl = relationshipDataIdentifiers.rule;
      const { resolved, unresolved } = probeable(ctx, ["relationship"]);
      if (Arr.isReadonlyArrayEmpty(resolved))
        return skip(impl, noProbeReason("relationship endpoint", unresolved));
      const findings: Array<Finding> = [];
      let evaluated = 0;
      yield* Effect.forEach(
        resolved,
        ({ path }) =>
          Effect.map(ctx.request({ url: path, headers: jsonApiAccept }), (observation) => {
            if (!succeeded(observation)) return;
            const data = Option.flatMap(documentOf(observation.body), (document) =>
              Option.fromUndefinedOr(document["data"]),
            );
            if (Option.isNone(data)) return;
            evaluated += 1;
            const entries = isJsonArray(data.value) ? data.value : [data.value];
            const wrong = Arr.flatMap(entries, (entry) =>
              entry === null && !isJsonArray(data.value)
                ? []
                : Option.toArray(notAnIdentifier(entry)),
            );
            if (Arr.isReadonlyArrayNonEmpty(wrong))
              findings.push(
                finding(impl, {
                  detail: `${path} answered primary data that is not resource linkage`,
                  expected: "`null`, a resource identifier object, or an array of them",
                  observed: wrong.join("; "),
                  probe: observation.probe,
                }),
              );
          }),
        { concurrency: 1, discard: true },
      );
      if (evaluated === 0)
        return skip(impl, "no relationship endpoint answered with a document carrying `data`");
      return settle(impl, evaluated, findings, coverageNote(unresolved));
    }),
};

// ---------------------------------------------------------------------------
// Pagination links
// ---------------------------------------------------------------------------

const PAGINATION_KEYS: ReadonlyArray<string> = ["first", "last", "prev", "next"];

const isLinkValue = (value: Schema.Json): boolean =>
  value === null || P.isString(value) || (isJsonObject(value) && P.isString(value["href"]));

// What is wrong with the pagination members of `links`, which belong to a
// collection when `collection` is true, to a single resource or linkage when
// false, and to linkage of unshown cardinality when `None`.
const paginationProblems = (
  where: string,
  links: Schema.Json,
  collection: Option.Option<boolean>,
): ReadonlyArray<string> => {
  if (!isJsonObject(links)) return [];
  const present = Arr.filter(PAGINATION_KEYS, (key) => Object.hasOwn(links, key));
  const misplaced =
    Option.exists(collection, (isCollection) => !isCollection) &&
    Arr.isReadonlyArrayNonEmpty(present)
      ? [`${where} carries ${present.join(", ")} beside data that is not a collection`]
      : [];
  const malformed = Arr.flatMap(present, (key) =>
    isLinkValue(links[key] ?? null) ? [] : [`${where}.${key} is neither a link nor \`null\``],
  );
  return [...misplaced, ...malformed];
};

const documentPaginationProblems = (document: Schema.JsonObject): ReadonlyArray<string> => {
  const data = document["data"];
  const topLevel = paginationProblems(
    "links",
    document["links"] ?? null,
    data === undefined ? Option.none() : Option.some(isJsonArray(data)),
  );
  const included = document["included"] ?? null;
  const resources = [
    ...primaryObjects(document),
    ...(isJsonArray(included) ? Arr.filter(included, isJsonObject) : []),
  ];
  const nested = Arr.flatMap(resources, (resource) => {
    const relationships = resource["relationships"];
    if (!isJsonObject(relationships)) return [];
    return Arr.flatMap(keysOf(relationships), (name) => {
      const relationship = relationships[name];
      if (relationship === undefined || !isJsonObject(relationship)) return [];
      const linkage = relationship["data"];
      return paginationProblems(
        `${resourceLabel(resource)} relationships.${name}.links`,
        relationship["links"] ?? null,
        linkage === undefined ? Option.none() : Option.some(isJsonArray(linkage)),
      );
    });
  });
  return [...topLevel, ...nested];
};

const paginationLinks: RuleImpl = {
  rule: rule(
    "spec/pagination/links-placement",
    "Pagination",
    "fetching-pagination",
    "MUST",
    "Pagination links MUST appear in the links object that corresponds to a collection, and the keys `first`, `last`, `prev` and `next` MUST either be omitted or have a `null` value when they don't name a link.",
  ),
  run: (ctx) =>
    Effect.gen(function* () {
      const impl = paginationLinks.rule;
      const { resolved, unresolved } = probeable(ctx, READ_ROLES);
      if (Arr.isReadonlyArrayEmpty(resolved))
        return skip(impl, noProbeReason("JSON:API read endpoint", unresolved));
      const findings: Array<Finding> = [];
      let evaluated = 0;
      yield* Effect.forEach(
        resolved,
        ({ path }) =>
          Effect.map(ctx.request({ url: path, headers: jsonApiAccept }), (observation) => {
            if (!succeeded(observation)) return;
            const document = documentOf(observation.body);
            if (Option.isNone(document)) return;
            evaluated += 1;
            const problems = documentPaginationProblems(document.value);
            if (Arr.isReadonlyArrayNonEmpty(problems))
              findings.push(
                finding(impl, {
                  detail: `${path} answered pagination links out of place or malformed`,
                  expected: "pagination links only beside a collection, each a link or `null`",
                  observed: problems.join("; "),
                  probe: observation.probe,
                }),
              );
          }),
        { concurrency: 1, discard: true },
      );
      if (evaluated === 0) return skip(impl, "no read endpoint answered with a JSON:API document");
      return settle(impl, evaluated, findings, coverageNote(unresolved));
    }),
};

// ---------------------------------------------------------------------------
// @-members on a create
// ---------------------------------------------------------------------------

/** The @-member the probe adds, in the resource object and in its `attributes`. */
const AT_MEMBER = "@conformance";

const atMembersIgnored: RuleImpl = {
  creates: true,
  rule: rule(
    "spec/document/at-members-ignored",
    "@-Members",
    "document-member-names-at-members",
    "MUST",
    'A JSON:API processor MUST completely ignore @-Members (members whose names begin with "@"), so a create carrying them where the resource object or its `attributes` would otherwise admit no such member MUST NOT be refused for them.',
  ),
  run: (ctx) =>
    overTargets(ctx, atMembersIgnored.rule, targets(ctx, "create"), "create endpoint", (target) => {
      const via = viaCreateEndpoint(ctx, target);
      return withCreated(
        ctx,
        atMembersIgnored.rule,
        target,
        {
          ...via,
          send: (payload: Payload) => {
            const annotated = {
              ...payload,
              [AT_MEMBER]: "ignored",
              attributes: { ...payload.attributes, [AT_MEMBER]: "ignored" },
            };
            return via.send(annotated);
          },
        },
        (created): Effect.Effect<Verdict> =>
          Effect.succeed(
            Created.$match(created, {
              Unbuilt: ({ reason }) => undecided(reason),
              Sent: ({ observation }) => judgeAtMembers(target, observation),
            }),
          ),
      );
    }),
};

const judgeAtMembers = (
  target: Parameters<typeof viaCreateEndpoint>[1],
  observation: Observation,
): Verdict => {
  if (observation.status === 0)
    return undecided(`the POST to ${target.createPath} got no answer (${describe(observation)})`);
  if (refusedOnKeyGrounds(target.createEndpoint, observation.probe.headers, observation))
    return undecided(
      `the POST to ${target.createPath} was refused over \`Idempotency-Key\` (${describe(observation)}), which says nothing of its @-members`,
    );
  if (succeeded(observation)) return decided(1, []);
  return decided(1, [
    finding(atMembersIgnored.rule, {
      detail: `a POST to ${target.createPath} of writes["${target.key}"].create with \`"${AT_MEMBER}"\` in its resource object and its \`attributes\` answered ${observation.status}`,
      expected: "the create accepted as it is without the @-members",
      observed: describe(observation),
      probe: observation.probe,
    }),
  ]);
};

/** @internal */
export {
  atMembersIgnored,
  noUnrequestedIncluded,
  paginationLinks,
  relatedNotFound,
  relatedToOneNull,
  relationshipDataIdentifiers,
  relationshipNotFound,
};
