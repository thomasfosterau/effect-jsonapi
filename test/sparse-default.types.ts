/**
 * Type-level tests for the partial default document of a read endpoint that
 * declares `fields` (#322).
 *
 * Its resource objects — primary and `included` alike, over exactly the types
 * `Query.FieldsetResources` names — admit any subset of their attributes, so
 * a handler's `Handlers.project(query.fields)` document fits it with no cast,
 * and a client reads those attributes as optional. An endpoint without
 * `fields` keeps exactly the document it had. The runtime half is
 * `src/Endpoint.sparse.test.ts`.
 *
 * This file is type-checked by `tsconfig.json`; the `@ts-expect-error`
 * annotations are the assertions, each paired with a positive control.
 */
import * as Schema from "effect/Schema";
import type { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import {
  Endpoint,
  Group,
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

const Company = Resource.make("companies", { attributes: { name: Schema.String } });
const Person = Resource.make("people", {
  attributes: { name: Schema.String, email: Schema.String },
  relationships: { employer: Relationship.one(() => Company) },
});
const Tag = Resource.make("tags", { attributes: { name: Schema.String } });
const Article = Resource.make("articles", {
  attributes: {
    title: Schema.String,
    body: Schema.String,
    subtitle: Schema.optionalKey(Schema.String),
  },
  relationships: {
    author: Relationship.one(() => Person),
    tags: Relationship.many(() => Tag),
  },
});
const Node = Resource.make("nodes", { attributes: { name: Schema.String } });
const Editor = Resource.extend(Node, "editors", { inheritId: true });
const Reviewer = Resource.extend(Node, "reviewers", { inheritId: true });
const AnyNode = Resource.family(Node, [Editor, Reviewer]);

type SuccessOf<E> = HttpApiEndpoint.Success<E>["Type"];
type DataOf<E> = SuccessOf<E> extends { readonly data: infer D } ? D : never;
type IncludedOf<E> =
  SuccessOf<E> extends { readonly included?: ReadonlyArray<infer M> } ? M : never;
type AttributesOf<R> = R extends { readonly attributes: infer A } ? A : never;

const article = Article.make({
  id: Article.Id.make("1"),
  attributes: { title: "Hello", body: "World" },
  relationships: {
    author: { data: { type: "people", id: Person.Id.make("9") } },
    tags: { data: [] },
  },
});
const person = Person.make({
  id: Person.Id.make("9"),
  attributes: { name: "Ada", email: "ada@example.com" },
  relationships: { employer: { data: { type: "companies", id: Company.Id.make("2") } } },
});
const editor = Editor.make({ id: Editor.Id.make("7"), attributes: { name: "Eve" } });

// The decoded `query.fields` of an endpoint declaring `fields`: its contents
// are a runtime fact, so `Handlers.Projected` makes every attribute optional.
declare const fields: {
  readonly articles?: ReadonlyArray<"title" | "body" | "subtitle">;
  readonly people?: ReadonlyArray<"name" | "email">;
  readonly companies?: ReadonlyArray<"name">;
  readonly tags?: ReadonlyArray<"name">;
  readonly editors?: ReadonlyArray<"name">;
  readonly reviewers?: ReadonlyArray<"name">;
};
const project = Handlers.project(fields);
const projectedArticle = Handlers.data(article, { included: [person], onResource: project });
const projectedArticles = Handlers.collection([article], {
  included: [person],
  onResource: project,
});

// ---------------------------------------------------------------------------
// `fields: true` — the primary data and `included` are partial
// ---------------------------------------------------------------------------

export const get = Endpoint.get(Article, { include: true, fields: true });
export const list = Endpoint.list(Article, { fields: true });

// What a client decodes: every attribute optional, an already-optional one as declared.
assertType<
  Equals<
    AttributesOf<DataOf<typeof get>>,
    { readonly title?: string; readonly body?: string; readonly subtitle?: string }
  >
>(true);
assertType<
  Equals<
    AttributesOf<Extract<IncludedOf<typeof get>, { readonly type: "people" }>>,
    { readonly name?: string; readonly email?: string }
  >
>(true);
// Everything but `attributes` is as declared.
assertType<Equals<DataOf<typeof get>["id"], typeof Article.Type.id>>(true);
assertType<Equals<DataOf<typeof get>["relationships"], typeof Article.Type.relationships>>(true);
assertType<Equals<IncludedOf<typeof get>["type"], "people" | "tags" | "companies">>(true);

// `Handlers.project(query.fields)` fits, with no cast.
assertType<SuccessOf<typeof get>>(projectedArticle);
assertType<SuccessOf<typeof list>>(projectedArticles);

// The issue's pin: without `fields`, the default document requires every
// attribute, so the projected document does not fit.
export const strict = Endpoint.get(Article, { include: true });
// @ts-expect-error -- `Handlers.Projected` makes `title` optional; the strict document requires it
assertType<SuccessOf<typeof strict>>(projectedArticle);
// Positive control: the unprojected document fits.
assertType<SuccessOf<typeof strict>>(Handlers.data(article, { included: [person] }));

// A declared surface: its own members, partial.
const surface = Include.make(Article, { author: Include.nested(Person, { employer: Company }) });
export const surfaced = Endpoint.get(Article, { include: surface, fields: true });
assertType<Equals<IncludedOf<typeof surfaced>["type"], "people" | "companies">>(true);
assertType<
  Equals<
    AttributesOf<Extract<IncludedOf<typeof surfaced>, { readonly type: "people" }>>,
    { readonly name?: string; readonly email?: string }
  >
>(true);

// `related`, to-one and to-many.
export const author = Endpoint.related(Article, "author", { include: true, fields: true });
assertType<
  Equals<
    AttributesOf<Exclude<DataOf<typeof author>, null>>,
    { readonly name?: string; readonly email?: string }
  >
>(true);
assertType<Equals<AttributesOf<IncludedOf<typeof author>>, { readonly name?: string }>>(true);
assertType<SuccessOf<typeof author>>(Handlers.data(person, { onResource: project }));
export const tags = Endpoint.related(Article, "tags", { fields: true });
assertType<Equals<AttributesOf<DataOf<typeof tags>[number]>, { readonly name?: string }>>(true);

// `collection` and `polymorphic`: every member.
export const search = Endpoint.collection([Article, Person], {
  name: "search",
  path: "/search",
  fields: true,
});
assertType<SuccessOf<typeof search>>(Handlers.collection([article], { onResource: project }));
export const node = Endpoint.polymorphic(AnyNode, { fields: true });
assertType<Equals<AttributesOf<DataOf<typeof node>>, { readonly name?: string }>>(true);
assertType<SuccessOf<typeof node>>(Handlers.data(editor, { onResource: project }));

// A type one member reaches only through a paginated relationship (#320):
// `posts.author` is a to-one `people`, `drafts.author` a paginated
// `revisions`, which no include path may cross. `revisions` is no
// `fields[TYPE]` type, so it is neither partial nor an `included` member.
const Revision = Resource.make("revisions", { attributes: { editedAt: Schema.String } });
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
  fields: true,
});
assertType<Equals<IncludedOf<typeof entries>["type"], "people" | "companies">>(true);
assertType<
  Equals<
    AttributesOf<Extract<IncludedOf<typeof entries>, { readonly type: "people" }>>,
    { readonly name?: string; readonly email?: string }
  >
