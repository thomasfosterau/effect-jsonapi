/**
 * Type-level tests for the `included` union of a read endpoint's default
 * document (#320).
 *
 * An endpoint whose `include` option is `true` or a `Query.IncludeOptions`
 * admits in `included` every resource its legal include paths reach, beside
 * the non-`paginated` direct targets — so a handler can return the resources
 * an advertised depth-2 path such as `comments.author` brings in. An endpoint
 * with `include` off, or with a declared `Include.Surface`, keeps exactly the
 * document it had. The runtime half is `src/Endpoint.included.test.ts`.
 *
 * This file is type-checked by `tsconfig.json`; the `@ts-expect-error`
 * annotations are the assertions, each paired with a positive control.
 */
import * as Schema from "effect/Schema";
import type { HttpApiEndpoint } from "effect/http-api";
import {
  Endpoint,
  Handlers,
  Include,
  Query,
  Relationship,
  Resource,
} from "@thomasfosterau/effect-jsonapi";

/** Pins a value to an expected type without using it (`noUnusedLocals`). */
const assertType = <Expected>(_value: Expected): void => {};

// Whether two types are identical, not merely mutually assignable.
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const Revision = Resource.make("revisions", { attributes: { editedAt: Schema.String } });
const Company = Resource.make("companies", { attributes: { name: Schema.String } });
const Person = Resource.make("people", {
  attributes: { name: Schema.String },
  relationships: { employer: Relationship.one(() => Company) },
});
const Comment = Resource.make("comments", {
  attributes: { body: Schema.String },
  relationships: {
    author: Relationship.one(() => Person),
    revisions: Relationship.paginated(() => Revision),
  },
});
const Article = Resource.make("articles", {
  attributes: { title: Schema.String },
  relationships: {
    comments: Relationship.many(() => Comment),
    history: Relationship.paginated(() => Revision),
  },
});

// The `included` member type of an endpoint's success document.
type IncludedOf<E> =
  HttpApiEndpoint.Success<E> extends {
    readonly Type: { readonly included?: ReadonlyArray<infer M> | undefined };
  }
    ? M
    : never;
type SuccessOf<E> = HttpApiEndpoint.Success<E>["Type"];

const person = Person.make({
  id: Person.Id.make("9"),
  attributes: { name: "Ada" },
  relationships: { employer: { data: { type: "companies", id: Company.Id.make("2") } } },
});
const comment = Comment.make({
  id: Comment.Id.make("5"),
  attributes: { body: "First" },
  relationships: {
    author: { data: { type: "people", id: person.id } },
    revisions: { links: { related: "/comments/5/revisions" } },
  },
});
const article = Article.make({
  id: Article.Id.make("1"),
  attributes: { title: "Hello" },
  relationships: {
    comments: { data: [{ type: "comments", id: comment.id }] },
    history: { links: { related: "/articles/1/history" } },
  },
});

// A handler's document for `?include=comments.author`, and one carrying only
// the direct target.
const deepDocument = Handlers.data(article, { included: [comment, person] });
const shallowDocument = Handlers.data(article, { included: [comment] });

// ---------------------------------------------------------------------------
// `include: true` — every type the depth-2 graph reaches
// ---------------------------------------------------------------------------

export const get = Endpoint.get(Article, { include: true });
export const list = Endpoint.list(Article, { include: true });

assertType<Equals<IncludedOf<typeof get>, typeof Comment.Type | typeof Person.Type>>(true);
assertType<Equals<IncludedOf<typeof list>, typeof Comment.Type | typeof Person.Type>>(true);
// Negative control: `Company` is three hops away, `Revision` behind a paginated relationship.
assertType<
  Equals<
    IncludedOf<typeof get>,
    typeof Comment.Type | typeof Person.Type | typeof Company.Type | typeof Revision.Type
  >
>(false);

// The handler's document for `?include=comments.author` fits the endpoint.
assertType<SuccessOf<typeof get>>(deepDocument);
assertType<SuccessOf<typeof list>>(Handlers.collection([article], { included: [comment, person] }));

// `depth: 3` reaches `comments.author.employer`.
export const deep = Endpoint.get(Article, { include: { depth: 3 } });
assertType<
  Equals<IncludedOf<typeof deep>, typeof Comment.Type | typeof Person.Type | typeof Company.Type>
>(true);

// An allow-list reaches exactly its paths, beside the direct targets.
export const allowList = Endpoint.get(Article, { include: { paths: ["comments"] } });
assertType<Equals<IncludedOf<typeof allowList>, typeof Comment.Type>>(true);
// @ts-expect-error -- `people` is on no path the allow-list legalises
assertType<SuccessOf<typeof allowList>>(deepDocument);
// Positive control: the direct target alone fits.
assertType<SuccessOf<typeof allowList>>(shallowDocument);

