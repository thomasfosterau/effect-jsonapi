/**
 * Type-level tests for the document builders' per-resource transform pass
 * (`onResource`).
 *
 * The point of the encoding is that a transform's effect on the document is
 * *visible in the type* rather than erased to a wide `ResourceValue`, and that
 * it is the **same** effect in every slot: the primary `data`, every
 * `included` member, and a linkage document's resource identifiers. A sparse
 * fieldset that projects the primary article but not the included one is the
 * bug this file exists to catch at compile time.
 *
 * This file is type-checked by `tsconfig.test.json`; the `@ts-expect-error`
 * annotations are the assertions. Every binding is exported so an unused-local
 * error can never stand in for the assertion an `@ts-expect-error` expects.
 */
import { Schema } from "effect";
import { Handlers, Query, Relationship, Resource } from "@thomasfosterau/effect-jsonapi";

// Asserts that a value is assignable to `Expected`.
const assertType = <Expected>(_value: Expected): void => {};

// Whether two types are identical, not merely mutually assignable.
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const Person = Resource.make("people", {
  attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString },
});

const Article = Resource.make("articles", {
  attributes: { title: Schema.NonEmptyString, body: Schema.String },
  relationships: { author: Relationship.one(() => Person) },
});

declare const article: typeof Article.Type;
// A second article, landing in `included` — so one document carries the type
// "articles" in *both* slots, which is the case the transform pass exists for.
// (Full linkage is a runtime rule; this file is only ever type-checked.)
declare const related: typeof Article.Type;
declare const person: typeof Person.Type;

// ---------------------------------------------------------------------------
// No transform: the builders' types are exactly what they always were
// ---------------------------------------------------------------------------

const plain = Handlers.data(article, { included: [related, person] });
assertType<string>(plain.data.attributes.title);
assertType<string>(plain.data.attributes.body);

const plainIdentity: Equals<typeof plain.data, typeof Article.Type> = true;

// A hand-written transform is checked against the identity lambda: it may
// reshape values, but it must hand back the resource's own type.
const untouched = Handlers.data(article, { onResource: (resource) => resource });
const untouchedIdentity: Equals<typeof untouched.data, typeof Article.Type> = true;

// @ts-expect-error -- a transform that widens the shape is not identity-typed
Handlers.data(article, { onResource: (resource) => ({ type: resource.type, id: resource.id }) });

// ---------------------------------------------------------------------------
// A literal fieldset projects exactly, in every slot
// ---------------------------------------------------------------------------

const projected = Handlers.data(article, {
  included: [related, person],
  onResource: Handlers.project({ articles: ["title"] }),
});

assertType<string>(projected.data.attributes.title);
// @ts-expect-error -- `body` was projected off the primary article
assertType<string>(projected.data.attributes.body);

declare const projectedIncluded: NonNullable<typeof projected.included>[number];
// The included article is shaped identically to the primary one: `title` only.
if (projectedIncluded.type === "articles") {
  assertType<string>(projectedIncluded.attributes.title);
  // @ts-expect-error -- …and `body` is gone here too. This is the regression.
  assertType<string>(projectedIncluded.attributes.body);
}

// Stated as an equality, which is the whole claim of the issue: one type, one
// shape, wherever in the document it lands.
type PrimaryArticle = (typeof projected)["data"];
type IncludedArticle = Extract<
  NonNullable<(typeof projected)["included"]>[number],
  { readonly type: "articles" }
>;
const sameShape: Equals<PrimaryArticle["attributes"], IncludedArticle["attributes"]> = true;

// A type with no requested set is untouched, in either slot.
declare const projectedPerson: Extract<
  NonNullable<(typeof projected)["included"]>[number],
  { readonly type: "people" }
>;
assertType<string>(projectedPerson.attributes.firstName);
assertType<string>(projectedPerson.attributes.lastName);

// …and the transform is not erased: `relationships` survives the projection.
assertType<{ readonly type: "people"; readonly id: string } | undefined>(
  projected.data.relationships?.author.data,
);

// ---------------------------------------------------------------------------
// An empty literal fieldset (`?fields[articles]=`) selects no attribute (#488)
// ---------------------------------------------------------------------------

const none = Handlers.data(article, { onResource: Handlers.project({ articles: [] }) });
const noneAttributes: Equals<(typeof none)["data"]["attributes"], Record<never, never>> = true;
// @ts-expect-error -- `title` was projected off with every other attribute
assertType<string>(none.data.attributes.title);
// `relationships` is kept, as at runtime.
assertType<{ readonly type: "people"; readonly id: string } | undefined>(
  none.data.relationships?.author.data,
);
// A type with no set at all (`undefined`) is untouched, as at runtime.
const unset = Handlers.project(article, { articles: undefined });
const unsetIdentity: Equals<typeof unset, typeof Article.Type> = true;

// ---------------------------------------------------------------------------
// A fieldset only known at runtime projects to an honest *subset*
// ---------------------------------------------------------------------------

