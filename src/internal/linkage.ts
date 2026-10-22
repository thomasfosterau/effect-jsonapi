/**
 * The compound-document reachability walk behind the spec's full-linkage
 * rule: an `included` member is linked when it can be reached from the
 * primary data by following resource linkage, through the primary data's
 * relationships and then through other `included` members'. When the primary
 * data is itself resource linkage (a relationship document's identifiers),
 * those identifiers are where the walk starts ({@link seeds}, #423).
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

// A resource object's identity as zero or one keys.
const identities = (resource: Parameters<typeof identity>[0]): ReadonlyArray<string> =>
  Arr.fromOption(Option.fromUndefinedOr(identity(resource)));

/**
 * Whether a primary-data element is a resource identifier object rather than
 * a resource object: it carries none of the members only a resource object
 * may (`attributes`, `relationships`, `links`).
 *
 * @internal
 */
export const isIdentifierObject = (value: {
  readonly attributes?: unknown;
  readonly relationships?: unknown;
  readonly links?: unknown;
}): boolean => !("attributes" in value) && !("relationships" in value) && !("links" in value);

/**
 * Whether a document's primary data, as its elements, is resource linkage — a
 * relationship document's (§Fetching Relationships): at least one element,
 * every one an identifier object ({@link isIdentifierObject}). Empty or
 * `null` primary data seeds nothing either way, so it is read as resources.
 *
 * A resource object carrying only `type` and `id` (and perhaps `meta`) cannot
 * be told from an identifier, so primary data made only of such objects reads
 * as linkage. Seeding from it links only an `included` copy of that same
 * resource, which a resource document may not carry anyway (§Compound
 * Documents' one resource object per `type` and `id`).
 *
 * @internal
 */
export const isLinkageData = (
  primaries: ReadonlyArray<Parameters<typeof isIdentifierObject>[0]>,
): boolean => Arr.isReadonlyArrayNonEmpty(primaries) && Arr.every(primaries, isIdentifierObject);

/**
 * Where the full-linkage walk starts (JSON:API 1.1 §Compound Documents): the
 * identifiers in the primary resources' relationships, or, when the primary
 * data is resource linkage, the primary identifiers themselves (#423) — an
 * identifier carries no relationships, so it would otherwise seed nothing.
 * `keyOf` and `linkageOf` are the caller's notion of identity and of edges,
 * as for {@link reachable}.
 *
 * @internal
 */
export const seeds = <A>(
  primaries: ReadonlyArray<A>,
  asLinkage: boolean,
  keyOf: (primary: A) => Iterable<string>,
  linkageOf: (primary: A) => Iterable<string>,
): ReadonlyArray<string> =>
  Arr.flatMap(primaries, (primary) => Arr.fromIterable((asLinkage ? keyOf : linkageOf)(primary)));

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
  const take = (value: Parameters<typeof identity>[0]): void => {
    const key = identity(value);
    if (key !== undefined) out.push(key);
  };
  for (const name of Object.keys(relationships)) {
    const relationship = relationships[name];
    if (!isRecord(relationship)) continue;
    const data = relationship["data"];
    if (Array.isArray(data)) data.filter(isRecord).forEach(take);
    else if (isRecord(data)) take(data);
  }
  return out;
};

/**
 * The `included` members of a JSON document that cannot be reached from its
 * primary data through resource linkage, in document order — the violations
 * `spec/document/full-linkage` reports.
 *
 * The walk is the builders' ({@link reachable} from {@link seeds}, shared so
 * the two cannot drift apart): from the primary identifiers when the primary
 * data is resource linkage ({@link isLinkageData}), else from the primary
 * resources' relationships. Identity and linkage are over arbitrary JSON:
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
      Arr.map(identities(resource), (key) => [key, resource] as const),
    ),
  );
  const start = seeds(primaries, isLinkageData(primaries), identities, linkageOf);
  const linked = reachable(start, (key) =>
    Option.match(HashMap.get(byIdentity, key), { onNone: () => [], onSome: linkageOf }),
  );
  return Arr.filter(members, (resource) =>
    Option.match(Option.fromUndefinedOr(identity(resource)), {
      onNone: () => true,
      onSome: (key) => !HashSet.has(linked, key),
    }),
  );
};
