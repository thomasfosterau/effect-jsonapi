/**
 * The compound-document reachability walk behind the spec's full-linkage
 * rule: an `included` member is linked when it can be reached from the
 * primary data by following resource linkage, through the primary data's
 * relationships and then through other `included` members'.
 *
 * It works on string keys, not on resource values, so the document builders
 * (typed values) and a checker over arbitrary JSON can walk the same graph
 * with their own notion of identity and linkage.
 *
 * @internal
 */
import * as Arr from "effect/Array";
import * as HashSet from "effect/HashSet";

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
