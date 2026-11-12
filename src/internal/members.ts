/**
 * Optional object members under `exactOptionalPropertyTypes`.
 *
 * @internal
 */
import * as P from "effect/Predicate";

/**
 * The object {@link definedMember} returns: `key` as an optional member that,
 * when present, is never `undefined`.
 *
 * @internal
 */
export type DefinedMember<K extends string, A> = {
  readonly [Prop in K]?: Exclude<A, undefined>;
};

/**
 * `{ [key]: value }` when `value` is defined, and an object with no member at
 * all when it is `undefined`: spread it to add a member only when it is
 * present, so the built object never carries a member set to `undefined`.
 *
 * @internal
 */
export const definedMember = <const K extends string, A>(key: K, value: A): DefinedMember<K, A> => {
  const member: { [Prop in K]?: Exclude<A, undefined> } = {};
  if (P.isNotUndefined(value)) member[key] = value;
  return member;
};
