/**
 * Optional object members under `exactOptionalPropertyTypes`.
 *
 * @internal
 */
import * as Option from "effect/Option";
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

/**
 * The object {@link someMember} returns: `key` as an optional member.
 *
 * @internal
 */
export type SomeMember<K extends string, A> = {
  readonly [Prop in K]?: A;
};

/**
 * `{ [key]: value }` when `value` is `Some`, and an object with no member at
 * all when it is `None`: the {@link definedMember} of an `Option`.
 *
 * @internal
 */
export const someMember = <const K extends string, A>(
  key: K,
  value: Option.Option<A>,
): SomeMember<K, A> => {
  const member: { [Prop in K]?: A } = {};
  if (Option.isSome(value)) member[key] = value.value;
  return member;
};