// `related`, `collection` and `polymorphic` walk their own graphs.
export const related = Endpoint.related(Article, "comments", { include: true });
assertType<Equals<IncludedOf<typeof related>, typeof Person.Type | typeof Company.Type>>(true);

export const search = Endpoint.collection([Article, Person], {
  name: "search",
  path: "/search",
  include: true,
});
// The members' non-`paginated` direct targets plus the depth-2
// `comments.author`; `Article.history`'s paginated `Revision` is not one (#337).
assertType<
  Equals<IncludedOf<typeof search>, typeof Comment.Type | typeof Person.Type | typeof Company.Type>
>(true);

const Node = Resource.make("nodes", { attributes: { name: Schema.String } });
const Author = Resource.extend(Node, "authors", {
  inheritId: true,
  relationships: { comments: Relationship.many(() => Comment) },
});
const Editor = Resource.extend(Node, "editors", { inheritId: true });
const AnyNode = Resource.family(Node, [Author, Editor]);
export const node = Endpoint.polymorphic(AnyNode, { include: true });
assertType<Equals<IncludedOf<typeof node>, typeof Comment.Type | typeof Person.Type>>(true);
// The depth-2 path comes from a member other than the first.
export const editorFirst = Endpoint.polymorphic(Resource.family(Node, [Editor, Author]), {
  include: true,
});
assertType<Equals<IncludedOf<typeof editorFirst>, typeof Comment.Type | typeof Person.Type>>(true);

// A to-one `related` walks its target's graph too: `parent` is a `Comment`,
// whose `author.employer` reaches `Company` beyond the direct `Person`.
const Reply = Resource.make("replies", {
  attributes: { body: Schema.String },
  relationships: { parent: Relationship.one(() => Comment) },
});
export const relatedOne = Endpoint.related(Reply, "parent", { include: true });
assertType<Equals<IncludedOf<typeof relatedOne>, typeof Person.Type | typeof Company.Type>>(true);
// Negative control: without `include`, only the target's direct targets.
export const plainRelatedOne = Endpoint.related(Reply, "parent");
assertType<Equals<IncludedOf<typeof plainRelatedOne>, typeof Person.Type>>(true);

// ---------------------------------------------------------------------------
// A target one member reaches only through a paginated relationship
// ---------------------------------------------------------------------------

// `posts.author` is a to-one `people`, so `author` and `author.employer` are
// legal paths; `drafts.author` is a paginated `revisions`, which no path may
// cross, so walking those paths from `drafts` reaches nothing.
const Entry = Resource.make("entries", { attributes: { title: Schema.String } });
const Post = Resource.extend(Entry, "posts", {
  inheritId: true,
  relationships: { author: Relationship.one(() => Person) },
});
const Draft = Resource.extend(Entry, "drafts", {
  inheritId: true,
  relationships: { author: Relationship.paginated(() => Revision) },
});
export const entries = Endpoint.polymorphic(Resource.family(Entry, [Post, Draft]), {
  include: true,
});
assertType<Equals<IncludedOf<typeof entries>, typeof Person.Type | typeof Company.Type>>(true);
assertType<
  Equals<
    Query.FieldsetResources<typeof Post | typeof Draft, true>["type"],
    "posts" | "drafts" | "people" | "companies"
  >
>(true);
// `collection` admits what `polymorphic` does: `drafts.author`'s paginated
// `Revision` is no member's includable target, so it is not in `included`,
// as the runtime document rejects a `revisions` member (#337).
export const entryCollection = Endpoint.collection([Post, Draft], {
  name: "entries",
  path: "/entries",
  include: true,
});
assertType<Equals<IncludedOf<typeof entryCollection>, typeof Person.Type | typeof Company.Type>>(
  true,
);
// The same with `include` off, and with `fields: true` (whose `included`
// members are partial, so compare their `type` tags).
export const plainEntryCollection = Endpoint.collection([Post, Draft], {
  name: "entries",
  path: "/entries",
});
assertType<Equals<IncludedOf<typeof plainEntryCollection>, typeof Person.Type>>(true);
export const sparseEntryCollection = Endpoint.collection([Post, Draft], {
  name: "entries",
  path: "/entries",
  include: true,
  fields: true,
});
assertType<Equals<IncludedOf<typeof sparseEntryCollection>["type"], "people" | "companies">>(true);

