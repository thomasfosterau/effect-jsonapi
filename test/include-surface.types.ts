/**
 * Type-level tests for declared `?include=` surfaces (`Include.make`).
 *
 * The point of a surface is that **three** artefacts fall out of *one*
 * declaration and cannot drift apart:
 *
 *   1. the accepted-path whitelist (`surface.paths`, and the `include`
 *      parameter's element type),
 *   2. the `included` member's union in the success document,
 *   3. the advertised parameter itself — present only where a surface (or
 *      `include: true` / `Query.IncludeOptions`) is given.
 *
 * So the assertions below are mostly *exactness* assertions: the derived type
 * is neither wider nor narrower than the declaration. A subset check would
 * pass for a derivation that quietly admitted everything.
 *
 * Depth is capped explicitly at `Include.MAX_DEPTH` rather than left to
 * emerge: the recursion is over the declaration (which is finite — a `const`
 * cannot appear in its own initialiser, so a spec can never be cyclic), and
 * the cap bounds a pathological declaration. The type level truncates past it
 * and the runtime throws; `src/Include.test.ts` pins the runtime half, and the
 * `Chain7` assertions below pin this one, so the two agree.
 *
 * This file is type-checked by `tsconfig.test.json`; the `@ts-expect-error`
 * annotations are the assertions, and every one of them is paired with a
 * negative control — an otherwise-identical line that must *not* error — so a
 * derivation that broke down to `any` or `never` could not pass. Every binding
 * is exported so an unused-local error can never stand in for the error an
 * `@ts-expect-error` expects.
 */
import { Schema } from "effect";
import type { HttpApiEndpoint } from "effect/http-api";
import { Endpoint, Include, Query, Relationship, Resource } from "@thomasfosterau/effect-jsonapi";

// Asserts that a value is assignable to `Expected`.
const assertType = <Expected>(_value: Expected): void => {};

// Whether two types are identical, not merely mutually assignable.
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const Company = Resource.make("companies", {
  attributes: { name: Schema.NonEmptyString },
});

const Person = Resource.make("people", {
  attributes: { firstName: Schema.NonEmptyString },
  relationships: { company: Relationship.one(() => Company) },
});

const Tag = Resource.make("tags", {
  attributes: { label: Schema.NonEmptyString },
});

const Revision = Resource.make("revisions", {
  attributes: { editedAt: Schema.String },
});

const Comment = Resource.make("comments", {
  attributes: { body: Schema.NonEmptyString },
  relationships: { author: Relationship.one(() => Person) },
});

const Article = Resource.make("articles", {
  attributes: { title: Schema.NonEmptyString },
  relationships: {
    author: Relationship.one(() => Person),
    comments: Relationship.many(() => Comment),
    tags: Relationship.many(() => Tag),
    // Paginated relationships carry no inline linkage: never includable.
    revisions: Relationship.paginated(() => Revision),
  },
});

// ---------------------------------------------------------------------------
// The declaration is checked against the resource graph
// ---------------------------------------------------------------------------

export const declared = Include.make(Article, {
  author: Person,
  comments: Include.nested(Comment, { author: Person }),
});

// A key the resource has no relationship for.
// @ts-expect-error -- "editor" is not a relationship of Article
export const unknownKey = Include.make(Article, { editor: Person });
// negative control: the same shape with a real relationship key
export const knownKey = Include.make(Article, { author: Person });

// A paginated relationship is not includable at all.
// @ts-expect-error -- `revisions` is paginated, so it is never inlined
export const paginatedKey = Include.make(Article, { revisions: Revision });
// negative control: a `many` relationship on the same resource is includable
export const manyKey = Include.make(Article, { comments: Comment });

// A key declared against the wrong resource.
// @ts-expect-error -- `author` targets Person, not Tag
export const wrongTarget = Include.make(Article, { author: Tag });
// negative control: the right target
export const rightTarget = Include.make(Article, { author: Person });

// `nested` checks its children against *its own* target, not the root's.
export const nestedWrong = Include.make(Article, {
  // @ts-expect-error -- `company` is a relationship of Person, not of Comment
  comments: Include.nested(Comment, { company: Company }),
});
// negative control: the same nesting one hop further along, where it is legal
export const nestedRight = Include.make(Article, {
  author: Include.nested(Person, { company: Company }),
});

