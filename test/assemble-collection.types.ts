/**
 * Type-level tests for the two collection assemblers (#223):
 *
 * - `Assemble.collection` keeps its call shape and its return type exactly —
 *   `links` and `meta.totalCount` required;
 * - `Assemble.unpaginatedCollection` answers a document with **no** `links`
 *   and **no** `meta` member at all (absent, not optional), so a handler can't
 *   read page math off a document that has none, and the result is not
 *   mistakable for a paginated `CollectionDocument`;
 * - given a `self` (#242), its document has a required `links.self` and still
 *   no `meta`; `query` rides on `self` and is rejected without it;
 * - given a `meta` (#253), its document has `meta` typed as passed and
 *   required, alongside `links` or without it, and still no `meta` member
 *   when none is passed;
 * - a `self` or `meta` that may be `undefined`, or is explicitly `undefined`,
 *   is rejected (#533): the absent sentinel is `never`, and the key is
 *   passed only when it is defined.
 *
 * Type-checked by `tsconfig.json`; the `@ts-expect-error` annotations are the
 * assertions.
 */
import type * as Effect from "effect/Effect";
import { Assemble, Handlers } from "@thomasfosterau/effect-jsonapi";
import type { Query } from "@thomasfosterau/effect-jsonapi";

/** Pins a value to an expected type without using it (`noUnusedLocals`). */
const assertType = <Expected>(_value: Expected): void => {};

// Whether two types are identical, not merely mutually assignable.
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

interface Person extends Assemble.ResourceLike {
  readonly type: "people";
  readonly attributes: { readonly name: string };
}
declare const people: ReadonlyArray<Person>;
const pagination = { totalCount: 3, offset: 0, limit: 10, baseUrl: "https://example.test/people" };

// ── The paginated form is unchanged ─────────────────────────────────

const paged = Assemble.collection(people, pagination);
assertType<
  Equals<
    typeof paged,
    Effect.Effect<Assemble.CollectionDocument<Person, never>, Assemble.IncludeError>
  >
>(true);
declare const pagedDocument: Assemble.CollectionDocument<Person>;
assertType<Handlers.LinksValue>(pagedDocument.links);
assertType<number>(pagedDocument.meta.totalCount);
// `pagination` is still required.
// @ts-expect-error — the paginated form takes its page math
export const missingPagination = Assemble.collection(people);

// ── The unpaginated form has no page math ───────────────────────────

const whole = Assemble.unpaginatedCollection(people, { include: [], includable: [] });
assertType<
  Equals<
    typeof whole,
    Effect.Effect<
      Assemble.UnpaginatedCollectionDocument<Person, never, never, never>,
      Assemble.IncludeError
    >
  >
>(true);
declare const wholeDocument: Assemble.UnpaginatedCollectionDocument<Person>;
assertType<ReadonlyArray<{ readonly type: "people"; readonly id: string }>>(wholeDocument.data);
assertType<ReadonlyArray<Assemble.WireResource<Assemble.ResourceLike>>>(
  wholeDocument.included ?? [],
);
assertType<{ readonly version: "1.1" }>(wholeDocument.jsonapi);
// @ts-expect-error — no top-level `links`: there are no pages to link
assertType<unknown>(wholeDocument.links);
// @ts-expect-error — no top-level `meta`, so no `meta.totalCount`
assertType<unknown>(wholeDocument.meta);
// @ts-expect-error — not a paginated document: `links` and `meta` are missing
assertType<Assemble.CollectionDocument<Person>>(wholeDocument);
// Page math is not an option of the unpaginated form.
// @ts-expect-error — `totalCount` is not an `UnpaginatedCollectionOptions` member
export const withPageMath = Assemble.unpaginatedCollection(people, { totalCount: 3 });

// ── A `self` link, when given, and only then ────────────────────────

declare const pairs: ReadonlyArray<Query.Pair>;
const linked = Assemble.unpaginatedCollection(people, {
  self: "https://example.test/people",
  query: pairs,
});
// A literal `self` widens to `string`: the document type doesn't carry the URL.
assertType<
  Equals<
    typeof linked,
    Effect.Effect<
      Assemble.UnpaginatedCollectionDocument<Person, string, never, never>,
      Assemble.IncludeError
    >
  >
>(true);
declare const linkedDocument: Assemble.UnpaginatedCollectionDocument<Person, string>;
assertType<string>(linkedDocument.links.self);
// @ts-expect-error — a `self` link is not page math: still no top-level `meta`
assertType<unknown>(linkedDocument.meta);
// @ts-expect-error — nor is it a paginated document
assertType<Assemble.CollectionDocument<Person>>(linkedDocument);