const listQuery = Query.schema(Article, { fields: true });
declare const query: typeof listQuery.Type;

const dynamic = Handlers.data(article, {
  included: [related],
  onResource: Handlers.project(query.fields),
});

// Which of the selectable names came back is a runtime fact, so each is
// optional — not a lie in either direction.
const dynamicAttributes: Equals<
  (typeof dynamic)["data"]["attributes"],
  { readonly title?: string; readonly body?: string }
> = true;
// @ts-expect-error -- and not asserted present
assertType<string>(dynamic.data.attributes.title);
// the same shape on the included side
const dynamicSameShape: Equals<
  (typeof dynamic)["data"]["attributes"],
  NonNullable<(typeof dynamic)["included"]>[number]["attributes"]
> = true;

// ---------------------------------------------------------------------------
// withMeta / compose
// ---------------------------------------------------------------------------

const stamped = Handlers.data(article, {
  included: [related],
  onResource: Handlers.withMeta((resource) => ({ href: `/${resource.type}/${resource.id}` })),
});
assertType<string | undefined>(stamped.data.meta?.href);
// @ts-expect-error -- only the members the computation declares are there
assertType<string | undefined>(stamped.data.meta?.nope);
// the attributes are untouched by a meta stamp
assertType<string>(stamped.data.attributes.body);

const composed = Handlers.data(article, {
  included: [related],
  onResource: Handlers.compose(
    Handlers.project({ articles: ["title"] }),
    Handlers.withMeta(() => ({ canEdit: true })),
  ),
});

// Both effects are visible, and both apply in both slots.
assertType<string>(composed.data.attributes.title);
assertType<boolean | undefined>(composed.data.meta?.canEdit);
// @ts-expect-error -- projected away by the first half of the composition
assertType<string>(composed.data.attributes.body);

declare const composedIncluded: NonNullable<(typeof composed)["included"]>[number];
assertType<string>(composedIncluded.attributes.title);
assertType<boolean | undefined>(composedIncluded.meta?.canEdit);
// @ts-expect-error -- …identically
assertType<string>(composedIncluded.attributes.body);

// ---------------------------------------------------------------------------
// Collections, nullable primary data, and linkage documents
// ---------------------------------------------------------------------------

const page = Handlers.collection([article], {
  included: [related],
  onResource: Handlers.project({ articles: ["title"] }),
});
const pageSameShape: Equals<
  (typeof page)["data"][number]["attributes"],
  NonNullable<(typeof page)["included"]>[number]["attributes"]
> = true;
// @ts-expect-error -- projected in `data` too, not only in `included`
assertType<string>(page.data[0]!.attributes.body);

// A null primary has no resource to transform, and stays null.
const empty = Handlers.data(null, { onResource: Handlers.project({ articles: ["title"] }) });
const emptyIsNull: Equals<(typeof empty)["data"], null> = true;

// A relationship document's identifiers go through the same pass.
const linkage = Handlers.linkage([{ type: "comments" as const, id: "5" }], {
  onResource: Handlers.withMeta(() => ({ canEdit: true })),
});
assertType<boolean | undefined>(linkage.data[0].meta?.canEdit);
assertType<"comments">(linkage.data[0].type);

const emptyLinkage = Handlers.linkage(null, {
  onResource: Handlers.withMeta(() => ({ canEdit: true })),
});
const emptyLinkageIsNull: Equals<(typeof emptyLinkage)["data"], null> = true;

// ---------------------------------------------------------------------------
// The type-level primitives, used directly
// ---------------------------------------------------------------------------

// The identity lambda really is identity.
const identityApplies: Equals<
  Handlers.Transformed<Handlers.IdentityLambda, typeof Article.Type>,
  typeof Article.Type
> = true;

// A hand-declared lambda, applied through `Handlers.transform`.
interface SelfLinkLambda extends Handlers.TransformLambda {
  readonly Out: this["In"] & { readonly links: { readonly self: string } };
}
const withSelfLink = Handlers.transform<SelfLinkLambda>((resource) => ({
  ...resource,
  links: { self: `/${resource.type}/${resource.id}` },
}));
const linked = Handlers.data(article, { included: [related], onResource: withSelfLink });
assertType<string>(linked.data.links.self);
assertType<string>(linked.data.attributes.body);
assertType<string>(linked.included![0]!.links.self);
// @ts-expect-error -- the lambda declares `self`, and nothing else
assertType<string>(linked.data.links.related);

export {
  composed,
  composedIncluded,
  dynamic,
  dynamicAttributes,
  dynamicSameShape,
  empty,
  emptyIsNull,
  emptyLinkage,
  emptyLinkageIsNull,
  identityApplies,
  linkage,
  linked,
  none,
  noneAttributes,
  page,
  pageSameShape,
  plain,
  plainIdentity,
  projected,
  projectedIncluded,
  projectedPerson,
  sameShape,
  stamped,
  unset,
  unsetIdentity,
  untouched,
  untouchedIdentity,
  withSelfLink,
};