// ---------------------------------------------------------------------------
// Artefact 1: the whitelist spells every depth, exactly
// ---------------------------------------------------------------------------

export type Spec = (typeof declared)["spec"];
export type Paths = Include.Paths<Spec>;

// Exactly the declared set — not a subset, not the graph's own paths.
// (Each expectation is named first so that the `@ts-expect-error` the negative
// controls need sits on the same line as the assertion it annotates.)
type PathsExact = Equals<Paths, "author" | "comments" | "comments.author">;
type PathsTopLevelOnly = Equals<Paths, "author" | "comments">;
type PathsPlusGraph = Equals<Paths, "author" | "comments" | "comments.author" | "tags">;

assertType<PathsExact>(true);
// @ts-expect-error -- negative control: it is not merely the top-level keys
assertType<PathsTopLevelOnly>(true);
// @ts-expect-error -- negative control: `tags` is in the graph but not declared
assertType<PathsPlusGraph>(true);

export const path1: Paths = "author";
export const path2: Paths = "comments.author";
// @ts-expect-error -- `tags` is a relationship of Article, but this surface doesn't serve it
export const pathUndeclared: Paths = "tags";
// @ts-expect-error -- the whole dotted path is matched: a legal head segment doesn't admit a deep path
export const pathDeepUnderLegalHead: Paths = "comments.editor";
// @ts-expect-error -- likewise below a leaf key
export const pathBelowLeaf: Paths = "author.company";

// `surface.paths` is that whitelist, not `ReadonlyArray<string>`.
type SurfacePathsExact = Equals<(typeof declared)["paths"], ReadonlyArray<Paths>>;
type SurfacePathsWidened = Equals<(typeof declared)["paths"], ReadonlyArray<string>>;

assertType<SurfacePathsExact>(true);
// @ts-expect-error -- negative control: it has not been widened to bare strings
assertType<SurfacePathsWidened>(true);

// ---------------------------------------------------------------------------
// Nesting only ever *adds* paths
// ---------------------------------------------------------------------------

export const nestedComments = Include.make(Article, {
  comments: Include.nested(Comment, { author: Person }),
});

export type Flat = Include.Paths<{ readonly comments: typeof Comment }>;
export type Deep = Include.Paths<(typeof nestedComments)["spec"]>;

// Every path the flat declaration legalised is still legal once nested.
assertType<Flat extends Deep ? true : false>(true);
assertType<Equals<Flat, "comments">>(true);
assertType<Equals<Deep, "comments" | "comments.author">>(true);
// @ts-expect-error -- negative control: nesting did not *replace* the bare key
assertType<Equals<Deep, "comments.author">>(true);

// ---------------------------------------------------------------------------
// Artefact 2: the union carries every depth, identity-deduped
// ---------------------------------------------------------------------------

export type Members = Include.Members<Spec>;

// Comment *and* the Person behind it — a walk that hoists both needs both arms.
type MembersExact = Equals<Members, typeof Person | typeof Comment>;
type MembersLeavesOnly = Equals<Members, typeof Person>;
type MembersPlusGraph = Equals<Members, typeof Person | typeof Comment | typeof Tag>;

assertType<MembersExact>(true);
// @ts-expect-error -- negative control: not just the leaves
assertType<MembersLeavesOnly>(true);
// @ts-expect-error -- negative control: `Tag` is reachable in the graph, but undeclared
assertType<MembersPlusGraph>(true);

// Two keys at the same resource contribute one member, not two.
export const twice = Include.make(Article, {
  author: Person,
  comments: Include.nested(Comment, { author: Person }),
});
assertType<Equals<Include.Members<(typeof twice)["spec"]>, typeof Person | typeof Comment>>(true);

