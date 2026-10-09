/**
 * Type-level tests for the `undeclaredMemberCap` option (#308).
 *
 *   - `Resource.make` and `Resource.extend` take it as `number | undefined`, so
 *     a caller can forward its own optional option (`exactOptionalPropertyTypes`
 *     is on), and refuse anything that isn't a number.
 *   - A definition reads it back as `number`, the resolved cap; `Resource.Any`
 *     carries it optionally, so a hand-rolled `Any` need not supply it.
 *
 * This file is type-checked by `tsconfig.test.json`; the `@ts-expect-error`
 * annotations are the assertions, each paired with the negative control that
 * shows the error is the option's and not the call's. Every binding is
 * exported so an unused-local error can never stand in for the assertion an
 * `@ts-expect-error` expects.
 */
import * as Schema from "effect/Schema";
import { Resource } from "@thomasfosterau/effect-jsonapi";

// Whether two types are identical (not merely mutually assignable).
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const attributes = { name: Schema.NonEmptyString };

// ---------------------------------------------------------------------------
// The option on `make` and `extend`
// ---------------------------------------------------------------------------

// The negative control: a number, and `Infinity`, are accepted.
export const Capped = Resource.make("capped", { attributes, undeclaredMemberCap: 50 });
export const Open = Resource.make("open", {
  attributes,
  undeclaredMemberCap: Number.POSITIVE_INFINITY,
});

// An explicit `undefined`, as a caller forwarding its own optional option.
export const forwarded = (cap?: number | undefined) =>
  Resource.make("forwarded", { attributes, undeclaredMemberCap: cap });

// @ts-expect-error -- the cap is a number, not a numeric string
export const stringCap = Resource.make("strings", { attributes, undeclaredMemberCap: "12" });

export const Extended = Resource.extend(Capped, "extended", { undeclaredMemberCap: 4 });
export const extendForwarded = (cap?: number | undefined) =>
  Resource.extend(Capped, "extended", { undeclaredMemberCap: cap });
// @ts-expect-error -- `extend` takes the same option, with the same type
export const extendString = Resource.extend(Capped, "extended", { undeclaredMemberCap: true });

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

export const resolved: Equals<typeof Capped.undeclaredMemberCap, number> = true;
export const inherited: Equals<typeof Extended.undeclaredMemberCap, number> = true;
export const onAny: Equals<Resource.Any["undeclaredMemberCap"], number | undefined> = true;
// @ts-expect-error -- a definition's cap is resolved: never `undefined`
export const neverUndefined: Equals<typeof Capped.undeclaredMemberCap, number | undefined> = true;
