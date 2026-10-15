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

export const get = Endpoint.get(Article, { include: true, fields: true });
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
// The members' `TargetsOf` (paginated `Revision` included, as before) plus the
// depth-2 `comments.author`.
assertType<
  Equals<
    IncludedOf<typeof search>,
    typeof Comment.Type | typeof Person.Type | typeof Company.Type | typeof Revision.Type
  >
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

// ---------------------------------------------------------------------------
// No include path turned on: the document is exactly what it was
// ---------------------------------------------------------------------------

// The resource's own `document()` / `collection()`, passed as `success`, is
// what the default was before #320.
export const explicit = Endpoint.get(Article, { success: Article.document() });
export const plain = Endpoint.get(Article);
export const off = Endpoint.get(Article, { include: false, fields: true });
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
export const plainList = Endpoint.list(Article, { fields: true });
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
assertType<
  Equals<
    IncludedOf<typeof plainSearch>,
    typeof Comment.Type | typeof Revision.Type | typeof Company.Type
  >
>(true);

export const plainNode = Endpoint.polymorphic(AnyNode);
assertType<Equals<IncludedOf<typeof plainNode>, typeof Comment.Type>>(true);

// A declared surface keeps its own union.
export const surface = Endpoint.get(Article, {
  include: Include.make(Article, { comments: Comment }),
});
assertType<Equals<IncludedOf<typeof surface>, typeof Comment.Type>>(true);