// The union reaches every hop of a deeper declaration.
export const threeDeep = Include.make(Article, {
  comments: Include.nested(Comment, {
    author: Include.nested(Person, { company: Company }),
  }),
});
type ThreeDeepMembers = Include.Members<(typeof threeDeep)["spec"]>;
type ThreeDeepExact = Equals<ThreeDeepMembers, typeof Comment | typeof Person | typeof Company>;
type ThreeDeepLeafOnly = Equals<ThreeDeepMembers, typeof Company>;

assertType<ThreeDeepExact>(true);
// @ts-expect-error -- negative control: the intermediate hops are not dropped
assertType<ThreeDeepLeafOnly>(true);

// ---------------------------------------------------------------------------
// Artefact 3: the advertised parameter, from the same declaration
// ---------------------------------------------------------------------------

export const query = Query.schema(Article, { include: declared });
export type QueryInclude = NonNullable<(typeof query.Type)["include"]>[number];

// The parameter's element type *is* the whitelist — one declaration, one set.
type ParameterIsWhitelist = Equals<QueryInclude, Paths>;
type ParameterIsGraph = Equals<QueryInclude, Resource.IncludePath<typeof Article>>;

assertType<ParameterIsWhitelist>(true);
// @ts-expect-error -- negative control: not the graph's depth-2 derivation
assertType<ParameterIsGraph>(true);

// A resource that declares no surface advertises no parameter.
export const noInclude = Query.schema(Article, { fields: true });
// @ts-expect-error -- there is no `include` key on a query that doesn't serve a walk
export type NoInclude = (typeof noInclude.Type)["include"];
// negative control: `fields` *is* on that query
export type HasFields = (typeof noInclude.Type)["fields"];

// `include: true` and `Query.IncludeOptions` are untouched by any of this.
export const graphQuery = Query.schema(Article, { include: true });
type GraphInclude = NonNullable<(typeof graphQuery.Type)["include"]>[number];
assertType<Equals<GraphInclude, Resource.IncludePath<typeof Article>>>(true);

export const allowListQuery = Query.schema(Article, { include: { paths: ["author", "tags"] } });
type AllowListInclude = NonNullable<(typeof allowListQuery.Type)["include"]>[number];
type AllowListExact = Equals<AllowListInclude, "author" | "tags">;
type AllowListWidened = Equals<AllowListInclude, Resource.IncludePath<typeof Article>>;

assertType<AllowListExact>(true);
// @ts-expect-error -- negative control: the allow-list is not widened back to the graph
assertType<AllowListWidened>(true);

// ---------------------------------------------------------------------------
// The three agree on the endpoints
// ---------------------------------------------------------------------------

export const getArticle = Endpoint.get(Article, { include: declared });
export const listArticles = Endpoint.list(Article, { include: declared });

// The `included` member type of an endpoint's success document, and the
// `include` parameter's element type — read through `infer` rather than an
// indexed access, which a deferred conditional can't be asked for.
type IncludedOf<E> =
  HttpApiEndpoint.Success<E> extends {
    readonly Type: { readonly included?: ReadonlyArray<infer M> | undefined };
  }
    ? M
    : never;
type AdvertisedBy<E> =
  HttpApiEndpoint.Query<E> extends {
    readonly Type: { readonly include?: ReadonlyArray<infer P> | undefined };
  }
    ? P
    : never;

// The document admits exactly what the declaration can hoist.
type GetIncluded = IncludedOf<typeof getArticle>;
type GetIncludedExact = Equals<GetIncluded, typeof Person.Type | typeof Comment.Type>;
type GetIncludedPlusGraph = Equals<
  GetIncluded,
  typeof Person.Type | typeof Comment.Type | typeof Tag.Type
>;

assertType<GetIncludedExact>(true);
// @ts-expect-error -- negative control: `Tag` is in the graph's default union, not this one
assertType<GetIncludedPlusGraph>(true);

// `get` and `list` cannot disagree: both project from the same declaration.
assertType<Equals<GetIncluded, IncludedOf<typeof listArticles>>>(true);

// …and the advertised paths on those endpoints are that same whitelist.
assertType<Equals<AdvertisedBy<typeof getArticle>, Paths>>(true);
assertType<Equals<AdvertisedBy<typeof listArticles>, Paths>>(true);