>(true);
assertType<Equals<AttributesOf<DataOf<typeof entries>>, { readonly title?: string }>>(true);

// A family reached as a relationship target is an `included` member as
// itself: its `type` is a family name, so its members stay strict.
const Holder = Resource.make("holders", {
  attributes: { label: Schema.String },
  relationships: { node: Relationship.one(() => AnyNode) },
});
const holder = Holder.make({
  id: Holder.Id.make("1"),
  attributes: { label: "L" },
  relationships: { node: { data: { type: "editors", id: Editor.Id.make("7") } } },
});
export const held = Endpoint.get(Holder, { fields: true });
assertType<Equals<AttributesOf<DataOf<typeof held>>, { readonly label?: string }>>(true);
assertType<
  Equals<
    AttributesOf<Extract<IncludedOf<typeof held>, { readonly type: "editors" }>>,
    { readonly name: string }
  >
>(true);
assertType<SuccessOf<typeof held>>(
  // @ts-expect-error -- a projected family member does not fit its strict schema
  Handlers.data(holder, { included: [editor], onResource: project }),
);
// Positive control: the unprojected member fits.
assertType<SuccessOf<typeof held>>(Handlers.data(holder, { included: [editor] }));

// `Endpoint.resource` / `Group.resource` default `fields` to `true`.
const group = Group.resource(Article);
type GroupEndpoint<Name extends string> = Extract<
  typeof group extends HttpApiGroup.HttpApiGroup<string, infer E, boolean> ? E : never,
  { readonly identifier: Name }
>;
assertType<
  Equals<
    AttributesOf<DataOf<GroupEndpoint<"get">>>,
    { readonly title?: string; readonly body?: string; readonly subtitle?: string }
  >
>(true);
assertType<SuccessOf<GroupEndpoint<"get">>>(projectedArticle);
assertType<SuccessOf<GroupEndpoint<"list">>>(projectedArticles);

// ---------------------------------------------------------------------------
// No `fields` — exactly the document each endpoint had
// ---------------------------------------------------------------------------

