/**
 * Optional object members under `exactOptionalPropertyTypes`.
 *
 * @internal
 */
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import type { AnyResourceValue, MetaValue } from "../Handlers.js";

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

/**
 * `resource` with `computed` merged over its own `meta`. A merged `meta`
 * with no member is dropped whole: to the spec an empty `meta` object is a
 * present-but-empty meta, a different statement from having none. The one
 * implementation behind `Handlers.withMeta` and the assembler's capability
 * stamp, which calls it directly so a resource it does not stamp costs no
 * `Option`.
 *
 * @internal
 */
export const stampMeta = (resource: AnyResourceValue, computed?: MetaValue): AnyResourceValue => {
  const merged = { ...resource.meta, ...computed };
  if (Arr.isReadonlyArrayNonEmpty(R.keys(merged))) return { ...resource, meta: merged };
  if (resource.meta === undefined) return resource;
  const { meta: _meta, ...rest } = resource;
  return rest;
};
