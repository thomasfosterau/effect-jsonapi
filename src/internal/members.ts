/**
 * Optional object members under `exactOptionalPropertyTypes`.
 *
 * @internal
 */
import * as Predicate from "effect/Predicate";

/**
 * The object {@link definedMember} returns: `key` as an optional member that,
 * when present, is never `undefined`.
 *
 * @internal
 */
export type DefinedMember<K extends string, A> = {
  readonly [P in K]?: Exclude<A, undefined>;
};

/**
 * `{ [key]: value }` when `value` is defined, and an object with no member at
 * all when it is `undefined`: spread it to add a member only when it is
 * present, so the built object never carries a member set to `undefined`.
 *
 * @internal
 */
export const definedMember = <const K extends string, A>(key: K, value: A): DefinedMember<K, A> => {
  const member: { [P in K]?: Exclude<A, undefined> } = {};
  if (Predicate.isNotUndefined(value)) member[key] = value;
  return member;
};
