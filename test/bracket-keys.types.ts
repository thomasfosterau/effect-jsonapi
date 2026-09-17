/**
 * Type-level tests for `Query.bracketKeys`: the general form of
 * `Query.bracketPageKeys` that renames an arbitrary set of a flat struct's
 * encoded keys under an arbitrary prefix, and composes when piped more than
 * once onto the same struct.
 *
 * The risk this file guards against: a combinator that *type-checks* when
 * piped twice but silently widens to `Schema.Top` (or `any`) is a regression
 * even though nothing throws at runtime — the whole point of building this on
 * `Schema` is that call sites keep precise types. `Equals` (not mere
 * assignability) is what would catch that widening; `expectExact` below wires
 * a `@ts-expect-error` negative control confirming `Equals` itself still
 * fails on a real mismatch, so a passing `Equals` assertion elsewhere in this
 * file is not vacuously true.
 *
 * This file is type-checked by `tsconfig.test.json`; the `@ts-expect-error`
 * annotations are the assertions.
 */
import { Schema } from "effect"
import { Query } from "@thomasfosterau/effect-jsonapi"

// Whether two types are identical (not merely mutually assignable) — see
// `attribute-projections.types.ts` for why plain assignability isn't enough.
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

// Asserts that a value is assignable to `Expected`.
const assertType = <Expected>(_value: Expected): void => {}

// Negative control for `Equals` itself: two genuinely different types must
// *not* compare equal, so a passing `Equals<A, B> = true` assertion elsewhere
// in this file is evidence of a real match, not a vacuous helper.
const equalsCatchesMismatch: Equals<{ readonly a: string }, { readonly a: string; readonly b: number }> = false
// @ts-expect-error -- the two shapes above are not the same type
const equalsWouldWronglyPass: Equals<{ readonly a: string }, { readonly a: string; readonly b: number }> = true

// A flat list input: pagination and two application filters merged alongside
// each other — the shape `bracketKeys` exists for.
const ListArticles = Schema.Struct({
  ...Query.Page.offset({ maxLimit: 100, fromString: false }),
  authorId: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String)
})

// ---------------------------------------------------------------------------
// A single `bracketKeys` call: the decoded type is untouched, the encoded
// type has exactly the bracketed keys and nothing wider.
// ---------------------------------------------------------------------------

const wireOnce = ListArticles.pipe(Query.bracketKeys("page", ["offset", "limit"]))

const onceTypeUnchanged: Equals<typeof wireOnce.Type, typeof ListArticles.Type> = true
const onceEncodedIsExact: Equals<
  typeof wireOnce.Encoded,
  {
    readonly "page[offset]"?: number
    readonly "page[limit]"?: number
    readonly authorId?: string
    readonly status?: string
  }
> = true

// ---------------------------------------------------------------------------
// Composition: two `bracketKeys` calls piped onto the same struct must yield
// a type reflecting BOTH renames — the crux of the issue this combinator
// closes. A widened result (`Schema.Top`, `any`, or only the last rename)
// would make the `Equals` assertions below fail to type-check.
// ---------------------------------------------------------------------------

const wireComposed = ListArticles.pipe(
  Query.bracketKeys("page", ["offset", "limit"]),
  Query.bracketKeys("filter", ["authorId", "status"])
)

// The decoded type still reflects the original flat struct exactly.
const composedTypeUnchanged: Equals<typeof wireComposed.Type, typeof ListArticles.Type> = true

// The encoded type carries every rename from every call, and only those.
const composedEncodedIsExact: Equals<
  typeof wireComposed.Encoded,
  {
    readonly "page[offset]"?: number
    readonly "page[limit]"?: number
    readonly "filter[authorId]"?: string
    readonly "filter[status]"?: string
  }
> = true

// The regression this whole file is pinning: a combinator that merely
// type-checks but collapses composition into `Schema.Top` would make the
// encoded type `unknown`-shaped instead of the exact record above.
const composedEncodedIsNotTop: Equals<typeof wireComposed.Encoded, unknown> = false

// A round-tripped value carries both families; the compiler accepts exactly
// this shape and no other.
const encoded: typeof wireComposed.Encoded = {
  "page[offset]": 20,
  "page[limit]": 10,
  "filter[authorId]": "9",
  "filter[status]": "open"
}
assertType<typeof wireComposed.Encoded>(encoded)
// @ts-expect-error -- "offset" is not a valid encoded key once bracketed; only "page[offset]" is
const badEncoded: typeof wireComposed.Encoded = { offset: 20, "page[limit]": 10 }

// ---------------------------------------------------------------------------
// A key outside the base struct's fields is a compile error, whichever call
// (first or composed) supplies it — the general combinator only renames keys
// the struct actually has.
// ---------------------------------------------------------------------------

// @ts-expect-error -- "bogus" is not a field of `ListArticles`
ListArticles.pipe(Query.bracketKeys("page", ["bogus"]))

// @ts-expect-error -- "bogus" is not a field of `ListArticles` even as the second call in a composition
ListArticles.pipe(Query.bracketKeys("page", ["offset", "limit"]), Query.bracketKeys("filter", ["bogus"]))

export {
  badEncoded,
  composedEncodedIsExact,
  composedEncodedIsNotTop,
  composedTypeUnchanged,
  encoded,
  equalsCatchesMismatch,
  equalsWouldWronglyPass,
  onceEncodedIsExact,
  onceTypeUnchanged,
  wireComposed,
  wireOnce
}
