/**
 * The compound-document reachability walk behind the spec's full-linkage
 * rule: an `included` member is linked when it can be reached from the
 * primary data by following resource linkage, through the primary data's
 * relationships (or, in a relationship document, its identifiers) and then
 * through other `included` members'.
 *
 * It works on string keys, not on resource values, so the document builders
 * (typed values) and a checker over arbitrary JSON can walk the same graph
 * with their own notion of identity and linkage. The JSON checker
 * ({@link unlinkedIncluded}) is here too: the conformance kit's
 * `spec/document/full-linkage` rule runs it over a response it fetched, and
 * the endpoint middleware runs it over the document the endpoint encoded
 * (#250), so the two judge the wire the same way.
 *
 * @internal
 */
import * as Arr from "effect/Array";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";

/**
 * Every key reachable from `seeds`: the seeds themselves, then the keys
 * `linkageOf` yields for each reached key, level by level until a level
 * reaches nothing new. `linkageOf` yields nothing for a key that names no
 * resource in the document (a reference the document does not include), which
 * ends that branch. Cycles terminate: a key is expanded at most once.
 */
export const reachable = (
  seeds: Iterable<string>,
  linkageOf: (key: string) => Iterable<string>,
): HashSet.HashSet<string> => {
  let reached = HashSet.empty<string>();
  let level = Arr.fromIterable(seeds);
  // oxlint-disable-next-line effect/imperative-loops -- one pass per level: recursing per level overflows the stack on a long chain of included members
  while (Arr.isReadonlyArrayNonEmpty(level)) {
    const fresh = Arr.dedupe(Arr.filter(level, (key) => !HashSet.has(reached, key)));
    reached = HashSet.union(reached, HashSet.fromIterable(fresh));
    level = Arr.flatMap(fresh, (key) => Arr.fromIterable(linkageOf(key)));
  }
  return reached;
};

/** @internal */
export const isRecord = (u: unknown): u is Readonly<Record<string, unknown>> =>
  typeof u === "object" && u !== null && !Array.isArray(u);

/**
 * The comparable string `identity` gives a resource with this `type` and `id`.
 *
 * @internal
 */
export const idKey = (type: string, id: string): string => JSON.stringify(["id", type, id]);

/**
 * A resource object's `(type, id)` identity as a comparable string, or
 * `undefined` when it carries no usable identity.
 *
 * @internal
 */
export const identity = (resource: Readonly<Record<string, unknown>>): string | undefined => {
  const type = resource["type"];
  if (typeof type !== "string") return undefined;
  const id = resource["id"];
  if (typeof id === "string") return idKey(type, id);
  const lid = resource["lid"];
  if (typeof lid === "string") return JSON.stringify(["lid", type, lid]);
  return undefined;
};

/**
 * The identities a resource object's `relationships` point at — the edges
 * full-linkage is computed over.
 *
 * @internal
 */
export const linkageOf = (resource: Readonly<Record<string, unknown>>): ReadonlyArray<string> => {
  const relationships = resource["relationships"];
  if (!isRecord(relationships)) return [];
  const out: Array<string> = [];
  const take = (value: unknown): void => {
    if (!isRecord(value)) return;
    const key = identity(value);
    if (key !== undefined) out.push(key);
  };
  for (const name of Object.keys(relationships)) {
    const relationship = relationships[name];
    if (!isRecord(relationship)) continue;
    const data = relationship["data"];
    if (Array.isArray(data)) data.forEach(take);
    else take(data);
  }
  return out;
};

/** The members a resource identifier object may carry (§Resource Identifier Objects). */
const identifierMembers = HashSet.make("type", "id", "lid", "meta");

/**
 * Whether a primary-data element is a resource identifier object rather than a
 * resource object: it carries no member an identifier may not (`attributes`,
 * `relationships`, `links`). A relationship document's primary data is made
 * of these (#423).
 */
const isResourceIdentifier = (value: Parameters<typeof identity>[0]): boolean =>
  Arr.every(Rec.keys(value), (name) => HashSet.has(identifierMembers, name));

/**
 * The keys the full-linkage walk starts from: the identifiers each primary
 * element's relationships name, and — for a primary element that is itself a
 * resource identifier, as in a relationship document
 * (`GET /articles/1/relationships/comments?include=comments`) — that
 * identifier, so the `included` resource it names is linked (#423).
 */
const primarySeeds = (
  primaries: ReadonlyArray<Parameters<typeof identity>[0]>,
): ReadonlyArray<string> =>
  Arr.flatMap(primaries, (primary) => {
    const own = isResourceIdentifier(primary) ? identity(primary) : undefined;
    return own === undefined ? linkageOf(primary) : [own, ...linkageOf(primary)];
  });

/**
 * The `included` members of a JSON document that cannot be reached from its
 * primary data through resource linkage, in document order — the violations
 * `spec/document/full-linkage` reports.
 *
 * The walk starts from {@link primarySeeds}: the primary data's relationship
 * linkage and, where the primary data is resource linkage (a relationship
 * document), the identifiers themselves. A primary element with nothing but
 * `type`, `id`/`lid` and `meta` reads as an identifier either way; were it a
 * resource object, an `included` member sharing its identity would be a
 * duplicate, which `spec/document/no-duplicate-resources` reports.
 *
 * The walk is the builders' ({@link reachable}, shared so the two cannot
 * drift apart); identity and linkage are over arbitrary JSON:
 * {@link identity} keys a member by `type` and `id`, or by `lid` when it has
 * no `id`, and {@link linkageOf} reads the identifiers a member's
 * relationships name (a `null`, empty, meta-only or links-only relationship
 * names none). A member with no identity at all can never be reached, so it
 * is always reported; a key the document does not include ends its branch. Of
 * two members with the same identity, the later one's linkage is the one
 * followed.
 *
 * @internal
 */
export const unlinkedIncluded = (document: Readonly<Record<string, unknown>>) => {
  const included = document["included"];
  if (!Array.isArray(included)) return [];
  const data = document["data"];
  const primaries = Array.isArray(data) ? Arr.filter(data, isRecord) : isRecord(data) ? [data] : [];
  const members = Arr.filter(included, isRecord);
  const byIdentity = HashMap.fromIterable(
    Arr.flatMap(members, (resource) =>
      Arr.map(
        Arr.fromOption(Option.fromUndefinedOr(identity(resource))),
        (key) => [key, resource] as const,
      ),
    ),
  );
  const linked = reachable(primarySeeds(primaries), (key) =>
    Option.match(HashMap.get(byIdentity, key), { onNone: () => [], onSome: linkageOf }),
  );
  return Arr.filter(members, (resource) =>
    Option.match(Option.fromUndefinedOr(identity(resource)), {
      onNone: () => true,
      onSome: (key) => !HashSet.has(linked, key),
    }),
  );
};