// A `self` the caller may not have is passed only when it is defined: the
// option takes no explicit `undefined` (#533), so a maybe-`undefined` value —
// a caller's own bare-optional `o.self` under `exactOptionalPropertyTypes` —
// is rejected rather than read as "maybe linked".
declare const callerOptions: { readonly self?: string };
// @ts-expect-error — `self` takes a string, not `string | undefined`
export const forwarded = Assemble.unpaginatedCollection(people, { self: callerOptions.self });
// @ts-expect-error — nor an explicit `undefined`: omit the key
export const unlinked = Assemble.unpaginatedCollection(people, { self: undefined });
// The idiomatic forward passes the key only when it is defined.
export const branched =
  callerOptions.self === undefined
    ? Assemble.unpaginatedCollection(people)
    : Assemble.unpaginatedCollection(people, { self: callerOptions.self, query: pairs });

// `query` is carried on `self`: with no `self` there is nothing to carry it.
// @ts-expect-error — `query` without `self`
export const queryWithoutSelf = Assemble.unpaginatedCollection(people, { query: pairs });
// @ts-expect-error — `self` is a string URL
export const nonStringSelf = Assemble.unpaginatedCollection(people, { self: 1 });

// ── Both share the include walk's requirements and errors ───────────

declare const places: Handlers.IncludeTarget<
  Handlers.ResourceValue,
  "PlacesUnavailable",
  "PlacesDb"
>;
const walked = Assemble.unpaginatedCollection(people, {
  include: ["birthPlace"],
  includable: ["birthPlace"],
  targets: { places },
});
assertType<
  Equals<
    typeof walked,
    Effect.Effect<
      Assemble.UnpaginatedCollectionDocument<Person>,
      Assemble.IncludeError | "PlacesUnavailable",
      "PlacesDb"
    >
  >
>(true);

// ── A top-level `meta`, when given, and only then ───────────────────

// The caller's own document-level metadata: not page math.
type Generated = { readonly generatedAt: string; readonly cache: "fresh" | "stale" };
declare const generated: Generated;
const stamped = Assemble.unpaginatedCollection(people, { meta: generated });
assertType<
  Equals<
    typeof stamped,
    Effect.Effect<
      Assemble.UnpaginatedCollectionDocument<Person, never, Generated, never>,
      Assemble.IncludeError
    >
  >
>(true);
declare const stampedDocument: Assemble.UnpaginatedCollectionDocument<Person, never, Generated>;
assertType<string>(stampedDocument.meta.generatedAt);
assertType<"fresh" | "stale">(stampedDocument.meta.cache);
// @ts-expect-error — `meta` is passed through as given: no `totalCount` appears
assertType<number>(stampedDocument.meta.totalCount);
// @ts-expect-error — a `meta` is not a `self`: still no top-level `links`
assertType<unknown>(stampedDocument.links);
// @ts-expect-error — nor is it a paginated document
assertType<Assemble.CollectionDocument<Person>>(stampedDocument);

// An object literal keeps its literal type (`M` is `const`, as on
// `Handlers.collection`): the document emits that very value, so the type is
// truthful — unlike `self`, which is a switch and always types as `string`.
const literal = Assemble.unpaginatedCollection(people, { meta: { generatedAt: "now" } });
assertType<
  Equals<
    typeof literal,
    Effect.Effect<
      Assemble.UnpaginatedCollectionDocument<Person, never, { readonly generatedAt: "now" }, never>,
      Assemble.IncludeError
    >
  >
>(true);

// …so a document assembled from a literal `meta` still fits a document type
// declared with a union member, which a widened `{ cache: string }` would not.
declare const generatedAt: string;
const fresh = Assemble.unpaginatedCollection(people, { meta: { generatedAt, cache: "fresh" } });
export const cached: Effect.Effect<
  Assemble.UnpaginatedCollectionDocument<Person, never, Generated>,
  Assemble.IncludeError
> = fresh;

// Alongside a `self` link: both members, each typed as passed.
const both = Assemble.unpaginatedCollection(people, {
  self: "https://example.test/people",
  query: pairs,
  meta: generated,
});
assertType<
  Equals<
    typeof both,
    Effect.Effect<
      Assemble.UnpaginatedCollectionDocument<Person, string, Generated, never>,
      Assemble.IncludeError
    >
  >
>(true);
declare const bothDocument: Assemble.UnpaginatedCollectionDocument<Person, string, Generated>;
assertType<string>(bothDocument.links.self);
assertType<string>(bothDocument.meta.generatedAt);

// A `meta` the caller may not have is likewise passed only when it is defined.
declare const callerMeta: { readonly meta?: Generated };
// @ts-expect-error — `meta` takes an object, not `Generated | undefined`
export const forwardedMeta = Assemble.unpaginatedCollection(people, { meta: callerMeta.meta });
// @ts-expect-error — nor an explicit `undefined`: omit the key
export const unstamped = Assemble.unpaginatedCollection(people, { meta: undefined });

// JSON:API `meta` is an object.
// @ts-expect-error — not an object
export const scalarMeta = Assemble.unpaginatedCollection(people, { meta: 1 });
// @ts-expect-error — `null` is not a `meta` either
export const nullMeta = Assemble.unpaginatedCollection(people, { meta: null });