type SameSuccess<A, B> = Equals<HttpApiEndpoint.Success<A>, HttpApiEndpoint.Success<B>>;

export const plainGet = Endpoint.get(Article);
export const offGet = Endpoint.get(Article, { fields: false });
export const explicitGet = Endpoint.get(Article, { success: Article.document() });
assertType<SameSuccess<typeof plainGet, typeof explicitGet>>(true);
assertType<SameSuccess<typeof offGet, typeof explicitGet>>(true);
// A strict `success` beside `fields: true` (the first escape hatch is
// `fields: false`, above). With `include` off, the resource's own document is
// exactly the strict default.
export const hatch = Endpoint.get(Article, { fields: true, success: Article.document() });
assertType<SameSuccess<typeof hatch, typeof explicitGet>>(true);
// With `include` on it is not: `Article.document()`'s `included` is only the
// direct targets, so `companies` (`author.employer`) is dropped, and an
// endpoint `meta` override is ignored.
const Total = Schema.Struct({ total: Schema.Number });
export const hatchIncluded = Endpoint.get(Article, {
  include: true,
  fields: true,
  meta: Total,
  success: Article.document(),
});
assertType<Equals<IncludedOf<typeof hatchIncluded>["type"], "people" | "tags">>(true);
assertType<Equals<IncludedOf<typeof strict>["type"], "people" | "tags" | "companies">>(true);
assertType<Equals<NonNullable<SuccessOf<typeof hatchIncluded>["meta"]>, typeof Total.Type>>(false);
// So the override reproduces the union and the `meta` (#342): strict
// attributes, and the document the strict default with `include` would bind.
export const hatchUnion = Endpoint.get(Article, {
  include: true,
  fields: true,
  meta: Total,
  success: Article.document({ included: Schema.Union([Person, Tag, Company]), meta: Total }),
});
export const strictTotal = Endpoint.get(Article, { include: true, meta: Total });
assertType<Equals<SuccessOf<typeof hatchUnion>, SuccessOf<typeof strictTotal>>>(true);
assertType<
  Equals<
    AttributesOf<DataOf<typeof hatchUnion>>,
    { readonly title: string; readonly body: string; readonly subtitle?: string }
  >
>(true);
// Negative control: `fields: true` changes the document.
assertType<SameSuccess<typeof get, typeof strict>>(false);

export const plainList = Endpoint.list(Article, { include: true, sort: true });
export const offList = Endpoint.list(Article, { include: true, sort: true, fields: false });
assertType<SameSuccess<typeof plainList, typeof offList>>(true);
export const explicitList = Endpoint.list(Article, { success: Article.collection() });
export const bareList = Endpoint.list(Article, { fields: false });
assertType<SameSuccess<typeof bareList, typeof explicitList>>(true);
assertType<SameSuccess<typeof plainList, typeof list>>(false);

// `related`, `collection` and `polymorphic` take no `success` override, so
// their strict documents are pinned through what a client decodes. These pins
// stand in for a declaration-emit comparison, which a consumer cannot make
// for an exported endpoint (TS4023, #348).
type StrictPerson = { readonly name: string; readonly email: string };
export const plainAuthor = Endpoint.related(Article, "author");
assertType<Equals<AttributesOf<Exclude<DataOf<typeof plainAuthor>, null>>, StrictPerson>>(true);
assertType<Equals<AttributesOf<IncludedOf<typeof plainAuthor>>, { readonly name: string }>>(true);
export const plainTags = Endpoint.related(Article, "tags", { fields: false });
assertType<Equals<AttributesOf<DataOf<typeof plainTags>[number]>, { readonly name: string }>>(true);
// @ts-expect-error -- a projected `people` resource does not fit the strict document
assertType<SuccessOf<typeof plainAuthor>>(Handlers.data(person, { onResource: project }));

export const plainSearch = Endpoint.collection([Article, Person], {
  name: "search",
  path: "/search",
});
assertType<
  Equals<
    AttributesOf<Extract<DataOf<typeof plainSearch>[number], { readonly type: "people" }>>,
    StrictPerson
  >
>(true);
assertType<SuccessOf<typeof plainSearch>>(
  // @ts-expect-error -- projected members do not fit the strict document
  Handlers.collection([article], { onResource: project }),
);
// Positive control.
assertType<SuccessOf<typeof plainSearch>>(Handlers.collection([article]));

export const plainNode = Endpoint.polymorphic(AnyNode, { fields: false });
assertType<Equals<AttributesOf<DataOf<typeof plainNode>>, { readonly name: string }>>(true);
// @ts-expect-error -- a projected member does not fit the strict document
assertType<SuccessOf<typeof plainNode>>(Handlers.data(editor, { onResource: project }));
assertType<SuccessOf<typeof plainNode>>(Handlers.data(editor));
