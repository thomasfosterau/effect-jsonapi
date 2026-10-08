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
 *   `query` rides on `self` and is rejected without it;
 * - given a `meta` (#253), its document has `meta` typed as passed —
 *   required for an object type, optional for one `| undefined` — alongside
 *   `links` or without it, and still no `meta` member when none is passed.
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
// oxlint-disable-next-line effect/prefer-option-over-null -- the union under test: the type of a `self` the caller may not have
type MaybeSelf = string | undefined;
declare const optionalSelf: MaybeSelf;
const optionallyLinked = Assemble.unpaginatedCollection(people, {
  self: optionalSelf,
  query: pairs,
});
assertType<
  Equals<
    typeof optionallyLinked,
    Effect.Effect<
      Assemble.UnpaginatedCollectionDocument<Person, MaybeSelf>,
      Assemble.IncludeError,
      never
    >
  >
>(true);
declare const optionallyLinkedDocument: Assemble.UnpaginatedCollectionDocument<Person, MaybeSelf>;
assertType<MaybeSelf>(optionallyLinkedDocument.links?.self);
// @ts-expect-error — `links` may be absent
assertType<string>(optionallyLinkedDocument.links.self);

// The same `self` forwarded from the caller's own bare-optional option: under
// `exactOptionalPropertyTypes`, `o.self` reads as `string | undefined` and has
// to be accepted, with the same optional `links`.
declare const callerOptions: { readonly self?: string };
const forwarded = Assemble.unpaginatedCollection(people, {
  self: callerOptions.self,
  query: pairs,
});
assertType<
  Equals<
    typeof forwarded,
    Effect.Effect<
      Assemble.UnpaginatedCollectionDocument<Person, MaybeSelf>,
      Assemble.IncludeError,
      never
    >
  >
>(true);

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

// ── A top-level `meta`, when given, and only then ───────────────────

// The caller's own document-level metadata: not page math.
type Generated = { readonly generatedAt: string; readonly cache: "fresh" | "stale" };
declare const generated: Generated;
const stamped = Assemble.unpaginatedCollection(people, { meta: generated });
assertType<
  Equals<
    typeof stamped,
    Effect.Effect<
      Assemble.UnpaginatedCollectionDocument<Person, undefined, Generated>,
      Assemble.IncludeError,
      never
    >
  >
>(true);
declare const stampedDocument: Assemble.UnpaginatedCollectionDocument<Person, undefined, Generated>;
assertType<string>(stampedDocument.meta.generatedAt);
assertType<"fresh" | "stale">(stampedDocument.meta.cache);
// @ts-expect-error — `meta` is passed through as given: no `totalCount` appears
assertType<number>(stampedDocument.meta.totalCount);
// @ts-expect-error — a `meta` is not a `self`: still no top-level `links`
assertType<unknown>(stampedDocument.links);
// @ts-expect-error — nor is it a paginated document
assertType<Assemble.CollectionDocument<Person>>(stampedDocument);

// An object literal infers its widened type, as an annotation would spell it.
const literal = Assemble.unpaginatedCollection(people, { meta: { generatedAt: "now" } });
assertType<
  Equals<
    typeof literal,
    Effect.Effect<
      Assemble.UnpaginatedCollectionDocument<Person, undefined, { generatedAt: string }>,
      Assemble.IncludeError,
      never
    >
  >
>(true);

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
      Assemble.UnpaginatedCollectionDocument<Person, string, Generated>,
      Assemble.IncludeError,
      never
    >
  >
>(true);
declare const bothDocument: Assemble.UnpaginatedCollectionDocument<Person, string, Generated>;
assertType<string>(bothDocument.links.self);
assertType<string>(bothDocument.meta.generatedAt);

// A `meta` forwarded from the caller's own bare-optional option: under
// `exactOptionalPropertyTypes`, `o.meta` reads as `Generated | undefined` and
// has to be accepted; the document's `meta` is then optional.
declare const callerMeta: { readonly self?: string; readonly meta?: Generated };
// oxlint-disable-next-line effect/prefer-option-over-null -- the union under test: the type of a `meta` the caller may not have
type MaybeGenerated = Generated | undefined;
const forwardedMeta = Assemble.unpaginatedCollection(people, {
  self: callerMeta.self,
  meta: callerMeta.meta,
});
assertType<
  Equals<
    typeof forwardedMeta,
    Effect.Effect<
      Assemble.UnpaginatedCollectionDocument<Person, MaybeSelf, MaybeGenerated>,
      Assemble.IncludeError,
      never
    >
  >
>(true);
declare const forwardedMetaDocument: Assemble.UnpaginatedCollectionDocument<
  Person,
  MaybeSelf,
  MaybeGenerated
>;
assertType<MaybeGenerated>(forwardedMetaDocument.meta);
// @ts-expect-error — `meta` may be absent
assertType<string>(forwardedMetaDocument.meta.generatedAt);

// An explicit `undefined` is no `meta` at all.
const unstamped = Assemble.unpaginatedCollection(people, { meta: undefined });
assertType<
  Equals<
    typeof unstamped,
    Effect.Effect<Assemble.UnpaginatedCollectionDocument<Person>, Assemble.IncludeError, never>
  >
>(true);

// JSON:API `meta` is an object.
// @ts-expect-error — not an object
export const scalarMeta = Assemble.unpaginatedCollection(people, { meta: 1 });
// @ts-expect-error — `null` is not a `meta` either
export const nullMeta = Assemble.unpaginatedCollection(people, { meta: null });
