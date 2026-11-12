/**
 * Type-level tests for the "absent" sentinel of the generic option parameters
 * (#533, `effect/prefer-option-over-null`, 2 of 6): an option a caller leaves
 * out defaults its type parameter to `never`, which the type machinery tests
 * with `[X] extends [never]`. Spelled `undefined` before.
 *
 * Two halves:
 *
 * - **Inference is unchanged.** Omitting an option still derives the shapes it
 *   derived when the sentinel was `undefined` — the query parameters, the
 *   `included` union, the id, the `clearable` flag — and giving it still
 *   derives the given shape.
 * - **An explicit `undefined` is rejected.** Neither as a type argument nor as
 *   an option value does `undefined` stand for "absent" any more; each is a
 *   compile error at the call, never silently read as a given value. Omit the
 *   key (or the type argument), or pass `never` as the type argument.
 *
 * This file is type-checked by `tsconfig.json`; the `@ts-expect-error`
 * annotations are the assertions, each paired with a positive control.
 */
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import type { HttpApiEndpoint } from "effect/http-api";
import {
  Endpoint,
  FlatQuery,
  Group,
  Handlers,
  Idempotency,
  Include,
  Query,
  Relationship,
  Resource,
} from "@thomasfosterau/effect-jsonapi";
import type { Id } from "@thomasfosterau/effect-jsonapi/Resource";

const Person = Resource.make("people", { attributes: { name: Schema.String } });
const Comment = Resource.make("comments", {
  attributes: { body: Schema.String },
  relationships: { author: Relationship.one(() => Person) },
});
const Article = Resource.make("articles", {
  attributes: {
    title: Resource.attribute(Schema.String, { filter: ["eq"], sort: true }),
    body: Schema.String,
  },
  relationships: {
    author: Relationship.one(() => Person),
    comments: Relationship.many(() => Comment),
  },
});

type QueryOf<E> = HttpApiEndpoint.Query<E>["Type"];
type QueryKeys<E> = keyof HttpApiEndpoint.Query<E>["Type"];
type Paged = { readonly page?: { readonly offset?: number; readonly limit?: number } };
type PagedSearched = {
  readonly page?: { readonly offset?: number; readonly limit?: number };
  readonly filter?: { readonly q?: string };
};
const q = Schema.optionalKey(Schema.String);

// ---------------------------------------------------------------------------
// Endpoint.list — `page` / `filter`
// ---------------------------------------------------------------------------

const bareList = Endpoint.list(Article);
export const bareListQuery: Types.Equals<QueryKeys<typeof bareList>, never> = true;

const pagedList = Endpoint.list(Article, { page: Query.Page.Offset, filter: { q } });
export const pagedListQuery: Types.Equals<QueryOf<typeof pagedList>, PagedSearched> = true;

// `filter: true` is the grammar, and `never` is not mistaken for it.
const grammarList = Endpoint.list(Article, { filter: true });
export const grammarListQuery: Types.Equals<QueryKeys<typeof grammarList>, "filter"> = true;

// @ts-expect-error an explicit `undefined` page is no longer "absent": omit the key
export const undefinedPage = Endpoint.list(Article, { page: undefined });
// @ts-expect-error likewise `filter`
export const undefinedFilter = Endpoint.list(Article, { filter: undefined });

// ---------------------------------------------------------------------------
// Endpoint.collection / related / getRelationship
// ---------------------------------------------------------------------------

const bareCollection = Endpoint.collection([Article, Comment], { name: "feed", path: "/feed" });
export const bareCollectionQuery: Types.Equals<QueryKeys<typeof bareCollection>, never> = true;
const pagedCollection = Endpoint.collection([Article, Comment], {
  name: "feed",
  path: "/feed",
  page: Query.Page.Offset,
  filter: { q },
});
export const pagedCollectionQuery: Types.Equals<
  QueryOf<typeof pagedCollection>,
  PagedSearched
> = true;

const bareRelated = Endpoint.related(Article, "comments");
export const bareRelatedQuery: Types.Equals<QueryKeys<typeof bareRelated>, never> = true;
const pagedRelated = Endpoint.related(Article, "comments", {
  page: Query.Page.Offset,
  filter: { q },
});
export const pagedRelatedQuery: Types.Equals<QueryOf<typeof pagedRelated>, PagedSearched> = true;

const bareLinkage = Endpoint.getRelationship(Article, "comments");
export const bareLinkageQuery: Types.Equals<QueryKeys<typeof bareLinkage>, never> = true;
const pagedLinkage = Endpoint.getRelationship(Article, "comments", { page: Query.Page.Offset });
export const pagedLinkageQuery: Types.Equals<QueryOf<typeof pagedLinkage>, Paged> = true;
// @ts-expect-error an explicit `undefined` page is no longer "absent": omit the key
export const undefinedLinkagePage = Endpoint.getRelationship(Article, "comments", {
  page: undefined,
});

// ---------------------------------------------------------------------------
// Endpoint.resource / Group.resource — the generated list and relationship endpoints
// ---------------------------------------------------------------------------