// A handler's document for `entries` may carry `people` but not `revisions`.
const post = Post.make({
  id: Post.Id.make("1"),
  attributes: { title: "Hello" },
  relationships: { author: { data: { type: "people", id: person.id } } },
});
const revision = Revision.make({
  id: Revision.Id.make("3"),
  attributes: { editedAt: "2026-01-01" },
});
assertType<SuccessOf<typeof plainEntryCollection>>(
  Handlers.collection([post], { included: [person] }),
);
assertType<SuccessOf<typeof plainEntryCollection>>(
  // @ts-expect-error -- `revisions` is only behind `drafts.author`, a paginated relationship (#337)
  Handlers.collection([post], { included: [revision] }),
);
assertType<SuccessOf<typeof entryCollection>>(
  // @ts-expect-error -- not under `include: true` either (#337)
  Handlers.collection([post], { included: [person, revision] }),
);
// Positive control: the include walk's `people` and `companies` fit.
assertType<SuccessOf<typeof entryCollection>>(
  Handlers.collection([post], {
    included: [person, Company.make({ id: Company.Id.make("2"), attributes: { name: "Acme" } })],
  }),
);
// The public `CollectionIncluded` is the members' non-`paginated` targets.
assertType<
  Equals<
    Endpoint.CollectionIncluded<readonly [typeof Post, typeof Draft]>["Type"],
    typeof Person.Type
  >
>(true);

// The same, at the second hop: `drafts.author` is a to-one `writers`, so
// `author.employer` is a legal path, but `writers.employer` is a paginated
// `archives`, which no path may cross at any hop.
const Archive = Resource.make("archives", { attributes: { label: Schema.String } });
const Writer = Resource.make("writers", {
  attributes: { name: Schema.String },
  relationships: { employer: Relationship.paginated(() => Archive) },
});
const SecondPost = Resource.extend(Entry, "posts", {
  inheritId: true,
  relationships: { author: Relationship.one(() => Person) },
});
const SecondDraft = Resource.extend(Entry, "drafts", {
  inheritId: true,
  relationships: { author: Relationship.one(() => Writer) },
});
export const secondHop = Endpoint.polymorphic(Resource.family(Entry, [SecondPost, SecondDraft]), {
  include: true,
});
assertType<
  Equals<
    IncludedOf<typeof secondHop>,
    typeof Person.Type | typeof Company.Type | typeof Writer.Type
  >
>(true);
assertType<
  Equals<
    Query.FieldsetResources<typeof SecondPost | typeof SecondDraft, true>["type"],
    "posts" | "drafts" | "people" | "companies" | "writers"
  >
>(true);

// ---------------------------------------------------------------------------
// No include path turned on: the document is exactly what it was
// ---------------------------------------------------------------------------

// The resource's own `document()` / `collection()`, passed as `success`, is
// what the default was before #320.
export const explicit = Endpoint.get(Article, { success: Article.document() });
export const plain = Endpoint.get(Article);
export const off = Endpoint.get(Article, { include: false });
assertType<Equals<HttpApiEndpoint.Success<typeof plain>, HttpApiEndpoint.Success<typeof explicit>>>(
  true,
);
assertType<Equals<HttpApiEndpoint.Success<typeof off>, HttpApiEndpoint.Success<typeof explicit>>>(
  true,
);
assertType<Equals<IncludedOf<typeof plain>, typeof Comment.Type>>(true);
// @ts-expect-error -- `people` is not a direct target, and no include path is on
assertType<SuccessOf<typeof plain>>(deepDocument);
// Positive control: the direct target alone fits.
assertType<SuccessOf<typeof plain>>(shallowDocument);

export const explicitList = Endpoint.list(Article, { success: Article.collection() });
export const plainList = Endpoint.list(Article);
assertType<
  Equals<HttpApiEndpoint.Success<typeof plainList>, HttpApiEndpoint.Success<typeof explicitList>>
>(true);
// Negative control: `include: true` changes the document.
assertType<
  Equals<HttpApiEndpoint.Success<typeof list>, HttpApiEndpoint.Success<typeof explicitList>>
>(false);

export const plainRelated = Endpoint.related(Article, "comments");
assertType<Equals<IncludedOf<typeof plainRelated>, typeof Person.Type>>(true);

export const plainSearch = Endpoint.collection([Article, Person], {
  name: "search",
  path: "/search",
});
// `Article.history` is paginated, so its `Revision` is not admitted (#337).
assertType<Equals<IncludedOf<typeof plainSearch>, typeof Comment.Type | typeof Company.Type>>(true);
// @ts-expect-error -- `revisions` is reached only through a paginated relationship
assertType<IncludedOf<typeof plainSearch>>(revision);

export const plainNode = Endpoint.polymorphic(AnyNode);
assertType<Equals<IncludedOf<typeof plainNode>, typeof Comment.Type>>(true);

// A declared surface keeps its own union.
export const surface = Endpoint.get(Article, {
  include: Include.make(Article, { comments: Comment }),
});
assertType<Equals<IncludedOf<typeof surface>, typeof Comment.Type>>(true);
