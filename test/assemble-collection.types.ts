/**
 * Type-level tests for the two collection assemblers (#223):
 *
 * - `Assemble.collection` keeps its call shape and its return type exactly —
 *   `links` and `meta.totalCount` required;
 * - `Assemble.unpaginatedCollection` answers a document with **no** `links`
 *   and **no** `meta` member at all (absent, not optional), so a handler can't
 *   read page math off a document that has none, and the result is not
 *   mistakable for a paginated `CollectionDocument`;
 * - given a `self` (#242), its document has `links.self` — required for a
 *   `string`, optional for a `string | undefined` — and still no `meta`;
 *   `query` rides on `self` and is rejected without it.
 *
 * Type-checked by `tsconfig.json`; the `@ts-expect-error` annotations are the
 * assertions.
 */
import type { Effect } from "effect";
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
    Effect.Effect<Assemble.CollectionDocument<Person>, Assemble.IncludeError, never>
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
    Effect.Effect<Assemble.UnpaginatedCollectionDocument<Person>, Assemble.IncludeError, never>
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
      Assemble.UnpaginatedCollectionDocument<Person, string>,
      Assemble.IncludeError,
      never
    >
  >
>(true);
declare const linkedDocument: Assemble.UnpaginatedCollectionDocument<Person, string>;
assertType<string>(linkedDocument.links.self);
// @ts-expect-error — a `self` link is not page math: still no top-level `meta`
assertType<unknown>(linkedDocument.meta);
// @ts-expect-error — nor is it a paginated document
assertType<Assemble.CollectionDocument<Person>>(linkedDocument);

// A `self` the caller may not have (`exactOptionalPropertyTypes` threading):
// `links` is optional, so it has to be checked before it is read.
declare const optionalSelf: string | undefined;
const optionallyLinked = Assemble.unpaginatedCollection(people, {
  self: optionalSelf,
  query: pairs,
});
assertType<
  Equals<
    typeof optionallyLinked,
    Effect.Effect<
      Assemble.UnpaginatedCollectionDocument<Person, string | undefined>,
      Assemble.IncludeError,
      never
    >
  >
>(true);
declare const optionallyLinkedDocument: Assemble.UnpaginatedCollectionDocument<
  Person,
  string | undefined
>;
assertType<string | undefined>(optionallyLinkedDocument.links?.self);
// @ts-expect-error — `links` may be absent
assertType<string>(optionallyLinkedDocument.links.self);

// An explicit `undefined` is no `self` at all.
const unlinked = Assemble.unpaginatedCollection(people, { self: undefined });
assertType<
  Equals<
    typeof unlinked,
    Effect.Effect<Assemble.UnpaginatedCollectionDocument<Person>, Assemble.IncludeError, never>
  >
>(true);

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