const articles = Group.resource(Article);
type Generated = (typeof articles)["endpoints"];
export const generatedListKeys: Types.Equals<
  QueryKeys<Generated["list"]>,
  "include" | "fields" | "sort"
> = true;
export const generatedRelatedKeys: Types.Equals<
  QueryKeys<Generated["comments"]>,
  "include" | "fields" | "sort"
> = true;
export const generatedLinkageQuery: Types.Equals<
  QueryKeys<Generated["commentsRelationship"]>,
  never
> = true;

const pagedArticles = Group.resource(Article, { page: Query.Page.Offset, filter: { q } });
type PagedGenerated = (typeof pagedArticles)["endpoints"];
export const pagedGeneratedList: Types.Equals<
  QueryKeys<PagedGenerated["list"]>,
  "include" | "fields" | "sort" | "page" | "filter"
> = true;
// The relationship endpoints page but never filter…
export const pagedGeneratedRelated: Types.Equals<
  QueryKeys<PagedGenerated["comments"]>,
  "include" | "fields" | "sort" | "page"
> = true;
export const pagedGeneratedLinkage: Types.Equals<
  QueryOf<PagedGenerated["commentsRelationship"]>,
  Paged
> = true;
// …and the to-one ones never page.
export const pagedGeneratedToOne: Types.Equals<
  QueryKeys<PagedGenerated["authorRelationship"]>,
  never
> = true;

// A per-endpoint `page` overrides the absent top-level one.
const perEndpoint = Group.resource(Article, {
  endpoints: { list: { page: Query.Page.Offset } },
  relationships: { comments: { page: Query.Page.Offset } },
});
type PerEndpoint = (typeof perEndpoint)["endpoints"];
export const perEndpointList: Types.Equals<
  QueryKeys<PerEndpoint["list"]>,
  "include" | "fields" | "sort" | "page"
> = true;
export const perEndpointLinkage: Types.Equals<
  QueryOf<PerEndpoint["commentsRelationship"]>,
  Paged
> = true;

// @ts-expect-error an explicit `undefined` page is no longer "absent": omit the key
export const undefinedGroupPage = Group.resource(Article, { page: undefined });

// The published type-level aliases take `never` for an absent page / filter
// (`get: true` emits `get` as the default does)…
type ArticleAttributes = (typeof Article)["fields"]["attributes"]["fields"];
type ArticleMeta = (typeof Article)["fields"]["meta"]["schema"];
export type NoPage = Endpoint.ResourceEndpoints<
  "articles",
  ArticleAttributes,
  typeof Article.relationships,
  ArticleMeta,
  Id<"articles">,
  { readonly get: true },
  true,
  readonly [],
  true,
  true,
  true,
  never,
  never,
  ArticleMeta
>;
export const noPageIsGroupResource: Types.Equals<NoPage[number], Generated[keyof Generated]> = true;
export type UndefinedPage = Endpoint.ResourceEndpoints<
  "articles",
  ArticleAttributes,
  typeof Article.relationships,
  ArticleMeta,
  Id<"articles">,
  { readonly get: true },
  true,
  readonly [],
  true,
  true,
  true,
  // @ts-expect-error …and no longer `undefined`
  undefined,
  never,
  ArticleMeta
>;

// ---------------------------------------------------------------------------
// Group.flat / flatReadOnly — `include`
// ---------------------------------------------------------------------------

const ListArticles = FlatQuery.listInput({ maxLimit: 10 }, { q });
type IncludedOf<E> = HttpApiEndpoint.Success<E>["Type"] extends {
  readonly included?: ReadonlyArray<infer M>;
}
  ? M
  : "no included member";
const { group: bareFlat } = Group.flatReadOnly({ resource: Article, list: ListArticles });
// No surface: the document's `included` stays the open default.
export const bareFlatIncluded: Types.Equals<
  IncludedOf<(typeof bareFlat)["endpoints"]["get"]>,
  unknown
> = true;
const { group: surfacedFlat } = Group.flat({
  resource: Article,
  list: ListArticles,
  include: Include.make(Article, { comments: Comment }),
  create: Schema.Struct({ title: Schema.String }),
  update: Schema.Struct({ id: Article.Id }),
});
export const surfacedFlatIncluded: Types.Equals<
  IncludedOf<(typeof surfacedFlat)["endpoints"]["get"]>["type"],
  "comments"
> = true;
// @ts-expect-error an explicit `undefined` surface is no longer "absent": omit the key
export const undefinedSurface = Group.flatReadOnly({
  resource: Article,
  list: ListArticles,
  include: undefined,
});

// ---------------------------------------------------------------------------
// Handlers.paginatedRelationship — `self`
// ---------------------------------------------------------------------------

const bySelfDefault = Handlers.paginatedRelationship("people", "9", "articles");
export const defaultSelf: Types.Equals<
  typeof bySelfDefault,
  { readonly links: { readonly self: string; readonly related: string } }
> = true;
const linksOnly = Handlers.paginatedRelationship("people", "9", "articles", { self: false });
export const noSelf: Types.Equals<
  typeof linksOnly,
  { readonly links: { readonly related: string } }