// Without a surface the document admits every non-`paginated` target and every
// resource a legal depth-2 path reaches (#320) — `author.company` brings
// `Company` in — while `Revision` stays absent.
export const getByGraph = Endpoint.get(Article, { include: true });
type GraphIncluded = IncludedOf<typeof getByGraph>;
type GraphIncludedExact = Equals<
  GraphIncluded,
  typeof Person.Type | typeof Comment.Type | typeof Tag.Type | typeof Company.Type
>;
type GraphIncludedDirectOnly = Equals<
  GraphIncluded,
  typeof Person.Type | typeof Comment.Type | typeof Tag.Type
>;

assertType<GraphIncludedExact>(true);
// @ts-expect-error -- negative control: `include: true` reaches past the direct targets
assertType<GraphIncludedDirectOnly>(true);

// A `related` endpoint takes a surface over its *target*.
export const commentSurface = Include.make(Comment, {
  author: Include.nested(Person, { company: Company }),
});
export const relatedComments = Endpoint.related(Article, "comments", { include: commentSurface });
type RelatedIncluded = IncludedOf<typeof relatedComments>;
type RelatedExact = Equals<RelatedIncluded, typeof Person.Type | typeof Company.Type>;
type RelatedTargetGraphOnly = Equals<RelatedIncluded, typeof Person.Type>;

assertType<RelatedExact>(true);
// @ts-expect-error -- negative control: Comment's own graph would not reach Company
assertType<RelatedTargetGraphOnly>(true);

// A surface over another resource is not this endpoint's `include` option —
// not even when it is structurally an allow-list of legal-looking paths.
export const personSurface = Include.make(Person, { company: Company });
// @ts-expect-error -- `personSurface` is Person's surface: "company" is not an Article path
export const mismatched = Endpoint.get(Article, { include: personSurface });
// negative control: Article's own surface is accepted
export const matched = Endpoint.get(Article, { include: declared });

// ---------------------------------------------------------------------------
// Depth: the cap is explicit, and the type level truncates at exactly it
// ---------------------------------------------------------------------------

assertType<Equals<Include.MaxDepth, 6>>(true);

// A synthetic chain, at the type level only: the derivation recurses over the
// declaration, never over the graph, so one resource stands in at every hop.
// `Hop<C>` is one walkable level; `Leaf` is the final, non-walkable one, so a
// chain of `n - 1` hops is `n` deep.
type Hop<C extends Include.AnySpec> = Include.Branch<typeof Company, C>;
type Leaf = { readonly next: typeof Company };

type Chain6 = {
  readonly next: Hop<{
    readonly next: Hop<{
      readonly next: Hop<{ readonly next: Hop<{ readonly next: Hop<Leaf> }> }>;
    }>;
  }>;
};
type Chain7 = {
  readonly next: Hop<{
    readonly next: Hop<{
      readonly next: Hop<{
        readonly next: Hop<{ readonly next: Hop<{ readonly next: Hop<Leaf> }> }>;
      }>;
    }>;
  }>;
};

type SixHops =
  | "next"
  | "next.next"
  | "next.next.next"
  | "next.next.next.next"
  | "next.next.next.next.next"
  | "next.next.next.next.next.next";
type SevenHops = SixHops | "next.next.next.next.next.next.next";

// Exactly at the cap: nothing is dropped.
assertType<Equals<Include.Paths<Chain6>, SixHops>>(true);

// One hop past it: the seventh path is truncated and the six shallower ones
// stand. `Include.make` *throws* on such a declaration rather than let the
// advertised whitelist silently disagree with what was written — the runtime
// half of this pairing is pinned in `src/Include.test.ts`.
type Chain7Paths = Include.Paths<Chain7>;
type Chain7Truncated = Equals<Chain7Paths, SixHops>;
type Chain7Untruncated = Equals<Chain7Paths, SevenHops>;
type Chain7Collapsed = Equals<Chain7Paths, never>;

assertType<Chain7Truncated>(true);
// @ts-expect-error -- negative control: the 7th hop really is absent
assertType<Chain7Untruncated>(true);
// @ts-expect-error -- negative control: truncation drops paths, it doesn't collapse the derivation
assertType<Chain7Collapsed>(true);