> = true;
const pathSelf = Handlers.paginatedRelationship("people", "9", "articles", { self: "/v2" });
export const givenSelf: Types.Equals<
  typeof pathSelf,
  { readonly links: { readonly self: string; readonly related: string } }
> = true;
// @ts-expect-error `undefined` is no longer a `self` type argument: omit it
export const undefinedSelf = Handlers.paginatedRelationship<undefined>("people", "9", "articles");

// ---------------------------------------------------------------------------
// Idempotency — `HeadersFor` / `Applied`
// ---------------------------------------------------------------------------

export const offHeaders: Types.Equals<Idempotency.HeadersFor<false>, never> = true;
export const absentHeaders: Types.Equals<Idempotency.HeadersFor<never>, never> = true;
// @ts-expect-error `undefined` is no longer the "off" option: pass `false` or `never`
export type UndefinedHeaders = Idempotency.HeadersFor<undefined>;
// @ts-expect-error likewise for `Applied`
export type UndefinedApplied = Idempotency.Applied<typeof bareList, undefined>;

// ---------------------------------------------------------------------------
// Query.Include — `options`
// ---------------------------------------------------------------------------

const everyPath = Query.Include(Article);
export const everyPathType: Types.Equals<
  (typeof everyPath)["Type"],
  ReadonlyArray<Resource.IncludePath<typeof Article>>
> = true;
const shallow = Query.Include(Article, { paths: ["author"] });
export const shallowType: Types.Equals<(typeof shallow)["Type"], ReadonlyArray<"author">> = true;
// @ts-expect-error `undefined` is no longer an `options` type argument: omit it
export const undefinedInclude = Query.Include<typeof Article, undefined>(Article);

// ---------------------------------------------------------------------------
// Resource.attribute — `clearable`
// ---------------------------------------------------------------------------

type ClearableOf<A> =
  A extends Resource.Attribute<Schema.Top, infer _R, infer _C, infer _U, infer Clearable>
    ? Clearable
    : "not an attribute";
const nullable = Resource.attribute(Schema.NullOr(Schema.String));
const plain = Resource.attribute(Schema.String);
const cleared = Resource.attribute(Schema.String, { clearable: true });
export const nullableDefaultsClearable: Types.Equals<ClearableOf<typeof nullable>, true> = true;
export const plainDefaultsNotClearable: Types.Equals<ClearableOf<typeof plain>, false> = true;
export const givenClearable: Types.Equals<ClearableOf<typeof cleared>, true> = true;
// @ts-expect-error an explicit `undefined` clearable is no longer "absent": omit the key
export const undefinedClearable = Resource.attribute(Schema.String, { clearable: undefined });

// ---------------------------------------------------------------------------
// Resource.extend / ExtendedId — `id`
// ---------------------------------------------------------------------------

const Node = Resource.make("nodes", { attributes: { name: Schema.String } });
const Editor = Resource.extend(Node, "editors");
const Reviewer = Resource.extend(Node, "reviewers", { inheritId: true });
const CustomId = Schema.String.pipe(Schema.brand("CustomId"));
const Owner = Resource.extend(Node, "owners", { id: CustomId });
export const freshId: Types.Equals<typeof Editor.Id, Id<"editors">> = true;
export const inheritedId: Types.Equals<
  typeof Reviewer.Id,
  Resource.ExtendedId<Id<"nodes">, "reviewers", true>
> = true;
export const customId: Types.Equals<typeof Owner.Id, typeof CustomId> = true;
export const absentCustom: Types.Equals<
  Resource.ExtendedId<Id<"nodes">, "editors", false>,
  Id<"editors">
> = true;
// @ts-expect-error `undefined` is no longer the absent `Custom` argument: omit it or pass `never`
export type UndefinedCustom = Resource.ExtendedId<Id<"nodes">, "editors", false, undefined>;

// ---------------------------------------------------------------------------
// Resource.family / Family / Endpoint.polymorphic — `Base`
// ---------------------------------------------------------------------------

const Named = Resource.family("named", [Editor, Owner]);
const Anchored = Resource.family(Node, [Editor, Reviewer]);
export const namedId: Types.Equals<
  typeof Named.Id,
  Schema.Union<readonly [typeof Editor.Id, typeof Owner.Id]>
> = true;
export const namedMaxErrors: Types.Equals<typeof Named.maxUndeclaredMemberErrors, undefined> = true;
export const anchoredId: Types.Equals<typeof Anchored.Id, typeof Node.Id> = true;
export const anchoredRelationships: Types.Equals<
  typeof Anchored.relationships,
  typeof Node.relationships
> = true;
const namedNode = Endpoint.polymorphic(Named);
export const namedPolymorphicParams: Types.Equals<
  HttpApiEndpoint.Params<typeof namedNode>["Type"],
  { readonly id: typeof Editor.Id.Type | typeof Owner.Id.Type }
> = true;
// @ts-expect-error `undefined` is no longer the absent `Base` argument: omit it
export type UndefinedBase = Resource.Family<"named", readonly [typeof Editor], undefined>;