// ---------------------------------------------------------------------------
// A cyclic resource graph (#118)
// ---------------------------------------------------------------------------

// The reason this derivation is safe on a cycle: it recurses over the
// *declaration*, never over the graph. A spec is a finite object literal and
// cannot be made cyclic — a `const` cannot appear in its own initialiser — so
// walking `articles → comments → articles → comments` costs exactly the four
// levels that were written, and terminates on the declaration's own depth
// rather than on the graph's.
//
// The constraint side is where a cycle would bite: `Spec<R>` reaches exactly
// one hop (`Branch<Target<R, K>, AnySpec>`, not `Spec<Target<R, K>>`), so it
// never walks the graph either. A branch's own children are checked against
// *its* target by `nested`'s signature, at the call site that writes them.

const cyclicArticleAttributes = { title: Schema.NonEmptyString };
const cyclicCommentAttributes = { body: Schema.NonEmptyString };

interface CyclicArticle extends Resource.Resource<
  "cyclic-articles",
  typeof cyclicArticleAttributes,
  {
    readonly comments: Relationship.many<CyclicComment>;
    readonly editor: Relationship.optional<CyclicArticle>;
    readonly revisions: Relationship.paginated<CyclicArticle>;
  }
> {}

interface CyclicComment extends Resource.Resource<
  "cyclic-comments",
  typeof cyclicCommentAttributes,
  {
    readonly article: Relationship.one<CyclicArticle>;
    readonly parent: Relationship.optional<CyclicComment>;
  }
> {}

const CyclicArticle: CyclicArticle = Resource.make("cyclic-articles", {
  attributes: cyclicArticleAttributes,
  relationships: {
    comments: Relationship.many(() => CyclicComment),
    editor: Relationship.optional(() => CyclicArticle),
    revisions: Relationship.paginated(() => CyclicArticle),
  },
});

const CyclicComment: CyclicComment = Resource.make("cyclic-comments", {
  attributes: cyclicCommentAttributes,
  relationships: {
    article: Relationship.one(() => CyclicArticle),
    parent: Relationship.optional(() => CyclicComment),
  },
});

// Three hops back and forth across the cycle.
export const cyclic = Include.make(CyclicArticle, {
  comments: Include.nested(CyclicComment, {
    article: Include.nested(CyclicArticle, { comments: CyclicComment }),
  }),
});

export type CyclicPaths = Include.Paths<(typeof cyclic)["spec"]>;
type CyclicPathsExact = Equals<
  CyclicPaths,
  "comments" | "comments.article" | "comments.article.comments"
>;
type CyclicPathsTruncated = Equals<CyclicPaths, "comments" | "comments.article">;

assertType<CyclicPathsExact>(true);
// @ts-expect-error -- negative control: the cycle is walked to the declared depth, not cut short
assertType<CyclicPathsTruncated>(true);

// The union terminates, and is the two resources in the cycle — once each.
export type CyclicMembers = Include.Members<(typeof cyclic)["spec"]>;
type CyclicMembersExact = Equals<CyclicMembers, CyclicComment | CyclicArticle>;
type CyclicMembersOneSided = Equals<CyclicMembers, CyclicComment>;

assertType<CyclicMembersExact>(true);
// @ts-expect-error -- negative control: both sides of the cycle are members
assertType<CyclicMembersOneSided>(true);

// The graph checks still hold across the cycle.
// @ts-expect-error -- `revisions` is paginated, cycle or no cycle
export const cyclicPaginated = Include.make(CyclicArticle, { revisions: CyclicArticle });
// negative control: the non-paginated self-reference on the same resource
export const cyclicSelfEdge = Include.make(CyclicArticle, { editor: CyclicArticle });

// ---------------------------------------------------------------------------
// `has` narrows to the whitelist (what #106's resolver validates against)
// ---------------------------------------------------------------------------

export const validate = (candidate: string): Paths | undefined =>
  declared.has(candidate) ? candidate : undefined;

export const target = declared.targets.get("comments.author");
assertType<typeof Person | typeof Comment | undefined>(target);
